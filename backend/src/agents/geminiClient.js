/**
 * Shared AI API client for multi-agent question generation.
 *
 * Supports Gemini, MiniMax, OpenAI, and Anthropic.
 * Automatically resolves Gemini model names and falls back to MiniMax/OpenAI if Google API fails or has no key.
 */

import { config } from '../config.js'

// Map UI model names to actual valid Google Gemini API model identifiers
function resolveGoogleModel(model) {
  if (!model || model.includes('1.5') || model.includes('default') || model === 'gemini-2.0-flash') {
    return 'gemini-3.8-flash'
  }
  return model
}

/**
 * Call MiniMax API (supports Vicharanashala / Samagama gateway or official MiniMax)
 */
async function callMiniMax({ userPrompt, systemInstruction }) {
  const apiKey = config.minimaxApiKey
  if (!apiKey) {
    throw new Error('MiniMax API key not configured. Set MINIMAX_API_KEY in your .env file.')
  }

  const isSamagamaKey = apiKey.startsWith('sk_live_')
  const url = isSamagamaKey
    ? 'https://api.vicharanashala.ai/v1/chat/completions'
    : 'https://api.minimax.io/v1/text/chatcompletion_v2'
  const modelName = isSamagamaKey ? 'minimaxm27' : 'MiniMax-M2.7'

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
    'x-api-key': apiKey
  }

  const messages = []
  if (systemInstruction && systemInstruction.trim().length > 0) {
    messages.push({ role: 'system', content: systemInstruction })
  }
  messages.push({ role: 'user', content: userPrompt })

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 60_000)

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: modelName,
        messages,
        temperature: 0.7,
        max_tokens: 8000
      }),
      signal: controller.signal
    })
    clearTimeout(timeoutId)

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      if (response.status === 502) {
        throw new Error(`Samagama Gateway Error (502 Bad Gateway): The LLM server at api.vicharanashala.ai is currently under maintenance or restarting. Please try again in a few minutes.`)
      }
      throw new Error(`MiniMax API error (${response.status}): ${errText.substring(0, 300)}`)
    }

    const data = await response.json()
    if (data.base_resp && data.base_resp.status_code && data.base_resp.status_code !== 0) {
      throw new Error(`MiniMax API error (${data.base_resp.status_code}): ${data.base_resp.status_msg}`)
    }

    const choice = data.choices?.[0]
    const content = choice?.message?.content || ''
    const reasoning = choice?.message?.reasoning_content || ''
    const text = content || reasoning

    if (!text) {
      throw new Error('MiniMax returned an empty response')
    }

    return text
  } catch (err) {
    clearTimeout(timeoutId)
    if (err.name === 'AbortError') {
      throw new Error('MiniMax API request timed out after 60s')
    }
    throw err
  }
}

/**
 * Call OpenAI API
 */
async function callOpenAI({ userPrompt, systemInstruction }) {
  if (!config.openaiApiKey) {
    throw new Error('OpenAI API key not configured.')
  }

  const messages = []
  if (systemInstruction) messages.push({ role: 'system', content: systemInstruction })
  messages.push({ role: 'user', content: userPrompt })

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.openaiApiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages,
      temperature: 0.7,
      max_tokens: 8000
    })
  })

  if (!response.ok) {
    const errorData = await response.text()
    throw new Error(`OpenAI API error (${response.status}): ${errorData.substring(0, 300)}`)
  }

  const data = await response.json()
  return data.choices?.[0]?.message?.content || ''
}

/**
 * Call Google Gemini API (with candidate model retry on 404)
 */
async function callGoogleGeminiDirect({ userPrompt, systemInstruction, model = 'gemini-2.0-flash' }) {
  if (!config.googleApiKey) {
    throw new Error('Google API key not configured.')
  }

  const apiKeys = config.googleApiKey.split(',').map(k => k.trim()).filter(Boolean);

  let lastError = null

  const primaryModel = resolveGoogleModel(model)
  const candidateModels = [
    primaryModel,
    'gemini-flash-latest',
    'gemini-3.8-flash',
    'gemini-3.5-flash',
    'gemini-2.0-flash',
    'gemini-pro-latest'
  ].filter((m, idx, self) => m && self.indexOf(m) === idx)

  for (const targetModel of candidateModels) {
    for (const currentKey of apiKeys) {
      const isStandardKey = currentKey.startsWith('AIzaSy') || currentKey.startsWith('AQ.');
      if (!isStandardKey) {
        console.warn(`[geminiClient] Warning: GOOGLE_API_KEY format might be incorrect (Key starts with '${currentKey.substring(0, 8)}...').`);
      }

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${currentKey}`

      const body = {
        contents: [{ parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 8000
        }
      }

      if (systemInstruction && systemInstruction.trim().length > 0) {
        body.systemInstruction = {
          parts: [{ text: systemInstruction }]
        }
      }

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 60_000)

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal
        })
        clearTimeout(timeoutId)

        if (!response.ok) {
          const errorData = await response.text().catch(() => '')
          if (response.status === 404) {
            console.warn(`[geminiClient] Model ${targetModel} returned 404 Not Found for key ${currentKey.substring(0, 8)}..., trying next...`)
            lastError = new Error(`Gemini API error (404): ${errorData.substring(0, 300)}`)
            break // 404 means model not found, changing key usually won't help if they are same tier, but we break to next model
          }
          throw new Error(`Gemini API error (${response.status}): ${errorData.substring(0, 500)}`)
        }

        const data = await response.json()
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || ''

        if (!text) {
          const finishReason = data.candidates?.[0]?.finishReason || 'UNKNOWN'
          throw new Error(`Gemini returned empty response (finishReason: ${finishReason})`)
        }

        console.log(`[geminiClient] Successfully generated questions with model: ${targetModel}`)
        return text
      } catch (err) {
        clearTimeout(timeoutId)
        if (err.name === 'AbortError') {
          console.warn(`[geminiClient] Request timed out for key ${currentKey.substring(0, 8)}...`)
          lastError = new Error('Gemini API request timed out after 60s')
          continue // Try next key
        }
        if (err.message && (err.message.includes('503') || err.message.includes('429'))) {
          console.warn(`[geminiClient] Rate limit/High demand on key ${currentKey.substring(0, 8)}... trying next key...`)
          lastError = err
          continue // Try next key
        }
        if (err.message && err.message.includes('404')) {
          // handled above, break inner loop to try next model
          break
        }
        throw err
      }
    }
  }

  const isAnyStandard = apiKeys.some(k => k.startsWith('AIzaSy') || k.startsWith('AQ.'));
  if (!isAnyStandard) {
    throw new Error(`Invalid GOOGLE_API_KEY format. Google AI Studio keys generally start with 'AIzaSy' or 'AQ.'.`)
  }

  throw lastError || new Error('All Gemini model candidates returned 404 Not Found')
}

/**
 * Call Anthropic API
 */
async function callAnthropic({ userPrompt, systemInstruction }) {
  if (!config.anthropicApiKey) {
    throw new Error('Anthropic API key not configured.')
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.anthropicApiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-3-5-haiku-20241022',
      system: systemInstruction || undefined,
      messages: [{ role: 'user', content: userPrompt }],
      max_tokens: 8000,
      temperature: 0.7
    })
  })

  if (!response.ok) {
    const errorData = await response.text()
    throw new Error(`Anthropic API error (${response.status}): ${errorData.substring(0, 300)}`)
  }

  const data = await response.json()
  return data.content?.[0]?.text || ''
}

/**
 * Main export: call AI provider (Gemini with automatic fallback to Anthropic, MiniMax, OpenAI)
 */
export async function callGemini({
  userPrompt,
  systemInstruction = '',
  model = 'gemini-1.5-flash',
  provider = 'auto'
}) {
  if (!userPrompt || userPrompt.trim().length === 0) {
    throw new Error('userPrompt is required')
  }

  // Explicit provider requested
  if (provider === 'minimax') return callMiniMax({ userPrompt, systemInstruction })
  if (provider === 'openai') return callOpenAI({ userPrompt, systemInstruction })
  if (provider === 'anthropic') return callAnthropic({ userPrompt, systemInstruction })
  if (provider === 'google') return callGoogleGeminiDirect({ userPrompt, systemInstruction, model })

  // AUTO mode: systematically try providers in order
  const errors = []
  
  if (config.googleApiKey) {
    try {
      return await callGoogleGeminiDirect({ userPrompt, systemInstruction, model })
    } catch (err) {
      console.warn(`[aiClient] Google API failed: ${err.message}`)
      errors.push(`Google: ${err.message}`)
    }
  }

  if (config.anthropicApiKey) {
    try {
      return await callAnthropic({ userPrompt, systemInstruction })
    } catch (err) {
      console.warn(`[aiClient] Anthropic API failed: ${err.message}`)
      errors.push(`Anthropic: ${err.message}`)
    }
  }

  if (config.minimaxApiKey) {
    try {
      return await callMiniMax({ userPrompt, systemInstruction })
    } catch (err) {
      console.warn(`[aiClient] MiniMax API failed: ${err.message}`)
      errors.push(`MiniMax: ${err.message}`)
    }
  }

  if (config.openaiApiKey) {
    try {
      return await callOpenAI({ userPrompt, systemInstruction })
    } catch (err) {
      console.warn(`[aiClient] OpenAI API failed: ${err.message}`)
      errors.push(`OpenAI: ${err.message}`)
    }
  }

  if (errors.length === 0) {
    throw new Error('No AI provider API keys configured. Please set GOOGLE_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, or MINIMAX_API_KEY in backend/.env')
  }

  throw new Error(`All available AI providers failed:\n` + errors.join('\n'))
}

export default callGemini

