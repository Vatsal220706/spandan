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

// Gemini model names that returned 404 in this process — skipped on later calls so every request
// doesn't re-probe models that don't exist for this key (each probe is a wasted round-trip).
const unavailableGeminiModels = new Set()

// Per (key, model) cooldown after a 429, so later calls don't re-hit exhausted models before
// reaching a working one (one Generate Q was making ~40 requests). Three kinds of 429:
//   unavailable — free-tier "limit: 0": never usable on this key → skip for the cooldown cap
//   daily       — a per-day quota is used up → skip; retrying within this request can't help
//   rate        — a per-minute limit (e.g. several agents hitting the model at once) → skip only
//                 for its retryDelay, and keep the error RETRYABLE so the orchestrator waits and
//                 retries instead of failing that agent outright.
const geminiCooldownUntil = new Map()
const MAX_COOLDOWN_MS = 10 * 60 * 1000
const DEFAULT_COOLDOWN_MS = 60 * 1000
// The longest wait the orchestrator should still sit through for a per-minute limit.
export const RETRYABLE_WAIT_MS = 65 * 1000
// The model that last succeeded is tried first.
let lastGoodGeminiModel = null

function parseRetryDelayMs(errorText) {
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(errorText || '')
  return m ? Math.ceil(Number(m[1]) * 1000) : null
}

export function classifyGemini429(errorText) {
  const text = errorText || ''
  if (/limit:\s*0\b/.test(text)) return { kind: 'unavailable', cooldownMs: MAX_COOLDOWN_MS }
  const retryMs = parseRetryDelayMs(text)
  if (/PerDay/i.test(text)) return { kind: 'daily', cooldownMs: Math.min(MAX_COOLDOWN_MS, Math.max(retryMs || 0, DEFAULT_COOLDOWN_MS)) }
  return { kind: 'rate', cooldownMs: Math.min(MAX_COOLDOWN_MS, retryMs || DEFAULT_COOLDOWN_MS) }
}

// Providers that failed with a non-transient account error (no credits / invalid key) are skipped
// in auto mode for a while instead of being called — and failing — on every request.
const providerCooldownUntil = {}
const PROVIDER_COOLDOWN_MS = 10 * 60 * 1000
const isAccountError = (msg) =>
  /insufficient_quota|credit_balance_exhausted|invalid_api_key|incorrect api key|\(401\)|\(403\)/i.test(msg || '')

// Optional per-run usage accounting (request count + tokens when the provider reports them).
function countRequest(stats) {
  if (stats) stats.requests = (stats.requests || 0) + 1
}
function recordUsage(stats, inputTokens, outputTokens) {
  if (!stats) return
  if (Number.isFinite(inputTokens)) stats.inputTokens = (stats.inputTokens || 0) + inputTokens
  if (Number.isFinite(outputTokens)) stats.outputTokens = (stats.outputTokens || 0) + outputTokens
}

/**
 * Call MiniMax API (supports Vicharanashala / Samagama gateway or official MiniMax)
 */
async function callMiniMax({ userPrompt, systemInstruction, temperature = 0.7, stats = null }) {
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
    countRequest(stats)
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: modelName,
        messages,
        temperature,
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

    recordUsage(stats, data.usage?.prompt_tokens, data.usage?.completion_tokens)
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
async function callOpenAI({ userPrompt, systemInstruction, temperature = 0.7, jsonMode = false, stats = null }) {
  if (!config.openaiApiKey) {
    throw new Error('OpenAI API key not configured.')
  }

  const messages = []
  if (systemInstruction) messages.push({ role: 'system', content: systemInstruction })
  messages.push({ role: 'user', content: userPrompt })

  const body = {
    model: 'gpt-4o-mini',
    messages,
    temperature,
    max_tokens: 8000
  }
  if (jsonMode) body.response_format = { type: 'json_object' }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 60_000)

  try {
    countRequest(stats)
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.openaiApiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    })
    clearTimeout(timeoutId)

    if (!response.ok) {
      const errorData = await response.text()
      throw new Error(`OpenAI API error (${response.status}): ${errorData.substring(0, 300)}`)
    }

    const data = await response.json()
    recordUsage(stats, data.usage?.prompt_tokens, data.usage?.completion_tokens)
    return data.choices?.[0]?.message?.content || ''
  } catch (err) {
    clearTimeout(timeoutId)
    if (err.name === 'AbortError') {
      throw new Error('OpenAI API request timed out after 60s')
    }
    throw err
  }
}

/**
 * Call Google Gemini API (with candidate model retry on 404)
 */
async function callGoogleGeminiDirect({ userPrompt, systemInstruction, model = 'gemini-2.0-flash', temperature = 0.7, jsonMode = false, stats = null }) {
  if (!config.googleApiKey) {
    throw new Error('Google API key not configured.')
  }

  const apiKeys = config.googleApiKey.split(',').map(k => k.trim()).filter(Boolean);

  let lastError = null

  const primaryModel = resolveGoogleModel(model)
  const allModels = [
    primaryModel,
    'gemini-flash-latest',
    'gemini-3.8-flash',
    'gemini-3.5-flash',
    'gemini-2.0-flash',
    'gemini-pro-latest'
  ].filter((m, idx, self) => m && self.indexOf(m) === idx)
  // Skip models already known to 404; if that would leave none, probe them all again.
  const knownGood = allModels.filter(m => !unavailableGeminiModels.has(m))
  const candidateModels = knownGood.length > 0 ? knownGood : allModels
  if (lastGoodGeminiModel && candidateModels.includes(lastGoodGeminiModel)) {
    candidateModels.splice(candidateModels.indexOf(lastGoodGeminiModel), 1)
    candidateModels.unshift(lastGoodGeminiModel)
  }

  let attempted = 0
  let soonestRetryAt = Infinity       // any cooled-down model
  let soonestRateRetryAt = Infinity   // a model that is only per-minute limited (worth waiting for)
  const noteCooldown = ({ until, kind }) => {
    soonestRetryAt = Math.min(soonestRetryAt, until)
    if (kind === 'rate') soonestRateRetryAt = Math.min(soonestRateRetryAt, until)
  }

  for (const targetModel of candidateModels) {
    for (const currentKey of apiKeys) {
      const pair = `${currentKey}|${targetModel}`
      const cd = geminiCooldownUntil.get(pair)
      if (cd && cd.until > Date.now()) {
        noteCooldown(cd)
        continue // this model is out of quota on this key — don't spend a request on it
      }
      attempted++

      const isStandardKey = currentKey.startsWith('AIzaSy') || currentKey.startsWith('AQ.');
      if (!isStandardKey) {
        console.warn(`[geminiClient] Warning: GOOGLE_API_KEY format might be incorrect (Key starts with '${currentKey.substring(0, 8)}...').`);
      }

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${currentKey}`

      const body = {
        contents: [{ parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature,
          maxOutputTokens: 8000
        }
      }
      if (jsonMode) body.generationConfig.responseMimeType = 'application/json'

      if (systemInstruction && systemInstruction.trim().length > 0) {
        body.systemInstruction = {
          parts: [{ text: systemInstruction }]
        }
      }

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 60_000)

      try {
        countRequest(stats)
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
            unavailableGeminiModels.add(targetModel)
            break // 404 means model not found, changing key usually won't help if they are same tier, but we break to next model
          }
          if (response.status === 429) {
            const { kind, cooldownMs } = classifyGemini429(errorData)
            const cd = { until: Date.now() + cooldownMs, kind }
            geminiCooldownUntil.set(pair, cd)
            noteCooldown(cd)
            console.warn(`[geminiClient] ${targetModel} ${kind === 'rate' ? 'per-minute rate-limited' : 'out of quota'} for key ${currentKey.substring(0, 8)}...; skipping it for ${Math.round(cooldownMs / 1000)}s`)
          }
          throw new Error(`Gemini API error (${response.status}): ${errorData.substring(0, 500)}`)
        }

        const data = await response.json()
        recordUsage(stats, data.usageMetadata?.promptTokenCount, data.usageMetadata?.candidatesTokenCount)
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || ''

        if (!text) {
          const finishReason = data.candidates?.[0]?.finishReason || 'UNKNOWN'
          throw new Error(`Gemini returned empty response (finishReason: ${finishReason})`)
        }

        console.log(`[geminiClient] Successfully generated questions with model: ${targetModel}`)
        lastGoodGeminiModel = targetModel
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

  // A model is only per-minute limited and frees up soon: report a RETRYABLE 429 with the wait,
  // so the orchestrator sleeps that long and retries instead of failing the agent.
  const rateWaitMs = soonestRateRetryAt - Date.now()
  if (soonestRateRetryAt !== Infinity && rateWaitMs <= RETRYABLE_WAIT_MS) {
    throw new Error(`Gemini API error (429): rate-limited (retry in ~${Math.max(1, Math.ceil(rateWaitMs / 1000))}s)`)
  }

  // Every model is out of quota (daily limit / not available on this tier): fail fast without
  // spending requests, and without a 429 so the caller doesn't sit through pointless retries.
  if (attempted === 0 && soonestRetryAt !== Infinity) {
    const waitS = Math.ceil((soonestRetryAt - Date.now()) / 1000)
    throw new Error(`Gemini quota exhausted on all models for this key (next retry in ~${waitS}s)`)
  }

  throw lastError || new Error('All Gemini model candidates returned 404 Not Found')
}

/**
 * Call Anthropic API
 */
async function callAnthropic({ userPrompt, systemInstruction, temperature = 0.7, stats = null }) {
  if (!config.anthropicApiKey) {
    throw new Error('Anthropic API key not configured.')
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 60_000)

  try {
    countRequest(stats)
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
        temperature
      }),
      signal: controller.signal
    })
    clearTimeout(timeoutId)

    if (!response.ok) {
      const errorData = await response.text()
      throw new Error(`Anthropic API error (${response.status}): ${errorData.substring(0, 300)}`)
    }

    const data = await response.json()
    recordUsage(stats, data.usage?.input_tokens, data.usage?.output_tokens)
    return data.content?.[0]?.text || ''
  } catch (err) {
    clearTimeout(timeoutId)
    if (err.name === 'AbortError') {
      throw new Error('Anthropic API request timed out after 60s')
    }
    throw err
  }
}

/**
 * Main export: call AI provider (Gemini with automatic fallback to Anthropic, MiniMax, OpenAI)
 *
 * Optional, backward-compatible extras:
 *   temperature — defaults to 0.7 (unchanged); the evaluator uses a low value for consistency
 *   jsonMode    — ask providers that support it (Gemini, OpenAI) for a JSON-only response
 *   stats       — object that accumulates { requests, inputTokens, outputTokens } for measurement
 */
export async function callGemini({
  userPrompt,
  systemInstruction = '',
  model = 'gemini-1.5-flash',
  provider = 'auto',
  temperature = 0.7,
  jsonMode = false,
  stats = null
}) {
  if (!userPrompt || userPrompt.trim().length === 0) {
    throw new Error('userPrompt is required')
  }
  const opts = { userPrompt, systemInstruction, temperature, jsonMode, stats }

  // Explicit provider requested
  if (provider === 'minimax') return callMiniMax(opts)
  if (provider === 'openai') return callOpenAI(opts)
  if (provider === 'anthropic') return callAnthropic(opts)
  if (provider === 'google') return callGoogleGeminiDirect({ ...opts, model })

  // AUTO mode: systematically try providers in order
  const errors = []
  const chain = [
    ['Google', config.googleApiKey, () => callGoogleGeminiDirect({ ...opts, model })],
    ['Anthropic', config.anthropicApiKey, () => callAnthropic(opts)],
    ['MiniMax', config.minimaxApiKey, () => callMiniMax(opts)],
    ['OpenAI', config.openaiApiKey, () => callOpenAI(opts)]
  ]

  for (const [name, key, call] of chain) {
    if (!key) continue
    const until = providerCooldownUntil[name] || 0
    if (until > Date.now()) {
      // Deliberately worded without a status code so it never triggers a rate-limit retry.
      errors.push(`${name}: skipped — account error earlier (no credits or invalid key); retrying in ~${Math.ceil((until - Date.now()) / 60000)} min`)
      continue
    }
    try {
      return await call()
    } catch (err) {
      console.warn(`[aiClient] ${name} API failed: ${err.message}`)
      if (isAccountError(err.message)) {
        providerCooldownUntil[name] = Date.now() + PROVIDER_COOLDOWN_MS
        console.warn(`[aiClient] ${name} has an account error; skipping it for ${PROVIDER_COOLDOWN_MS / 60000} min`)
        errors.push(`${name}: account error (no credits or invalid key) — ${err.message.slice(0, 200).replace(/\(\d{3}\)|\b(429|503)\b|UNAVAILABLE|high demand/g, '')}`)
      } else {
        errors.push(`${name}: ${err.message}`)
      }
    }
  }

  if (errors.length === 0) {
    throw new Error('No AI provider API keys configured. Please set GOOGLE_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, or MINIMAX_API_KEY in backend/.env')
  }

  throw new Error(`All available AI providers failed:\n` + errors.join('\n'))
}

export default callGemini

