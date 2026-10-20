// Orchestrator tests for multi-agent generation with a stubbed AI call (no network). They guard
// the workflow rules: configured count respected, one type list shared by all agents, a forced
// Paste type override honoured, unique ids under concurrency, and graceful partial failures.
import { generateMultiAgentQuestions, resolveQuestionTypes, retryDelayFor } from '../services/multiAgentService.js'
import agentEvaluator from '../agents/agent_evaluator.js'

const transcript = 'Photosynthesis converts light energy into chemical energy. Chlorophyll absorbs red and blue light. ' +
  'The Calvin cycle fixes carbon dioxide into sugar. Stomata regulate gas exchange in leaves.'

const makeQuestion = (type, n, tag) => type === 'TF'
  ? { type, question: `${tag} statement ${n}?`, options: [{ text: 'True', isCorrect: n % 2 === 0 }, { text: 'False', isCorrect: n % 2 === 1 }], explanation: 'x' }
  : { type, question: `${tag} question ${n} about chlorophyll?`, options: ['red light', 'green light', 'heat', 'sound'].map((t, i) => ({ text: `${t} ${n}`, isCorrect: i === 0 })), explanation: 'x' }

// Reads the requested types from the prompt ("1. MCQ: ...", "2. T/F: ...") and answers them.
const requestedTypes = (prompt) => [...prompt.matchAll(/^\d+\. (MCQ|T\/F|MSQ):/gm)].map(m => (m[1] === 'T/F' ? 'TF' : m[1]))

function makeStub({ extra = 0, failAgent = null, rateLimitAgentOnce = null, timeoutAgentTimes = 0, timeoutAgent = null, evaluatorFails = false, evaluatorFailsOnce = false, latencyMs = 30 } = {}) {
  const state = { inFlight: 0, maxInFlight: 0, calls: [], evaluatorAttempts: 0, rateLimited: 0, timeouts: 0 }
  const callModel = async ({ userPrompt, systemInstruction }) => {
    state.inFlight++
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight)
    try {
      await new Promise(r => setTimeout(r, latencyMs))
      if (systemInstruction === agentEvaluator.systemInstruction) {
        state.calls.push('evaluator')
        if (evaluatorFails) throw new Error('evaluator down')
        if (evaluatorFailsOnce && state.evaluatorAttempts++ === 0) throw new Error('Gemini API error (503): high demand')
        const ids = [...userPrompt.matchAll(/\[(C\d+)\]/g)].map(m => m[1])
        return JSON.stringify({ evaluations: ids.map(id => ({ id, relevance: 4, correctness: 4, answerValidity: 4, clarity: 4, educationalValue: 4, difficultyFit: 4, answerValid: true, grounded: true, evidence: 'Chlorophyll absorbs red and blue light', duplicateOf: null, note: 'ok' })) })
      }
      const tag = /Agent (\d)/.exec(systemInstruction)?.[1]
      state.calls.push(`agent_${tag}`)
      if (failAgent === `agent_${tag}`) throw new Error('boom')
      if (timeoutAgent === `agent_${tag}` && state.timeouts < timeoutAgentTimes) {
        state.timeouts++
        throw new Error('All available AI providers failed:\nGoogle: Gemini API request timed out after 60s')
      }
      if (rateLimitAgentOnce === `agent_${tag}` && state.rateLimited++ === 0) {
        throw new Error('All available AI providers failed:\nGoogle: Gemini API error (429): rate-limited (retry in ~1s)')
      }
      const types = requestedTypes(userPrompt)
      const all = [...types, ...Array(extra).fill(types[0])]
      return JSON.stringify({ questions: all.map((t, n) => makeQuestion(t, n, `A${tag}`)) })
    } finally {
      state.inFlight--
    }
  }
  return { callModel, state }
}

describe('generateMultiAgentQuestions', () => {
  it('respects the configured count even when a model over-produces', async () => {
    const { callModel } = makeStub({ extra: 2 })
    const res = await generateMultiAgentQuestions(transcript, { numQuestions: 3, questionTypeMix: { MCQ: 100, TF: 0, MSQ: 0 } }, { callModel })
    for (const r of Object.values(res.agentResults)) expect(r.questions).toHaveLength(3)
    expect(res.evaluatorResults).toHaveLength(3)
    expect(res.evaluatorResults.every(r => r.status === 'recommended')).toBe(true)
  })

  it('gives every agent the same type list, and honours a forced TF override (Paste flow)', async () => {
    const { callModel } = makeStub()
    const res = await generateMultiAgentQuestions(transcript, { numQuestions: 4, questionTypeMix: { MCQ: 0, TF: 100, MSQ: 0 } }, { callModel })
    for (const r of Object.values(res.agentResults)) {
      expect(r.questions.map(q => q.type)).toEqual(['TF', 'TF', 'TF', 'TF'])
    }
  })

  it('assigns unique, batch-scoped ids across agents', async () => {
    const { callModel } = makeStub()
    const res = await generateMultiAgentQuestions(transcript, { numQuestions: 2 }, { callModel })
    const ids = Object.values(res.agentResults).flatMap(r => r.questions.map(q => q.id))
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every(id => id.startsWith(res.batchId))).toBe(true)
  })

  it('runs generators concurrently by default and calls the evaluator exactly once', async () => {
    // Realistic latency (real calls take seconds) so the 250ms start stagger still overlaps.
    const { callModel, state } = makeStub({ latencyMs: 800 })
    await generateMultiAgentQuestions(transcript, { numQuestions: 2 }, { callModel })
    expect(state.maxInFlight).toBe(3)
    expect(state.calls.filter(c => c === 'evaluator')).toHaveLength(1)
  })

  it('keeps the other agents when one fails', async () => {
    const { callModel } = makeStub({ failAgent: 'agent_3' })
    const res = await generateMultiAgentQuestions(transcript, { numQuestions: 1 }, { callModel })
    expect(res.success).toBe(true)
    expect(res.agentResults.agent_3.error).toBe('boom')
    expect(res.agentResults.agent_1.questions).toHaveLength(1)
    expect(res.evaluatorResults[0].recommendedAgentId).not.toBe('agent_3')
  })

  it('still returns questions when the evaluator fails, with no recommendation', async () => {
    const { callModel } = makeStub({ evaluatorFails: true })
    const res = await generateMultiAgentQuestions(transcript, { numQuestions: 2 }, { callModel })
    expect(res.success).toBe(true)
    expect(res.evaluatorError).toMatch(/evaluator down/)
    expect(res.evaluatorResults.every(r => r.status === 'unavailable' && r.recommendedAgentId === null)).toBe(true)
  })

  it('waits out a per-minute rate limit and still gets the Advanced agent\'s questions', async () => {
    const { callModel, state } = makeStub({ rateLimitAgentOnce: 'agent_3' })
    const res = await generateMultiAgentQuestions(transcript, { numQuestions: 3 }, { callModel })
    expect(state.rateLimited).toBe(2) // failed once, then retried
    expect(res.agentResults.agent_3.error).toBeNull()
    expect(res.agentResults.agent_3.questions).toHaveLength(3)
  })

  it('retries a timed-out Advanced agent once and recovers', async () => {
    const { callModel, state } = makeStub({ timeoutAgent: 'agent_3', timeoutAgentTimes: 1 })
    const res = await generateMultiAgentQuestions(transcript, { numQuestions: 3 }, { callModel })
    expect(state.timeouts).toBe(1)
    expect(res.agentResults.agent_3.questions).toHaveLength(3)
  })

  it('does not retry a timeout more than once', async () => {
    const { callModel, state } = makeStub({ timeoutAgent: 'agent_3', timeoutAgentTimes: 5 })
    const res = await generateMultiAgentQuestions(transcript, { numQuestions: 1 }, { callModel })
    expect(state.timeouts).toBe(2)
    expect(res.agentResults.agent_3.error).toMatch(/timed out/)
    expect(res.agentResults.agent_1.questions).toHaveLength(1)
  })

  it('retries the evaluator once after a transient 503 and still recommends', async () => {
    const { callModel, state } = makeStub({ evaluatorFailsOnce: true })
    const res = await generateMultiAgentQuestions(transcript, { numQuestions: 1 }, { callModel })
    expect(state.calls.filter(c => c === 'evaluator')).toHaveLength(2)
    expect(res.evaluatorError).toBeNull()
    expect(res.evaluatorResults[0].status).toBe('recommended')
  })

  it('reports transcript truncation for very long input', async () => {
    const { callModel } = makeStub()
    const long = Array(8000).fill('chlorophyll').join(' ')
    const res = await generateMultiAgentQuestions(long, { numQuestions: 1 }, { callModel })
    expect(res.transcriptInfo).toEqual({ wordCount: 8000, truncated: true, usedWords: 7500 })
  })
})

describe('retryDelayFor', () => {
  it('waits at least the backoff step, or the provider\'s hinted delay when longer', () => {
    expect(retryDelayFor('Gemini API error (429): rate-limited (retry in ~40s)', 3000)).toBeGreaterThanOrEqual(40000)
    const d = retryDelayFor('503 high demand', 3000)
    expect(d).toBeGreaterThanOrEqual(3000)
    expect(d).toBeLessThan(4000)
  })
})

describe('resolveQuestionTypes', () => {
  it('returns exactly the requested count following the mix', () => {
    const types = resolveQuestionTypes(10, { MCQ: 50, TF: 30, MSQ: 20 })
    expect(types).toHaveLength(10)
    expect(types.filter(t => t === 'MCQ')).toHaveLength(5)
    expect(types.filter(t => t === 'TF')).toHaveLength(3)
    expect(types.filter(t => t === 'MSQ')).toHaveLength(2)
  })
  it('defaults to MCQ without a mix', () => {
    expect(resolveQuestionTypes(3, null)).toEqual(['MCQ', 'MCQ', 'MCQ'])
  })
})
