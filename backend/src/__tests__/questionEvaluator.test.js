// Unit tests for Agent 4 (questionEvaluator). The model call is a stub, so no network is used.
// These guard the core guarantees: recommendations follow quality (never agent level), the
// configured count is respected, invalid/poor candidates are not blindly recommended, and an
// evaluator failure never silently falls back to a particular agent.
import {
  checkStructure,
  buildCandidates,
  buildEvaluationPrompt,
  parseEvaluation,
  evidenceInTranscript,
  evaluateCandidates,
  buildEvaluationContext,
  similarity
} from '../services/questionEvaluator.js'

const transcript = 'Photosynthesis converts light energy into chemical energy. Chlorophyll absorbs mostly red and blue light. ' +
  'The Calvin cycle fixes carbon dioxide into sugar. Stomata regulate gas exchange and water loss in leaves.'

const mcq = (question, correctIdx = 0) => ({
  id: question,
  type: 'MCQ',
  question,
  options: ['Alpha choice', 'Beta choice', 'Gamma choice', 'Delta choice'].map((t, i) => ({ text: `${t} ${question.length}`, isCorrect: i === correctIdx })),
  explanation: 'because'
})

const agent = (agentId, questions, extra = {}) => ({
  agentId, label: agentId, color: '#000', icon: '*', efficiencyLevel: 0, questions, error: null, ...extra
})

const good = { relevance: 5, correctness: 5, answerValidity: 5, clarity: 5, educationalValue: 5, difficultyFit: 5, answerValid: true, grounded: true, evidence: 'Chlorophyll absorbs mostly red and blue light', duplicateOf: null, note: 'Strong.' }
const ok = { ...good, relevance: 4, correctness: 4, answerValidity: 4, clarity: 4, educationalValue: 4, difficultyFit: 4, note: 'Fine.' }
const bad = { ...good, answerValid: false, note: 'Wrong key.' }

// Stub model: maps each anonymous id back to its question text and returns the scripted evaluation.
const stubModel = (byQuestion) => async (prompt) => {
  const evaluations = []
  const re = /\[(C\d+)\][^\n]*\nQ: ([^\n]*)/g
  let m
  while ((m = re.exec(prompt)) !== null) {
    const scripted = byQuestion[m[2]]
    if (scripted) evaluations.push({ id: m[1], ...scripted })
  }
  return '```json\n' + JSON.stringify({ evaluations }) + '\n```'
}

describe('checkStructure', () => {
  it('accepts a well-formed MCQ', () => {
    expect(checkStructure(mcq('What does chlorophyll absorb?'), 'MCQ')).toEqual([])
  })

  it('flags parser placeholder options and wrong correct counts', () => {
    const placeholder = { type: 'MCQ', question: 'X?', options: ['Option A', 'Option B', 'Option C', 'Option D'].map((t, i) => ({ text: t, isCorrect: i === 0 })) }
    expect(checkStructure(placeholder, 'MCQ')).toContain('placeholder_options')
    const twoCorrect = { ...mcq('Q?'), options: mcq('Q?').options.map(o => ({ ...o, isCorrect: true })) }
    expect(checkStructure(twoCorrect, 'MCQ')).toContain('multiple_correct_options')
    const msq = { type: 'MSQ', question: 'Q?', options: mcq('Q?').options }
    expect(checkStructure(msq, 'MSQ')).toContain('too_few_correct_options')
  })

  it('flags a type that does not match the requested slot type', () => {
    expect(checkStructure(mcq('Q?'), 'TF')).toContain('type_mismatch')
  })
})

describe('buildEvaluationPrompt', () => {
  it('anonymizes agents and does not leak agent labels or ids', () => {
    const results = { agent_3: agent('agent_3', [mcq('Advanced question?')], { label: 'Advanced' }) }
    const { prompt } = buildEvaluationPrompt(buildCandidates(results, ['MCQ']), transcript)
    expect(prompt).toContain('[C1]')
    expect(prompt).toContain('targetLevel=advanced')
    expect(prompt).not.toContain('agent_3')
    expect(prompt).not.toContain('Advanced,')
    expect(prompt).toContain(transcript) // full text, not a 1,500-char excerpt
  })

  it('skips structurally invalid candidates', () => {
    const broken = { type: 'MCQ', question: 'Broken?', options: [{ text: 'Option A', isCorrect: true }, { text: 'Option B', isCorrect: false }, { text: 'Option C', isCorrect: false }, { text: 'Option D', isCorrect: false }] }
    const results = { agent_1: agent('agent_1', [broken]) }
    expect(buildEvaluationPrompt(buildCandidates(results, ['MCQ']), transcript).prompt).toBeNull()
  })
})

describe('parseEvaluation', () => {
  it('parses fenced JSON with trailing commas', () => {
    expect(parseEvaluation('```json\n{"evaluations":[{"id":"C1",},]}\n```')).toEqual([{ id: 'C1' }])
  })
  it('returns null on garbage', () => {
    expect(parseEvaluation('no json here')).toBeNull()
  })
})

describe('evidenceInTranscript', () => {
  it('matches verbatim or lightly paraphrased quotes and rejects invented ones', () => {
    expect(evidenceInTranscript('chlorophyll absorbs mostly red and blue light', transcript)).toBe(true)
    expect(evidenceInTranscript('Chlorophyll absorbs mostly red, blue light!', transcript)).toBe(true)
    expect(evidenceInTranscript('Mitochondria produce ATP via oxidative phosphorylation', transcript)).toBe(false)
    expect(evidenceInTranscript('', transcript)).toBe(false)
  })
})

describe('evaluateCandidates — quality over difficulty', () => {
  const run = (byQuestion, results, types = ['MCQ']) =>
    evaluateCandidates({ agentResults: results, questionTypes: types, transcript, callModel: stubModel(byQuestion) })

  const threeAgents = (b, i, a) => ({
    agent_1: agent('agent_1', [mcq(b)]),
    agent_2: agent('agent_2', [mcq(i)]),
    agent_3: agent('agent_3', [mcq(a)])
  })

  it.each([
    ['agent_1', { 'Basic Q?': good, 'Inter Q?': ok, 'Adv Q?': ok }],
    ['agent_2', { 'Basic Q?': ok, 'Inter Q?': good, 'Adv Q?': ok }],
    ['agent_3', { 'Basic Q?': ok, 'Inter Q?': ok, 'Adv Q?': good }]
  ])('recommends %s when its question is strongest', async (winner, scores) => {
    const { results } = await run(scores, threeAgents('Basic Q?', 'Inter Q?', 'Adv Q?'))
    expect(results[0].status).toBe('recommended')
    expect(results[0].recommendedAgentId).toBe(winner)
  })

  it('prefers a correct Basic question over an Advanced one with a wrong answer key', async () => {
    const { results } = await run({ 'Basic Q?': ok, 'Inter Q?': bad, 'Adv Q?': bad }, threeAgents('Basic Q?', 'Inter Q?', 'Adv Q?'))
    expect(results[0].recommendedAgentId).toBe('agent_1')
    const adv = results[0].candidates.find(c => c.agentId === 'agent_3')
    expect(adv.verdict).toBe('rejected')
    expect(adv.flags).toContain('invalid_answer')
  })

  it('returns no_good_candidate instead of blindly recommending when all are poor', async () => {
    const { results } = await run({ 'Basic Q?': bad, 'Inter Q?': bad, 'Adv Q?': { ...good, grounded: false } }, threeAgents('Basic Q?', 'Inter Q?', 'Adv Q?'))
    expect(results[0].status).toBe('no_good_candidate')
    expect(results[0].recommendedAgentId).toBeNull()
  })

  it('evaluates even a lone candidate instead of auto-recommending it', async () => {
    const { results } = await run({ 'Lone Q?': bad }, { agent_2: agent('agent_2', [mcq('Lone Q?')]) })
    expect(results[0].status).toBe('no_good_candidate')
  })

  it('marks every slot unavailable (no Advanced fallback) when the evaluator fails', async () => {
    const { results, meta } = await evaluateCandidates({
      agentResults: threeAgents('Basic Q?', 'Inter Q?', 'Adv Q?'),
      questionTypes: ['MCQ'],
      transcript,
      callModel: async () => { throw new Error('429 rate limited') }
    })
    expect(meta.error).toMatch(/429/)
    expect(results[0].status).toBe('unavailable')
    expect(results[0].recommendedAgentId).toBeNull()
  })

  it('treats malformed evaluator output as unavailable', async () => {
    const { results } = await evaluateCandidates({
      agentResults: threeAgents('Basic Q?', 'Inter Q?', 'Adv Q?'), questionTypes: ['MCQ'], transcript, callModel: async () => 'sorry, cannot help'
    })
    expect(results[0].status).toBe('unavailable')
  })

  it('returns exactly one recommendation per configured slot', async () => {
    const results = {
      agent_1: agent('agent_1', [mcq('B0?'), mcq('B1?'), mcq('B2?')]),
      agent_2: agent('agent_2', [mcq('I0?'), mcq('I1?'), mcq('I2?')]),
      agent_3: agent('agent_3', [mcq('A0?'), mcq('A1?'), mcq('A2?'), mcq('A3 extra?')]) // over-produced
    }
    const scores = Object.fromEntries(['B0?', 'B1?', 'B2?', 'I0?', 'I1?', 'I2?', 'A0?', 'A1?', 'A2?', 'A3 extra?'].map(q => [q, ok]))
    const { results: recs } = await run(scores, results, ['MCQ', 'MCQ', 'MCQ'])
    expect(recs).toHaveLength(3)
    expect(recs.map(r => r.questionIndex)).toEqual([0, 1, 2])
    expect(recs.every(r => r.candidates.length === 3)).toBe(true)
  })

  it('avoids recommending the same concept in two slots when an alternative exists', async () => {
    const dup = 'Which pigment absorbs red and blue light during photosynthesis?'
    const results = {
      agent_1: agent('agent_1', [mcq(dup), mcq(dup + ' ')]),
      agent_2: agent('agent_2', [mcq('What does the Calvin cycle fix into sugar?'), mcq('What do stomata regulate in leaves?')])
    }
    const scores = {
      [dup]: good,
      [dup + ' ']: good,
      'What does the Calvin cycle fix into sugar?': ok,
      'What do stomata regulate in leaves?': ok
    }
    const { results: recs } = await run(scores, results, ['MCQ', 'MCQ'])
    const picked = recs.map(r => r.recommendedAgentId)
    expect(picked.filter(a => a === 'agent_1')).toHaveLength(1)
  })

  it('scores are not influenced by agent identity (same question, same score)', async () => {
    const q = 'Same question text?'
    const results = { agent_1: agent('agent_1', [mcq(q)]), agent_3: agent('agent_3', [mcq(q + ' ')]) }
    const { results: recs } = await run({ [q]: ok, [q + ' ']: ok }, results)
    const [c1, c3] = recs[0].candidates
    expect(c1.score).toBe(c3.score)
  })
})

describe('buildEvaluationContext', () => {
  const filler = (n) => Array.from({ length: n }, (_, i) => `Filler sentence number ${i} talks about unrelated logistics and scheduling.`).join(' ')
  const key = 'The Calvin cycle fixes carbon dioxide into sugar inside the stroma.'

  it('sends short transcripts whole', () => {
    const { context, excerpted } = buildEvaluationContext(transcript, [])
    expect(context).toBe(transcript)
    expect(excerpted).toBe(false)
  })

  it('reduces long transcripts to the passages relevant to each candidate, within the budget', () => {
    const long = `${filler(400)} ${key} ${filler(400)}`
    const cand = { question: mcq('What does the Calvin cycle fix into sugar in the stroma?') }
    const { context, excerpted } = buildEvaluationContext(long, [cand], 300)
    expect(excerpted).toBe(true)
    expect(context).toContain(key)
    expect(context.split(/\s+/).length).toBeLessThanOrEqual(300)
  })

  it('handles unpunctuated speech by windowing it', () => {
    const long = Array(3000).fill('word').join(' ') + ' calvin cycle fixes carbon ' + Array(3000).fill('word').join(' ')
    const cand = { question: mcq('What does the calvin cycle fix?') }
    const { context } = buildEvaluationContext(long, [cand], 200)
    expect(context).toMatch(/calvin cycle fixes carbon/)
    expect(context.split(/\s+/).length).toBeLessThanOrEqual(200)
  })
})

describe('similarity', () => {
  it('is high for near-duplicates and low for unrelated questions', () => {
    expect(similarity('What does chlorophyll absorb?', 'What light does chlorophyll absorb?')).toBeGreaterThan(0.5)
    expect(similarity('What does chlorophyll absorb?', 'What do stomata regulate?')).toBeLessThan(0.2)
  })
})
