/**
 * Multi-Agent Question Generation Orchestrator
 *
 * Runs 3 AI agents (Basic, Intermediate, Advanced) against the same transcript, each with its own
 * system instruction via the shared AI client. A 4th Evaluator Agent then scores every candidate
 * in ONE call and recommends one question per slot based on quality — never on agent level
 * (see services/questionEvaluator.js).
 *
 * Generators run concurrently by default. Set MULTI_AGENT_CONCURRENCY=1 to restore the previous
 * sequential behaviour (with inter-agent delays) if a provider key's request-per-minute limit is
 * hit. Each agent keeps its own rate-limit retry with backoff + jitter.
 *
 * Flow:
 *   transcript → Agent 1 (Basic)       ┐
 *             → Agent 2 (Intermediate) ├→ parse, cap to N, tag
 *             → Agent 3 (Advanced)     ┘
 *             → Agent 4 (Evaluator)    → one call over all candidates → one pick per slot
 *             → return { agentResults, evaluatorResults, timings, apiStats }
 */

import { callGemini } from '../agents/geminiClient.js'
import agent60 from '../agents/agent60.js'
import agent75 from '../agents/agent75.js'
import agent90 from '../agents/agent90.js'
import agentEvaluator from '../agents/agent_evaluator.js'
import { buildQuestionPrompt, parseQuestions } from './questionService.js'
import { evaluateCandidates } from './questionEvaluator.js'

// All available generator agent configs, keyed by agentId for easy lookup
const AGENTS = {
  agent_1: agent60,
  agent_2: agent75,
  agent_3: agent90
}

const AGENT_PROFILE = {
  agent_1: 'basic',
  agent_2: 'intermediate',
  agent_3: 'advanced'
}

/**
 * Get agent config by ID
 * @param {string} agentId — 'agent_1', 'agent_2', or 'agent_3'
 * @returns {Object|null}
 */
export function getAgentConfig(agentId) {
  return AGENTS[agentId] || null
}

/**
 * Get all available agents (for the settings UI)
 * @returns {Array<Object>}
 */
export function getAllAgents() {
  return Object.values(AGENTS).map(a => ({
    agentId: a.agentId,
    efficiencyLevel: a.efficiencyLevel,
    label: a.label,
    shortLabel: a.shortLabel,
    color: a.color,
    icon: a.icon
  }))
}

const agentMeta = (agentConfig) => ({
  agentId: agentConfig.agentId,
  efficiencyLevel: agentConfig.efficiencyLevel,
  label: agentConfig.label,
  shortLabel: agentConfig.shortLabel,
  color: agentConfig.color,
  icon: agentConfig.icon
})

const isRateLimitError = (msg) =>
  !!msg && (msg.includes('503') || msg.includes('429') || msg.includes('high demand') || msg.includes('UNAVAILABLE'))

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Run a SINGLE agent against a transcript.
 * Uses the agent's systemInstruction + the shared question prompt.
 *
 * @param {Object} agentConfig — One of agent60/agent75/agent90
 * @param {string} transcript  — The session transcript text
 * @param {Object} cfg         — { difficulty, questionTypes, provider, batchId, stats, callModel }
 * @returns {Promise<Object>}  — { agentId, questions: [...], error: null } or { agentId, questions: [], error: '...' }
 */
async function runSingleAgent(agentConfig, transcript, cfg) {
  const { difficulty = 'medium', questionTypes, provider = 'auto', batchId, stats, callModel } = cfg
  const startTime = Date.now()

  try {
    // Build the user prompt (injecting the specific agent profile to create true variance)
    const userPrompt = buildQuestionPrompt(transcript, questionTypes, difficulty, AGENT_PROFILE[agentConfig.agentId] || null)

    console.log(`[multi-agent] Running ${agentConfig.label} (${agentConfig.agentId})...`)

    // Call AI provider with this agent's persona
    const responseText = await callModel({
      userPrompt,
      systemInstruction: agentConfig.systemInstruction,
      provider,
      stats
    })

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(`[multi-agent] ${agentConfig.agentId} returned ${responseText?.length || 0} chars in ${elapsed}s`)

    // Parse the response using the existing parser, then cap to the configured count so an
    // over-producing model can never add extra slots to the teacher's review popup.
    const parsed = parseQuestions(responseText, questionTypes)
    const questions = parsed.slice(0, questionTypes.length)
    if (parsed.length > questions.length) {
      console.warn(`[multi-agent] ${agentConfig.agentId} returned ${parsed.length} questions; capped to ${questions.length}`)
    }

    if (questions.length === 0) {
      console.error(`[multi-agent] ${agentConfig.agentId} parsed 0 questions`)
      return { ...agentMeta(agentConfig), questions: [], error: 'Failed to parse questions from AI response', elapsed }
    }

    // Tag each question with agent metadata. IDs are tied to batch + agent + slot so they stay
    // unique even when agents finish in the same millisecond.
    const taggedQuestions = questions.map((q, i) => ({
      ...q,
      id: `${batchId}_${agentConfig.agentId}_${i}`,
      agent: agentConfig.agentId,
      efficiencyLevel: agentConfig.efficiencyLevel,
      agentLabel: agentConfig.label,
      generationBatchId: batchId
    }))

    console.log(`[multi-agent] ${agentConfig.agentId} generated ${taggedQuestions.length} question(s) successfully`)

    return { ...agentMeta(agentConfig), questions: taggedQuestions, error: null, elapsed }
  } catch (error) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    console.error(`[multi-agent] ${agentConfig.agentId} FAILED in ${elapsed}s:`, error.message)
    return { ...agentMeta(agentConfig), questions: [], error: error.message || 'Unknown error', elapsed }
  }
}

// Exponential backoff delays for rate-limit retries (3s, 8s, 20s) plus up to 1s of jitter so
// concurrently running agents don't retry in lock-step.
const RETRY_DELAYS = [3000, 8000, 20000]
// Delay before the evaluator's single retry (overridable so tests don't wait).
const EVALUATOR_RETRY_MS = Number(process.env.EVALUATOR_RETRY_MS) || 3000

// Total time one agent may spend waiting between retries, so a long rate-limit wait can't push the
// request past the 5-minute HTTP timeout.
const MAX_RETRY_WAIT_MS = Number(process.env.MULTI_AGENT_MAX_RETRY_WAIT_MS) || 90000

// Wait at least the backoff step, or longer if the provider said when to retry ("retry in ~Ns").
export function retryDelayFor(errorMessage, baseMs) {
  const hints = [...String(errorMessage || '').matchAll(/retry in ~(\d+)s/g)].map(m => Number(m[1]) * 1000)
  const hint = hints.length ? Math.min(...hints) : 0
  return Math.max(baseMs, hint) + Math.floor(Math.random() * 1000)
}

// A provider timeout (slow model under load) gets ONE retry, but only while there is still time
// for it inside the 5-minute HTTP limit. Advanced — the longest, most reasoned answer — is the
// agent most likely to exceed the per-request timeout, so without this it was the one that failed.
const isTimeoutError = (msg) => /timed out/i.test(msg || '')
const TIMEOUT_RETRY_DEADLINE_MS = Number(process.env.MULTI_AGENT_TIMEOUT_RETRY_DEADLINE_MS) || 150000

async function runAgentWithRetry(agentConfig, transcript, cfg) {
  const startedAt = Date.now()
  let result = await runSingleAgent(agentConfig, transcript, cfg)
  if (!isRateLimitError(result.error) && isTimeoutError(result.error)) {
    if (Date.now() - startedAt < TIMEOUT_RETRY_DEADLINE_MS) {
      console.log(`[multi-agent] ${agentConfig.agentId} timed out, retrying once...`)
      result = await runSingleAgent(agentConfig, transcript, cfg)
    } else {
      console.warn(`[multi-agent] ${agentConfig.agentId} timed out with no time left to retry`)
    }
  }
  let waited = 0
  for (let retry = 0; retry < RETRY_DELAYS.length && isRateLimitError(result.error); retry++) {
    const delay = retryDelayFor(result.error, RETRY_DELAYS[retry])
    if (waited + delay > MAX_RETRY_WAIT_MS) {
      console.warn(`[multi-agent] ${agentConfig.agentId} rate-limited; next wait ${delay}ms would exceed the ${MAX_RETRY_WAIT_MS}ms retry budget — giving up`)
      break
    }
    console.log(`[multi-agent] ${agentConfig.agentId} hit rate limit, retry ${retry + 1}/${RETRY_DELAYS.length} in ${delay}ms...`)
    await sleep(delay)
    waited += delay
    result = await runSingleAgent(agentConfig, transcript, cfg)
  }
  return result
}

// Helper: determine question types for generation based on settings questionTypeMix
export function resolveQuestionTypes(numQuestions, questionTypeMix) {
  if (questionTypeMix) {
    const { MCQ = 0, TF = 0, MSQ = 0 } = questionTypeMix
    const mcqVal = Number(MCQ) || 0
    const tfVal = Number(TF) || 0
    const msqVal = Number(MSQ) || 0
    const total = mcqVal + tfVal + msqVal

    if (total > 0) {
      if (numQuestions === 1) {
        const r = Math.random() * total
        if (r < mcqVal) return ['MCQ']
        if (r < mcqVal + tfVal) return ['TF']
        return ['MSQ']
      }

      let mcqCount = Math.round((mcqVal / total) * numQuestions)
      let tfCount = Math.round((tfVal / total) * numQuestions)
      let msqCount = Math.round((msqVal / total) * numQuestions)

      let currentTotal = mcqCount + tfCount + msqCount
      while (currentTotal < numQuestions) {
        if (mcqVal >= tfVal && mcqVal >= msqVal) mcqCount++
        else if (tfVal >= msqVal) tfCount++
        else msqCount++
        currentTotal++
      }
      while (currentTotal > numQuestions) {
        if (msqCount > 0) msqCount--
        else if (tfCount > 0) tfCount--
        else if (mcqCount > 0) mcqCount--
        currentTotal--
      }

      const types = []
      for (let i = 0; i < mcqCount; i++) types.push('MCQ')
      for (let i = 0; i < tfCount; i++) types.push('TF')
      for (let i = 0; i < msqCount; i++) types.push('MSQ')

      for (let i = types.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [types[i], types[j]] = [types[j], types[i]]
      }

      return types.slice(0, numQuestions)
    }
  }

  // Default: MCQ
  return Array(numQuestions).fill('MCQ')
}

// Trim very long transcripts to avoid exhausting the provider's tokens-per-minute quota.
// Keeping it under ~7,500 words gives each agent ~10K tokens, well within limits.
const MAX_WORDS = 7500

/**
 * Main orchestrator: run the generator agents, then the evaluator.
 *
 * @param {string} transcript — The session transcript
 * @param {Object} cfg — Configuration:
 *   @param {number}   [cfg.numQuestions=1]    — Questions per agent (= configured count / slots)
 *   @param {string}   [cfg.difficulty='medium']
 *   @param {Object}   [cfg.questionTypeMix]   — { MCQ, TF, MSQ } percentages
 *   @param {string[]} [cfg.agents]            — Which agents to run: ['agent_1','agent_2','agent_3']
 *   @param {string}   [cfg.provider='auto']
 * @param {Object} [deps] — { callModel } injectable AI call (tests); defaults to callGemini
 * @returns {Promise<Object>} — { success, batchId, agentResults, evaluatorResults, errors, totalElapsed, ... }
 */
export async function generateMultiAgentQuestions(transcript, cfg = {}, deps = {}) {
  const {
    numQuestions = 1,
    difficulty = 'medium',
    questionTypeMix = null,
    agents: requestedAgents = ['agent_1', 'agent_2', 'agent_3'],
    provider = 'auto'
  } = cfg
  const callModel = deps.callModel || callGemini

  if (!transcript || transcript.trim().length === 0) {
    throw new Error('Transcript is required')
  }

  let trimmedTranscript = transcript.trim()
  const words = trimmedTranscript.split(/\s+/)
  const wordCount = words.length
  const truncated = wordCount > MAX_WORDS
  if (truncated) {
    // Keep the LAST N words (most recent content is usually most relevant)
    trimmedTranscript = words.slice(-MAX_WORDS).join(' ')
    console.log(`[multi-agent] Transcript trimmed from ${wordCount} to ${MAX_WORDS} words (kept most recent)`)
  }

  // Validate requested agents
  const validAgents = requestedAgents.filter(id => AGENTS[id])
  if (validAgents.length === 0) {
    throw new Error('No valid agents specified. Use: agent_1, agent_2, agent_3')
  }

  // Resolve question types once (same types for all agents for fair comparison)
  const questionTypes = resolveQuestionTypes(numQuestions, questionTypeMix)

  const envConcurrency = parseInt(process.env.MULTI_AGENT_CONCURRENCY, 10)
  const concurrency = Math.max(1, Math.min(validAgents.length, Number.isFinite(envConcurrency) ? envConcurrency : 3))

  console.log(`[multi-agent] Starting generation with ${validAgents.length} agent(s): ${validAgents.join(', ')} (provider=${provider}, concurrency=${concurrency})`)
  console.log(`[multi-agent] Config: ${numQuestions} question(s) per agent, difficulty=${difficulty}, types=${questionTypes.join(',')}, words=${wordCount}`)

  const startTime = Date.now()
  const agentResults = {}
  const errors = []
  const stats = { requests: 0, inputTokens: 0, outputTokens: 0 }

  // Generate a unique batch ID so all questions from this run can be linked
  const batchId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

  const runCfg = { difficulty, questionTypes, provider, batchId, stats, callModel }

  // Sequential mode keeps the inter-agent buffer to avoid consecutive-request TPM spikes.
  const INTER_AGENT_DELAY_MS = wordCount > 3000 ? 3000 : wordCount > 1000 ? 2000 : 1000
  // Concurrent mode staggers starts slightly so the provider doesn't see one simultaneous burst.
  const STAGGER_MS = 250

  const results = new Array(validAgents.length)
  let next = 0
  const worker = async () => {
    while (next < validAgents.length) {
      const i = next++
      if (concurrency === 1 && i > 0) {
        console.log(`[multi-agent] Waiting ${INTER_AGENT_DELAY_MS}ms before next agent...`)
        await sleep(INTER_AGENT_DELAY_MS)
      } else if (concurrency > 1 && i > 0) {
        await sleep(STAGGER_MS * i)
      }
      results[i] = await runAgentWithRetry(AGENTS[validAgents[i]], trimmedTranscript, runCfg)
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))

  // Insert in the requested order so the response shape is stable regardless of finish order.
  validAgents.forEach((agentId, i) => {
    agentResults[agentId] = results[i]
    if (results[i].error) errors.push({ agentId, error: results[i].error })
  })
  const generationElapsed = ((Date.now() - startTime) / 1000).toFixed(1)

  // --- 4th Agent: Evaluator ---
  // Run evaluation only when at least one generator succeeded and produced questions.
  const successfulResults = Object.values(agentResults).filter(r => r.questions.length > 0)
  let evaluatorResults = []
  let evaluatorMeta = { elapsed: '0.0', error: null, evaluatedCount: 0 }

  if (successfulResults.length > 0) {
    if (concurrency === 1) {
      const evalDelayMs = wordCount > 3000 ? 3000 : 2000
      console.log(`[multi-agent] Waiting ${evalDelayMs}ms before evaluator agent...`)
      await sleep(evalDelayMs)
    }

    const { results: evalResults, meta } = await evaluateCandidates({
      agentResults,
      questionTypes,
      transcript: trimmedTranscript,
      // One retry on a transient rate-limit / high-demand error, so a momentary 503 doesn't
      // leave the teacher without recommendations.
      callModel: async (userPrompt) => {
        const call = () => callModel({
          userPrompt,
          systemInstruction: agentEvaluator.systemInstruction,
          provider,
          temperature: 0.2,
          jsonMode: true,
          stats
        })
        try {
          return await call()
        } catch (err) {
          if (!isRateLimitError(err.message)) throw err
          const delay = Math.min(retryDelayFor(err.message, EVALUATOR_RETRY_MS), MAX_RETRY_WAIT_MS)
          console.log(`[multi-agent] Evaluator hit rate limit, retrying once in ${delay}ms...`)
          await sleep(delay)
          return call()
        }
      }
    })
    evaluatorResults = evalResults
    evaluatorMeta = meta
    if (meta.error) console.warn(`[multi-agent] Evaluator unavailable: ${meta.error}`)
    console.log(`[multi-agent] Evaluator returned ${evaluatorResults.length} slot result(s) in ${meta.elapsed}s ` +
      `(${evaluatorResults.map(r => `${r.questionIndex}:${r.status}${r.recommendedAgentId ? '→' + r.recommendedAgentId : ''}`).join(', ')})`)
  } else {
    console.warn('[multi-agent] Skipping evaluator — all generator agents failed.')
  }

  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1)

  const totalQuestions = Object.values(agentResults).reduce((sum, r) => sum + r.questions.length, 0)
  console.log(`[multi-agent] Complete: ${totalQuestions} total question(s) from ${validAgents.length} agent(s) in ${totalElapsed}s ` +
    `(generation ${generationElapsed}s, evaluator ${evaluatorMeta.elapsed}s, requests=${stats.requests}, tokens in/out=${stats.inputTokens}/${stats.outputTokens})`)

  if (errors.length > 0) {
    console.warn(`[multi-agent] ${errors.length} agent(s) had errors:`, errors.map(e => `${e.agentId}: ${e.error}`).join('; '))
  }

  return {
    success: true,
    batchId,
    agentResults,
    evaluatorResults,
    evaluatorError: evaluatorMeta.error,
    errors,
    totalElapsed,
    timings: {
      generation: generationElapsed,
      evaluator: evaluatorMeta.elapsed,
      agents: Object.fromEntries(Object.entries(agentResults).map(([id, r]) => [id, r.elapsed])),
      concurrency
    },
    apiStats: stats,
    transcriptInfo: { wordCount, truncated, usedWords: truncated ? MAX_WORDS : wordCount }
  }
}

export default generateMultiAgentQuestions
