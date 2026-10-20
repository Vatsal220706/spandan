// geminiClient quota handling, with a stubbed fetch (no network). Reproduces the failure where the
// only working model hit a PER-MINUTE limit while every other model was out of daily quota: that
// must surface as a retryable 429 (with the wait), not as a non-retryable "quota exhausted".

const ok = (text) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }), text: async () => '' })
const err = (status, body) => ({ ok: false, status, text: async () => body, json: async () => JSON.parse(body) })

const perDay = JSON.stringify({ error: { code: 429, message: 'You exceeded your current quota', details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }, { retryDelay: '50s' }] } })
const limitZero = JSON.stringify({ error: { code: 429, message: 'Quota exceeded for metric: x, limit: 0, model: gemini-pro' } })
const perMinute = (s) => JSON.stringify({ error: { code: 429, message: 'You exceeded your current quota', details: [{ violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] }, { retryDelay: `${s}s` }] } })

let callGemini, classifyGemini429
const realFetch = global.fetch

beforeAll(async () => {
  process.env.GOOGLE_API_KEY = 'AIzaSyTESTKEY' // set before config.js loads (dotenv never overrides)
  ;({ callGemini, classifyGemini429 } = await import('../agents/geminiClient.js'))
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

describe('callGemini quota handling (stubbed fetch)', () => {
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
