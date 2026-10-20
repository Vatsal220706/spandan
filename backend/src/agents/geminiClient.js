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

// --- Latency-aware model order + hedged requests -----------------------------------------------
// Gemini models' speed varies hugely with load (the same long prompt took 18s on one model and
// 130s+ on another). Instead of waiting up to the full timeout on a slow model before falling
// back, we (1) try models in order of recently observed latency and (2) if the current attempt
// hasn't answered after GEMINI_HEDGE_AFTER_MS, start the next model in parallel and keep
// whichever answers first (the loser is aborted). At most MAX_IN_FLIGHT attempts run at once.
const geminiLatencyMs = new Map()      // model -> EWMA latency in ms
const UNKNOWN_LATENCY_MS = 20000       // neutral score for a model we haven't timed yet
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 60000
const HEDGE_AFTER_MS = Number(process.env.GEMINI_HEDGE_AFTER_MS) || 20000
const MAX_IN_FLIGHT = 2
// Fallbacks once the full Flash models are out of quota. The offset (larger than any latency
// penalty) keeps them behind all full models in the try order.
const LITE_GEMINI_MODELS = ['gemini-3.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-3.1-flash-lite']
const LITE_RANK_OFFSET_MS = 1_000_000
// Models that rejected thinkingConfig (HTTP 400) — the option is dropped for them.
const thinkingUnsupported = new Set()

function noteLatency(model, ms) {
  const prev = geminiLatencyMs.get(model)
  geminiLatencyMs.set(model, prev == null ? ms : Math.round(prev * 0.5 + ms * 0.5))
}

// Test hook: clear all per-process model state.
export function _resetGeminiClientState() {
  unavailableGeminiModels.clear()
  geminiCooldownUntil.clear()
  geminiLatencyMs.clear()
  thinkingUnsupported.clear()
  for (const k of Object.keys(providerCooldownUntil)) delete providerCooldownUntil[k]
}

/**
 * Call Google Gemini API: latency-ordered models, quota cooldowns, hedged requests.
 * @param {string} [thinking] — 'low' asks thinking models to reason less (faster); ignored by
 *                              models that don't support it.
 */
async function callGoogleGeminiDirect({ userPrompt, systemInstruction, model = 'gemini-2.0-flash', temperature = 0.7, jsonMode = false, thinking = null, stats = null }) {
  if (!config.googleApiKey) {
    throw new Error('Google API key not configured.')
  }

  const apiKeys = config.googleApiKey.split(',').map(k => k.trim()).filter(Boolean)
  const isAnyStandard = apiKeys.some(k => k.startsWith('AIzaSy') || k.startsWith('AQ.'))
  if (!isAnyStandard) {
    console.warn(`[geminiClient] Warning: GOOGLE_API_KEY format might be incorrect (Google AI Studio keys start with 'AIzaSy' or 'AQ.').`)
  }

  const primaryModel = resolveGoogleModel(model)
  const allModels = [
    primaryModel,
    'gemini-flash-latest',
    'gemini-3.8-flash',
    'gemini-3.5-flash',
    'gemini-3-flash-preview',
    // (gemini-2.0-flash removed: retired by Google, it only ever returned 404 and wasted the
    // backup slot when a request was hedged.)
    'gemini-pro-latest',
    // Lite models: separate free quotas, slightly simpler questions — used after the full models.
    ...LITE_GEMINI_MODELS
  ].filter((m, idx, self) => m && self.indexOf(m) === idx)
  // Skip models already known to 404; if that would leave none, probe them all again.
  const knownGood = allModels.filter(m => !unavailableGeminiModels.has(m))
  // Fastest first, but every full Flash model ranks ahead of every Lite model for quality.
  const candidateModels = (knownGood.length > 0 ? knownGood : allModels)
    .map((m, i) => ({ m, i, score: (geminiLatencyMs.get(m) ?? UNKNOWN_LATENCY_MS) + (LITE_GEMINI_MODELS.includes(m) ? LITE_RANK_OFFSET_MS : 0) }))
    .sort((a, b) => a.score - b.score || a.i - b.i)
    .map(x => x.m)

  let lastError = null
  let attempted = 0
  let soonestRetryAt = Infinity       // any cooled-down model
  let soonestRateRetryAt = Infinity   // a model that is only per-minute limited (worth waiting for)
  const noteCooldown = ({ until, kind }) => {
    soonestRetryAt = Math.min(soonestRetryAt, until)
    if (kind === 'rate') soonestRateRetryAt = Math.min(soonestRateRetryAt, until)
  }

  // Build the attempt queue, skipping (key, model) pairs that are cooling down after a 429.
  const queue = []
  for (const targetModel of candidateModels) {
    for (const currentKey of apiKeys) {
      const pair = `${currentKey}|${targetModel}`
      const cd = geminiCooldownUntil.get(pair)
      if (cd && cd.until > Date.now()) { noteCooldown(cd); continue }
      queue.push({ model: targetModel, key: currentKey, pair })
    }
  }

  const buildBody = (targetModel) => {
    const body = {
      contents: [{ parts: [{ text: userPrompt }] }],
      generationConfig: { temperature, maxOutputTokens: 8000 }
    }
    if (jsonMode) body.generationConfig.responseMimeType = 'application/json'
    if (thinking && !thinkingUnsupported.has(targetModel)) {
      body.generationConfig.thinkingConfig = { thinkingLevel: thinking }
    }
    if (systemInstruction && systemInstruction.trim().length > 0) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] }
    }
    return body
  }

  // One request. Resolves with text, or rejects with err.kind:
  // timeout | notfound | quota | busy | thinking | other  (or 'cancelled' when another attempt won).
  const runAttempt = async (t, controller) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${t.model}:generateContent?key=${t.key}`
    const body = buildBody(t.model)
    let timedOut = false
    const timeoutId = setTimeout(() => { timedOut = true; controller.abort() }, GEMINI_TIMEOUT_MS)
    const started = Date.now()
    const fail = (kind, message) => Object.assign(new Error(message), { kind })
    try {
      countRequest(stats)
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      })
      if (!response.ok) {
        const errorData = await response.text().catch(() => '')
        if (response.status === 404) throw fail('notfound', `Gemini API error (404): ${errorData.substring(0, 300)}`)
        if (response.status === 429) {
          const { kind, cooldownMs } = classifyGemini429(errorData)
          const cd = { until: Date.now() + cooldownMs, kind }
          geminiCooldownUntil.set(t.pair, cd)
          noteCooldown(cd)
          console.warn(`[geminiClient] ${t.model} ${kind === 'rate' ? 'per-minute rate-limited' : 'out of quota'} for key ${t.key.substring(0, 8)}...; skipping it for ${Math.round(cooldownMs / 1000)}s`)
          throw fail('quota', `Gemini API error (429): ${errorData.substring(0, 500)}`)
        }
        if (response.status === 400 && body.generationConfig.thinkingConfig && /thinking/i.test(errorData)) {
          throw fail('thinking', `Gemini API error (400): thinkingConfig not supported by ${t.model}`)
        }
        if (response.status === 503) throw fail('busy', `Gemini API error (503): ${errorData.substring(0, 300)}`)
        throw fail('other', `Gemini API error (${response.status}): ${errorData.substring(0, 500)}`)
      }

      const data = await response.json()
      recordUsage(stats, data.usageMetadata?.promptTokenCount, data.usageMetadata?.candidatesTokenCount)
      const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || ''
      if (!text) {
        const finishReason = data.candidates?.[0]?.finishReason || 'UNKNOWN'
        throw fail('other', `Gemini returned empty response (finishReason: ${finishReason})`)
      }
      const elapsed = Date.now() - started
      noteLatency(t.model, elapsed)
      console.log(`[geminiClient] Successfully generated questions with model: ${t.model} in ${(elapsed / 1000).toFixed(1)}s`)
      return text
    } catch (err) {
      if (err.name === 'AbortError') {
        if (!timedOut) throw Object.assign(new Error('cancelled'), { kind: 'cancelled' })
        noteLatency(t.model, GEMINI_TIMEOUT_MS)
        throw Object.assign(new Error(`Gemini API request timed out after ${Math.round(GEMINI_TIMEOUT_MS / 1000)}s`), { kind: 'timeout' })
      }
      if (!err.kind) err.kind = 'other' // network error etc.
      throw err
    } finally {
      clearTimeout(timeoutId)
    }
  }

  const finalError = () => {
    // A model is only per-minute limited and frees up soon: report a RETRYABLE 429 with the wait,
    // so the orchestrator sleeps that long and retries instead of failing the agent.
    const rateWaitMs = soonestRateRetryAt - Date.now()
    if (soonestRateRetryAt !== Infinity && rateWaitMs <= RETRYABLE_WAIT_MS) {
      return new Error(`Gemini API error (429): rate-limited (retry in ~${Math.max(1, Math.ceil(rateWaitMs / 1000))}s)`)
    }
    // Every model is out of quota (daily limit / not available on this tier): fail fast without
    // spending requests, and without a 429 so the caller doesn't sit through pointless retries.
    if (attempted === 0 && soonestRetryAt !== Infinity) {
      const waitS = Math.ceil((soonestRetryAt - Date.now()) / 1000)
      return new Error(`Gemini quota exhausted on all models for this key (next retry in ~${waitS}s)`)
    }
    if (!isAnyStandard) {
      return new Error(`Invalid GOOGLE_API_KEY format. Google AI Studio keys generally start with 'AIzaSy' or 'AQ.'.`)
    }
    return lastError || new Error('All Gemini model candidates returned 404 Not Found')
  }

  return new Promise((resolve, reject) => {
    let inFlight = 0
    let settled = false
    let hedgeTimer = null
    const controllers = new Set()

    const finish = (fn) => {
      if (settled) return
      settled = true
      clearTimeout(hedgeTimer)
      for (const c of controllers) c.abort() // cancel the slower attempt
      fn()
    }

    const launchNext = () => {
      if (settled) return
      clearTimeout(hedgeTimer)
      if (queue.length === 0) {
        if (inFlight === 0) finish(() => reject(finalError()))
        return
      }
      if (inFlight >= MAX_IN_FLIGHT) return
      const t = queue.shift()
      inFlight++
      attempted++
      const controller = new AbortController()
      controllers.add(controller)

      runAttempt(t, controller)
        .then(text => finish(() => resolve(text)))
        .catch(err => {
          controllers.delete(controller)
          inFlight--
          if (settled || err.kind === 'cancelled') return
          lastError = err
          if (err.kind === 'notfound') {
            console.warn(`[geminiClient] Model ${t.model} returned 404 Not Found, trying next...`)
            unavailableGeminiModels.add(t.model)
            // Same model on other keys won't exist either.
            for (let i = queue.length - 1; i >= 0; i--) if (queue[i].model === t.model) queue.splice(i, 1)
          } else if (err.kind === 'thinking') {
            thinkingUnsupported.add(t.model)
            queue.unshift(t) // retry the same model without thinkingConfig
          } else if (err.kind === 'busy') {
            noteLatency(t.model, GEMINI_TIMEOUT_MS / 2) // high demand — deprioritize for a while
            console.warn(`[geminiClient] ${t.model} is busy (503), trying next...`)
          } else if (err.kind === 'timeout') {
            console.warn(`[geminiClient] ${t.model} timed out, trying next...`)
          } else if (err.kind === 'other') {
            console.warn(`[geminiClient] ${t.model} failed: ${err.message.slice(0, 160)}`)
          }
          launchNext()
        })

      // Still waiting after HEDGE_AFTER_MS? Start a backup attempt on the next model.
      if (queue.length > 0) {
        hedgeTimer = setTimeout(() => {
          if (!settled && queue.length > 0) {
            console.log(`[geminiClient] ${t.model} slow (>${Math.round(HEDGE_AFTER_MS / 1000)}s); starting backup on ${queue[0].model}`)
            launchNext()
          }
        }, HEDGE_AFTER_MS)
      }
    }

    launchNext()
  })
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
 *   thinking    — 'low' asks Gemini thinking models to reason less (faster); others ignore it
 *   stats       — object that accumulates { requests, inputTokens, outputTokens } for measurement
 */
export async function callGemini({
  userPrompt,
  systemInstruction = '',
  model = 'gemini-1.5-flash',
  provider = 'auto',
  temperature = 0.7,
  jsonMode = false,
  thinking = null,
  stats = null
}) {
  if (!userPrompt || userPrompt.trim().length === 0) {
    throw new Error('userPrompt is required')
  }
  const opts = { userPrompt, systemInstruction, temperature, jsonMode, thinking, stats }

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

