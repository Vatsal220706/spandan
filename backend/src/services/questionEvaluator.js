/**
 * Agent 4 — Question Evaluator core.
 *
 * Evaluates every candidate question from the generator agents in ONE structured model call and
 * then picks, per question slot, the best candidate deterministically in code. The originating
 * agent's level is metadata only: it is shown to the model solely to judge "difficulty fit", is
 * hidden behind anonymous ids (C1, C2, ...) in shuffled order, and never enters the score.
 *
 * Pipeline:
 *   buildCandidates()        — flatten agentResults into slot-tagged candidates + structural checks
 *   buildEvaluationPrompt()  — anonymize + shuffle the structurally valid candidates
 *   callModel(prompt)        — injected (so tests need no network)
 *   parseEvaluation()        — tolerant JSON extraction
 *   scoreCandidate()         — weighted score + verdict (rejected / needs_review / acceptable)
 *   selectRecommendations()  — one pick per slot, avoiding cross-slot duplicates
 *
 * Nothing here rewrites a question. The teacher can still select any card manually.
 */

export const TARGET_LEVEL = {
  agent_1: 'basic',
  agent_2: 'intermediate',
  agent_3: 'advanced'
}

// Weighted rubric (sums to 1). Answer validity and correctness dominate: a wrong answer key is the
// most harmful failure in a live quiz.
export const WEIGHTS = {
  answerValidity: 0.25,
  correctness: 0.2,
  relevance: 0.15,
  clarity: 0.15,
  educationalValue: 0.15,
  difficultyFit: 0.1
}

export const REJECT_BELOW = 40     // score (0–100) under which a candidate is rejected
export const RECOMMEND_FROM = 60   // score at/above which a clean candidate is "acceptable"
export const DUPLICATE_SIMILARITY = 0.6

// Structural problems that make a question unusable as-is.
const HARD_FLAGS = new Set([
  'empty_question',
  'placeholder_options',
  'wrong_option_count',
  'no_correct_option',
  'multiple_correct_options',
  'too_few_correct_options',
  'duplicate_options'
])

const PLACEHOLDER_OPTION = /^(option\s+[a-e]|unknown)$/i
const STOPWORDS = new Set(('the a an and or of to in on for with by is are was were be been being it its this that these ' +
  'those as at from which what who whom whose why how when where does do did can could would should will ' +
  'not no yes true false than then there their they them most best following statement').split(' '))

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()

export function tokenize(text) {
  return norm(text).split(' ').filter(w => w.length > 2 && !STOPWORDS.has(w))
}

// Jaccard similarity on content words of question + correct options.
export function similarity(a, b) {
  const sa = new Set(tokenize(a))
  const sb = new Set(tokenize(b))
  if (sa.size === 0 || sb.size === 0) return 0
  let inter = 0
  for (const w of sa) if (sb.has(w)) inter++
  return inter / (sa.size + sb.size - inter)
}

const fingerprint = (q) =>
  `${q.question || ''} ${(q.options || []).filter(o => o.isCorrect).map(o => o.text).join(' ')}`

/**
 * Code-level checks that need no model call.
 * @param {Object} q            — parsed question { type, question, options }
 * @param {string} expectedType — the type requested for this slot (MCQ / TF / MSQ)
 * @returns {string[]} flags
 */
export function checkStructure(q, expectedType) {
  const flags = []
  const text = String(q?.question || '').trim()
  if (!text || text === 'Question text missing') flags.push('empty_question')

  const options = Array.isArray(q?.options) ? q.options : []
  const texts = options.map(o => String(o?.text || '').trim())
  const correct = options.filter(o => o?.isCorrect).length
  const type = q?.type || 'MCQ'

  if (texts.length > 0 && texts.every(t => PLACEHOLDER_OPTION.test(t))) flags.push('placeholder_options')
  if (new Set(texts.map(norm)).size !== texts.length) flags.push('duplicate_options')

  if (type === 'TF') {
    if (texts.length !== 2) flags.push('wrong_option_count')
    if (correct === 0) flags.push('no_correct_option')
    if (correct > 1) flags.push('multiple_correct_options')
  } else if (type === 'MSQ') {
    if (texts.length < 4 || texts.length > 5) flags.push('wrong_option_count')
    if (correct < 2) flags.push(correct === 0 ? 'no_correct_option' : 'too_few_correct_options')
  } else {
    if (texts.length !== 4) flags.push('wrong_option_count')
    if (correct === 0) flags.push('no_correct_option')
    if (correct > 1) flags.push('multiple_correct_options')
  }

  if (expectedType && type !== expectedType) flags.push('type_mismatch')
  return flags
}

/**
 * Flatten agentResults into candidates, one per (agent, slot).
 * @param {Object}   agentResults  — { agent_1: { questions: [...] }, ... }
 * @param {string[]} questionTypes — requested type per slot; its length is the slot count
 */
export function buildCandidates(agentResults, questionTypes) {
  const candidates = []
  for (const [agentId, r] of Object.entries(agentResults || {})) {
    const qs = r?.questions || []
    qs.slice(0, questionTypes.length).forEach((q, slot) => {
      candidates.push({
        key: `${agentId}#${slot}`,
        agentId,
        slot,
        expectedType: questionTypes[slot],
        targetLevel: TARGET_LEVEL[agentId] || 'unspecified',
        question: q,
        structuralFlags: checkStructure(q, questionTypes[slot])
      })
    })
  }
  return candidates
}

const hasHardFlag = (flags) => flags.some(f => HARD_FLAGS.has(f))

function shuffle(arr, rng = Math.random) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/**
 * Build the single evaluation prompt. Only structurally valid candidates are sent.
 * @returns {{ prompt: string|null, idToKey: Object, order: Object }}
 */
export function buildEvaluationPrompt(candidates, transcript, rng = Math.random) {
  const sendable = shuffle(candidates.filter(c => !hasHardFlag(c.structuralFlags)), rng)
  const idToKey = {}
  const order = {}
  if (sendable.length === 0) return { prompt: null, idToKey, order }

  const blocks = sendable.map((c, i) => {
    const id = `C${i + 1}`
    idToKey[id] = c.key
    order[c.key] = i
    const q = c.question
    const opts = (q.options || []).map((o, oi) =>
      `${String.fromCharCode(65 + oi)}. ${o.text}${o.isCorrect ? ' [CORRECT]' : ''}`
    ).join('\n')
    return `[${id}] type=${q.type || c.expectedType} targetLevel=${c.targetLevel}
Q: ${q.question}
${opts}
Explanation: ${q.explanation || 'N/A'}`
  }).join('\n\n')

  const prompt = `SESSION CONTENT:
${transcript}

CANDIDATES (${sendable.length}):
${blocks}

Evaluate EVERY candidate exactly once. Return JSON in exactly this shape:
{"evaluations":[{"id":"C1","relevance":1,"correctness":1,"answerValidity":1,"clarity":1,"educationalValue":1,"difficultyFit":1,"answerValid":true,"grounded":true,"evidence":"","duplicateOf":null,"note":""}]}`

  return { prompt, idToKey, order }
}

/**
 * Tolerant JSON extraction: strips fences, finds the outer object/array, removes trailing commas.
 * @returns {Array|null} evaluations, or null when nothing parseable was found
 */
export function parseEvaluation(text) {
  if (!text) return null
  let s = String(text)
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  if (fence) s = fence[1]
  const match = s.match(/(\{[\s\S]*\}|\[[\s\S]*\])/)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[0].replace(/,\s*([}\]])/g, '$1'))
    const list = Array.isArray(parsed) ? parsed : parsed?.evaluations
    return Array.isArray(list) ? list : null
  } catch {
    return null
  }
}

const clampScore = (v) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return 1
  return Math.min(5, Math.max(1, n))
}

// Does the evaluator's quoted evidence actually appear in the transcript? Exact substring after
// normalization, or ≥80% of its content words present (tolerates small paraphrase/punctuation).
export function evidenceInTranscript(evidence, transcript) {
  const e = norm(evidence)
  if (!e) return false
  const t = norm(transcript)
  if (t.includes(e)) return true
  const words = tokenize(evidence)
  if (words.length === 0) return false
  const tSet = new Set(tokenize(transcript))
  return words.filter(w => tSet.has(w)).length / words.length >= 0.8
}

/**
 * Turn one raw model evaluation into a scored, verdicted record.
 */
export function scoreCandidate(candidate, rawEval, transcript) {
  const flags = [...candidate.structuralFlags]

  if (hasHardFlag(flags)) {
    return { score: 0, verdict: 'rejected', flags, answerValid: false, grounded: false, evidenceFound: false, note: 'Failed structural validation.', criteria: null }
  }
  if (!rawEval) {
    return { score: null, verdict: 'needs_review', flags: [...flags, 'not_evaluated'], answerValid: null, grounded: null, evidenceFound: false, note: 'Evaluator did not return a result for this question.', criteria: null }
  }

  const criteria = {}
  let weighted = 0
  for (const [k, w] of Object.entries(WEIGHTS)) {
    criteria[k] = clampScore(rawEval[k])
    weighted += criteria[k] * w
  }
  const score = Math.round(((weighted - 1) / 4) * 100)

  const answerValid = rawEval.answerValid !== false
  const grounded = rawEval.grounded !== false
  const evidenceFound = evidenceInTranscript(rawEval.evidence, transcript)
  if (!answerValid) flags.push('invalid_answer')
  if (!grounded) flags.push('not_grounded')
  if (!evidenceFound) flags.push('evidence_not_found')

  // evidence_not_found is informational: models often paraphrase quotes, so it is surfaced to the
  // teacher but does not by itself block a candidate the evaluator judged grounded.
  const blocking = flags.filter(f => f !== 'evidence_not_found')
  let verdict
  if (!answerValid || !grounded || score < REJECT_BELOW) verdict = 'rejected'
  else if (score < RECOMMEND_FROM || blocking.length > 0) verdict = 'needs_review'
  else verdict = 'acceptable'

  return { score, verdict, flags, answerValid, grounded, evidenceFound, note: String(rawEval.note || '').slice(0, 300), criteria }
}

// Higher is better. Ties: score → answerValidity → correctness → clarity → (shuffled) prompt
// position. Agent level and agent order are never consulted.
function compareCandidates(a, b, order) {
  const s = (x) => x.evaluation.score ?? -1
  if (s(b) !== s(a)) return s(b) - s(a)
  for (const k of ['answerValidity', 'correctness', 'clarity']) {
    const d = (b.evaluation.criteria?.[k] || 0) - (a.evaluation.criteria?.[k] || 0)
    if (d !== 0) return d
  }
  return (order[a.key] ?? 1e9) - (order[b.key] ?? 1e9)
}

/**
 * Pick one candidate per slot. Slots are filled most-confident first so a strong question is not
 * displaced by a weaker duplicate in another slot.
 * @returns {Object} slot -> { pick, status, overlaps }
 */
export function selectRecommendations(evaluated, numSlots, order = {}) {
  const bySlot = Array.from({ length: numSlots }, () => [])
  for (const c of evaluated) if (c.slot < numSlots) bySlot[c.slot].push(c)
  bySlot.forEach(list => list.sort((a, b) => compareCandidates(a, b, order)))

  const slotOrder = [...bySlot.keys()].sort((x, y) => {
    const top = (i) => bySlot[i].find(c => c.evaluation.verdict !== 'rejected')?.evaluation.score ?? -1
    return top(y) - top(x)
  })

  const chosen = []
  const picks = {}
  for (const slot of slotOrder) {
    const list = bySlot[slot]
    const acceptable = list.filter(c => c.evaluation.verdict === 'acceptable')
    const review = list.filter(c => c.evaluation.verdict === 'needs_review' && c.evaluation.score !== null)
    const pool = acceptable.length > 0 ? acceptable : review
    const status = acceptable.length > 0 ? 'recommended' : review.length > 0 ? 'needs_review' : 'no_good_candidate'

    if (pool.length === 0) {
      picks[slot] = { pick: null, status, overlaps: false }
      continue
    }
    const isDup = (c) => chosen.some(o =>
      similarity(fingerprint(c.question), fingerprint(o.question)) >= DUPLICATE_SIMILARITY ||
      c.evaluation.duplicateOfKey === o.key || o.evaluation.duplicateOfKey === c.key)
    const fresh = pool.find(c => !isDup(c))
    const pick = fresh || pool[0]
    chosen.push(pick)
    picks[slot] = { pick, status, overlaps: !fresh }
  }
  return picks
}

function slotReasoning(status, pick, list, overlaps) {
  if (status === 'unavailable') return 'The AI evaluator could not assess this question. Please review the candidates manually.'
  if (status === 'no_good_candidate') {
    const notes = list.map(c => c.evaluation.note).filter(Boolean).slice(0, 2).join(' ')
    return `No candidate met the quality bar. Edit a question or regenerate.${notes ? ' ' + notes : ''}`
  }
  const base = pick.evaluation.note || 'Strongest candidate on correctness, clarity and relevance.'
  const caution = status === 'needs_review' ? ' Best available, but review it before launching.' : ''
  const overlap = overlaps ? ' Note: it overlaps with another recommended question.' : ''
  return `${base}${caution}${overlap}`
}

/**
 * Main entry: evaluate all candidates and build per-slot recommendations.
 *
 * @param {Object}   p
 * @param {Object}   p.agentResults
 * @param {string[]} p.questionTypes — requested type per slot (length = configured count)
 * @param {string}   p.transcript    — the same (trimmed) text the generators saw
 * @param {Function} p.callModel     — async (prompt) => responseText
 * @param {Function} [p.rng]         — random source (tests)
 * @returns {Promise<{ results: Array, meta: { elapsed, error, evaluatedCount } }>}
 */
export async function evaluateCandidates({ agentResults, questionTypes, transcript, callModel, rng = Math.random }) {
  const start = Date.now()
  const numSlots = questionTypes.length
  const candidates = buildCandidates(agentResults, questionTypes)
  const { prompt, idToKey, order } = buildEvaluationPrompt(candidates, transcript, rng)

  let rawByKey = {}
  let error = null
  if (prompt) {
    try {
      const text = await callModel(prompt)
      const list = parseEvaluation(text)
      if (!list) throw new Error('Evaluator response was not valid JSON')
      for (const e of list) {
        const key = idToKey[String(e?.id || '').trim()]
        if (key && !rawByKey[key]) rawByKey[key] = e
      }
      if (Object.keys(rawByKey).length === 0) throw new Error('Evaluator returned no usable evaluations')
    } catch (err) {
      error = err.message || 'Evaluator failed'
      rawByKey = null
    }
  }

  const evaluated = candidates.map(c => {
    const raw = rawByKey ? rawByKey[c.key] : undefined
    const evaluation = rawByKey === null && !hasHardFlag(c.structuralFlags)
      ? { score: null, verdict: 'needs_review', flags: [...c.structuralFlags, 'not_evaluated'], answerValid: null, grounded: null, evidenceFound: false, note: '', criteria: null }
      : scoreCandidate(c, raw, transcript)
    evaluation.duplicateOfKey = raw?.duplicateOf ? idToKey[String(raw.duplicateOf).trim()] || null : null
    return { ...c, evaluation }
  })

  const picks = rawByKey === null ? {} : selectRecommendations(evaluated, numSlots, order)

  const results = []
  for (let slot = 0; slot < numSlots; slot++) {
    const list = evaluated.filter(c => c.slot === slot)
    if (list.length === 0) continue
    const { pick = null, status = 'unavailable', overlaps = false } = picks[slot] || {}
    const info = pick ? agentResults[pick.agentId] : null
    const recommendedKey = status === 'recommended' || status === 'needs_review' ? pick?.key : null
    results.push({
      questionIndex: slot,
      status,
      recommendedAgentId: pick?.agentId || null,
      recommendedQuestionId: pick?.question?.id || null,
      score: pick?.evaluation.score ?? null,
      reasoning: slotReasoning(status, pick, list, overlaps),
      agentLabel: info?.label || null,
      agentColor: info?.color || null,
      agentIcon: info?.icon || null,
      candidates: list.map(c => ({
        agentId: c.agentId,
        questionId: c.question?.id || null,
        verdict: c.key === recommendedKey ? 'recommended' : c.evaluation.verdict,
        score: c.evaluation.score,
        answerValid: c.evaluation.answerValid,
        grounded: c.evaluation.grounded,
        evidenceFound: c.evaluation.evidenceFound,
        flags: c.evaluation.flags,
        note: c.evaluation.note
      }))
    })
  }

  return {
    results,
    meta: {
      elapsed: ((Date.now() - start) / 1000).toFixed(1),
      error,
      evaluatedCount: rawByKey ? Object.keys(rawByKey).length : 0
    }
  }
}
