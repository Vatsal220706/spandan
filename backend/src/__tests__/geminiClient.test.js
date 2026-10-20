// geminiClient quota handling, with a stubbed fetch (no network). Reproduces the failure where the
// only working model hit a PER-MINUTE limit while every other model was out of daily quota: that
// must surface as a retryable 429 (with the wait), not as a non-retryable "quota exhausted".

const ok = (text) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }), text: async () => '' })
const err = (status, body) => ({ ok: false, status, text: async () => body, json: async () => JSON.parse(body) })

const perDay = JSON.stringify({ error: { code: 429, message: 'You exceeded your current quota', details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }, { retryDelay: '50s' }] } })
const limitZero = JSON.stringify({ error: { code: 429, message: 'Quota exceeded for metric: x, limit: 0, model: gemini-pro' } })
const perMinute = (s) => JSON.stringify({ error: { code: 429, message: 'You exceeded your current quota', details: [{ violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] }, { retryDelay: `${s}s` }] } })

let callGemini, classifyGemini429, resetState
const realFetch = global.fetch

beforeAll(async () => {
  process.env.GOOGLE_API_KEY = 'AIzaSyTESTKEY' // set before config.js loads (dotenv never overrides)
  process.env.GEMINI_HEDGE_AFTER_MS = '200'      // fast hedging for tests
  process.env.GEMINI_TIMEOUT_MS = '3000'
  ;({ callGemini, classifyGemini429, _resetGeminiClientState: resetState } = await import('../agents/geminiClient.js'))
})
afterAll(() => { global.fetch = realFetch })

const modelOf = (url) => /models\/([^:]+):/.exec(url)[1]

describe('classifyGemini429', () => {
  it('separates never-available, daily-exhausted and per-minute limits', () => {
    expect(classifyGemini429(limitZero).kind).toBe('unavailable')
    expect(classifyGemini429(perDay).kind).toBe('daily')
    const rate = classifyGemini429(perMinute(40))
    expect(rate.kind).toBe('rate')
    expect(rate.cooldownMs).toBe(40000)
  })
})

// fetch stub whose per-model latency/response is scripted and which honours AbortSignal.
const scriptedFetch = (script, log) => async (url, { signal, body }) => {
  const m = modelOf(url)
  log.push({ model: m, body: JSON.parse(body) })
  const { delay = 0, respond } = script(m, JSON.parse(body))
  await new Promise((resolve, reject) => {
    const t = setTimeout(resolve, delay)
    signal.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) })
  })
  return respond()
}

describe('callGemini hedging and latency ordering (stubbed fetch)', () => {
  beforeEach(() => resetState())

  it('starts a backup on the next model when the first is slow, and keeps the faster answer', async () => {
    const log = []
    global.fetch = scriptedFetch((m) => m === 'gemini-3.8-flash'
      ? { delay: 2500, respond: () => ok('slow') }
      : { delay: 50, respond: () => ok(`fast:${m}`) }, log)
    const t0 = Date.now()
    const text = await callGemini({ userPrompt: 'q', provider: 'google' })
    expect(text).toBe('fast:gemini-flash-latest')
    expect(Date.now() - t0).toBeLessThan(1500) // didn't wait for the slow model
    expect(log.map(l => l.model)).toEqual(['gemini-3.8-flash', 'gemini-flash-latest'])
  })

  it('tries the model that answered fastest first on the next call', async () => {
    const log = []
    global.fetch = scriptedFetch((m) => m === 'gemini-3.8-flash'
      ? { delay: 2500, respond: () => ok('slow') }
      : { delay: 50, respond: () => ok(`fast:${m}`) }, log)
    await callGemini({ userPrompt: 'q', provider: 'google' })
    log.length = 0
    await callGemini({ userPrompt: 'q', provider: 'google' })
    expect(log[0].model).toBe('gemini-flash-latest')
  })

  it('moves straight on after a 503 instead of waiting', async () => {
    const log = []
    global.fetch = scriptedFetch((m) => m === 'gemini-3.8-flash'
      ? { delay: 10, respond: () => err(503, '{"error":{"message":"high demand"}}') }
      : { delay: 10, respond: () => ok(`ok:${m}`) }, log)
    await expect(callGemini({ userPrompt: 'q', provider: 'google' })).resolves.toBe('ok:gemini-flash-latest')
  })

  it('falls back to gemini-3-flash-preview, then Lite models, once the main models are out of quota', async () => {
    const log = []
    const full = ['gemini-3.8-flash', 'gemini-flash-latest', 'gemini-3.5-flash', 'gemini-pro-latest']
    global.fetch = scriptedFetch((m) => ({
      respond: () => full.includes(m) ? err(429, perDay)
        : m === 'gemini-2.0-flash' ? err(404, '{"error":{"message":"gone"}}')
        : m === 'gemini-3-flash-preview' ? err(503, '{"error":{"message":"high demand"}}')
        : ok(`ok:${m}`)
    }), log)
    await expect(callGemini({ userPrompt: 'q', provider: 'google' })).resolves.toBe('ok:gemini-3.5-flash-lite')
    const order = log.map(l => l.model)
    expect(order.indexOf('gemini-3-flash-preview')).toBeLessThan(order.indexOf('gemini-3.5-flash-lite'))
  })

  it('keeps Lite models behind full Flash models even when a Lite model answered faster', async () => {
    const log = []
    // First call: only a Lite model works, and it is fast.
    global.fetch = scriptedFetch((m) => ({
      delay: 10,
      respond: () => m.includes('lite') ? ok('lite') : err(503, '{"error":{"message":"high demand"}}')
    }), log)
    await callGemini({ userPrompt: 'q', provider: 'google' })
    // Second call: full models work again — one must be tried before any Lite model.
    log.length = 0
    global.fetch = scriptedFetch(() => ({ delay: 10, respond: () => ok('ok') }), log)
    await callGemini({ userPrompt: 'q', provider: 'google' })
    expect(log[0].model.includes('lite')).toBe(false)
  })

  it('drops thinkingConfig for a model that rejects it and retries that model', async () => {
    const log = []
    global.fetch = scriptedFetch((m, body) => ({
      respond: () => body.generationConfig.thinkingConfig
        ? err(400, '{"error":{"message":"Unknown name \\"thinkingConfig\\""}}')
        : ok('ok')
    }), log)
    await expect(callGemini({ userPrompt: 'q', provider: 'google', thinking: 'low' })).resolves.toBe('ok')
    expect(log.map(l => [l.model, !!l.body.generationConfig.thinkingConfig])).toEqual([
      ['gemini-3.8-flash', true],
      ['gemini-3.8-flash', false]
    ])
  })
})

describe('callGemini quota handling (stubbed fetch)', () => {
  beforeAll(() => resetState())

  it('turns a per-minute limit on the only live model into a retryable 429, skips dead models, then recovers', async () => {
    const calls = []
    let flashState = 'rate'
    global.fetch = async (url) => {
      const m = modelOf(url)
      calls.push(m)
      if (m === 'gemini-3.5-flash') return flashState === 'rate' ? err(429, perMinute(1)) : ok('{"questions":[]}')
      if (m === 'gemini-2.0-flash') return err(404, '{"error":{"message":"gone"}}')
      if (m === 'gemini-pro-latest') return err(429, limitZero)
      return err(429, perDay) // 3.8-flash, flash-latest
    }

    // 1st call: every model fails; the per-minute one must make the error retryable with its wait.
    await expect(callGemini({ userPrompt: 'q', provider: 'google' })).rejects.toThrow(/429.*retry in ~1s/)

    // 2nd call right away: no requests are wasted on cooled-down models, still retryable.
    calls.length = 0
    await expect(callGemini({ userPrompt: 'q', provider: 'google' })).rejects.toThrow(/429.*retry in ~\d+s/)
    expect(calls).toEqual([])

    // After the per-minute window passes, the live model is tried again (and only it).
    await new Promise(r => setTimeout(r, 1100))
    flashState = 'ok'
    calls.length = 0
    await expect(callGemini({ userPrompt: 'q', provider: 'google' })).resolves.toBe('{"questions":[]}')
    expect(calls).toEqual(['gemini-3.5-flash'])
  })
})
