/**
 * Multi-Agent Question Generation Orchestrator
 *
 * Runs 3 AI agents (60%, 75%, 90%) SEQUENTIALLY against the same transcript,
 * each with its own system instruction via the shared Gemini client.
 * Returns grouped results so the teacher can compare and select.
 *
 * Sequential execution is necessary because all agents share 1 Gemini API key —
 * parallel calls would hit rate limits.
 *
 * Flow:
 *   transcript → buildQuestionPrompt() → Agent 1 (60%) → Gemini → parse
 *                                       → Agent 2 (75%) → Gemini → parse
 *                                       → Agent 3 (90%) → Gemini → parse
 *                                       → return { agent_1: [...], agent_2: [...], agent_3: [...] }
 */

import { callGemini } from '../agents/geminiClient.js'
import agent60 from '../agents/agent60.js'
import agent75 from '../agents/agent75.js'
import agent90 from '../agents/agent90.js'
import { buildQuestionPrompt, parseQuestions } from './questionService.js'

// All available agent configs, keyed by agentId for easy lookup
const AGENTS = {
  agent_1: agent60,
  agent_2: agent75,
  agent_3: agent90
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

/**
 * Run a SINGLE agent against a transcript.
 * Uses the agent's systemInstruction + the shared question prompt.
 *
 * @param {Object} agentConfig — One of agent60/agent75/agent90
 * @param {string} transcript  — The session transcript text
 * @param {Object} cfg         — { numQuestions, difficulty, questionTypeMix }
 * @returns {Promise<Object>}  — { agentId, questions: [...], error: null } or { agentId, questions: [], error: '...' }
 */
async function runSingleAgent(agentConfig, transcript, cfg) {
  const { numQuestions = 1, difficulty = 'medium', questionTypes, provider = 'auto' } = cfg
  const startTime = Date.now()

  try {
    let agentProfile = null;
    if (agentConfig.agentId === 'agent_1') agentProfile = 'basic';
    else if (agentConfig.agentId === 'agent_2') agentProfile = 'intermediate';
    else if (agentConfig.agentId === 'agent_3') agentProfile = 'advanced';

    // Build the user prompt (injecting the specific agent profile to create true variance)
    const userPrompt = buildQuestionPrompt(transcript, questionTypes, difficulty, agentProfile)

    console.log(`[multi-agent] Running ${agentConfig.label} (${agentConfig.agentId})...`)

    // Call AI provider with this agent's persona
    const responseText = await callGemini({
      userPrompt,
      systemInstruction: agentConfig.systemInstruction,
      provider
    })

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(`[multi-agent] ${agentConfig.agentId} returned ${responseText?.length || 0} chars in ${elapsed}s`)

    // Parse the response using the existing parser
    const questions = parseQuestions(responseText, questionTypes)

    if (questions.length === 0) {
      console.error(`[multi-agent] ${agentConfig.agentId} parsed 0 questions`)
      return {
        agentId: agentConfig.agentId,
        efficiencyLevel: agentConfig.efficiencyLevel,
        label: agentConfig.label,
        shortLabel: agentConfig.shortLabel,
        color: agentConfig.color,
        icon: agentConfig.icon,
        questions: [],
        error: 'Failed to parse questions from AI response',
        elapsed
      }
    }

    // Tag each question with agent metadata
    const taggedQuestions = questions.map(q => ({
      ...q,
      agent: agentConfig.agentId,
      efficiencyLevel: agentConfig.efficiencyLevel,
      agentLabel: agentConfig.label
    }))

    console.log(`[multi-agent] ${agentConfig.agentId} generated ${taggedQuestions.length} question(s) successfully`)

    return {
      agentId: agentConfig.agentId,
      efficiencyLevel: agentConfig.efficiencyLevel,
      label: agentConfig.label,
      shortLabel: agentConfig.shortLabel,
      color: agentConfig.color,
      icon: agentConfig.icon,
      questions: taggedQuestions,
      error: null,
      elapsed
    }
  } catch (error) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    console.error(`[multi-agent] ${agentConfig.agentId} FAILED in ${elapsed}s:`, error.message)

    return {
      agentId: agentConfig.agentId,
      efficiencyLevel: agentConfig.efficiencyLevel,
      label: agentConfig.label,
      shortLabel: agentConfig.shortLabel,
      color: agentConfig.color,
      icon: agentConfig.icon,
      questions: [],
      error: error.message || 'Unknown error',
      elapsed
    }
  }
}

// Helper: determine question types for generation based on settings questionTypeMix
function resolveQuestionTypes(numQuestions, questionTypeMix) {
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

/**
 * Main orchestrator: run multiple agents SEQUENTIALLY and collect results.
 *
 * @param {string} transcript — The session transcript
 * @param {Object} cfg — Configuration:
 *   @param {number}   [cfg.numQuestions=1]    — Questions per agent (default 1 in multi-agent mode)
 *   @param {string}   [cfg.difficulty='medium']
 *   @param {Object}   [cfg.questionTypeMix]   — { MCQ, TF, MSQ } percentages
 *   @param {string[]} [cfg.agents]            — Which agents to run: ['agent_1','agent_2','agent_3']
 * @returns {Promise<Object>} — { agentResults: { agent_1: {...}, agent_2: {...}, agent_3: {...} }, errors: [...], totalElapsed }
 */
export async function generateMultiAgentQuestions(transcript, cfg = {}) {
  const {
    numQuestions = 1,
    difficulty = 'medium',
    questionTypeMix = null,
    agents: requestedAgents = ['agent_1', 'agent_2', 'agent_3'],
    provider = 'auto'
  } = cfg

  if (!transcript || transcript.trim().length === 0) {
    throw new Error('Transcript is required')
  }

  // Trim very long transcripts to avoid exhausting Gemini's tokens-per-minute quota.
  // 10,000 words ≈ 13,000 tokens per call × 3 agents = ~39,000 input tokens.
  // Keeping it under ~7,500 words gives each agent ~10K tokens, well within limits.
  const MAX_WORDS = 7500
  let trimmedTranscript = transcript.trim()
  const wordCount = trimmedTranscript.split(/\s+/).length
  if (wordCount > MAX_WORDS) {
    // Keep the LAST N words (most recent content is usually most relevant)
    const words = trimmedTranscript.split(/\s+/)
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

  console.log(`[multi-agent] Starting generation with ${validAgents.length} agent(s): ${validAgents.join(', ')} (provider=${provider})`)
  console.log(`[multi-agent] Config: ${numQuestions} question(s) per agent, difficulty=${difficulty}, types=${questionTypes.join(',')}, words=${wordCount}`)

  const startTime = Date.now()
  const agentResults = {}
  const errors = []

  // Generate a unique batch ID so all questions from this run can be linked
  const batchId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

  // Dynamic delay: longer transcripts use more of the TPM quota, so we wait longer
  const INTER_AGENT_DELAY_MS = wordCount > 3000 ? 8000 : wordCount > 1000 ? 5000 : 3000
  // Exponential backoff delays for retries
  const RETRY_DELAYS = [6000, 15000, 30000] // 6s, 15s, 30s

  console.log(`[multi-agent] Inter-agent delay: ${INTER_AGENT_DELAY_MS}ms (based on ${wordCount} words)`)

  for (let i = 0; i < validAgents.length; i++) {
    const agentId = validAgents[i]
    const agentConfig = AGENTS[agentId]

    // Delay between agents (not before the first one)
    if (i > 0) {
      console.log(`[multi-agent] Waiting ${INTER_AGENT_DELAY_MS}ms before next agent...`)
      await new Promise(resolve => setTimeout(resolve, INTER_AGENT_DELAY_MS))
    }

    let result = await runSingleAgent(agentConfig, trimmedTranscript, {
      numQuestions,
      difficulty,
      questionTypes,
      provider
    })

    // Retry with exponential backoff on rate-limit errors (503 / 429)
    if (result.error && (result.error.includes('503') || result.error.includes('429') || result.error.includes('high demand') || result.error.includes('UNAVAILABLE'))) {
      for (let retry = 0; retry < RETRY_DELAYS.length; retry++) {
        const delay = RETRY_DELAYS[retry]
        console.log(`[multi-agent] ${agentId} hit rate limit, retry ${retry + 1}/${RETRY_DELAYS.length} in ${delay}ms...`)
        await new Promise(resolve => setTimeout(resolve, delay))
        result = await runSingleAgent(agentConfig, trimmedTranscript, {
          numQuestions,
          difficulty,
          questionTypes,
          provider
        })
        // If success or a different error, stop retrying
        if (!result.error || (!result.error.includes('503') && !result.error.includes('429') && !result.error.includes('high demand') && !result.error.includes('UNAVAILABLE'))) {
          break
        }
      }
    }

    // Attach batch ID to each question
    result.questions = result.questions.map(q => ({ ...q, generationBatchId: batchId }))
    agentResults[agentId] = result

    if (result.error) {
      errors.push({ agentId, error: result.error })
    }
  }

  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1)

  const totalQuestions = Object.values(agentResults).reduce((sum, r) => sum + r.questions.length, 0)
  console.log(`[multi-agent] Complete: ${totalQuestions} total question(s) from ${validAgents.length} agent(s) in ${totalElapsed}s`)

  if (errors.length > 0) {
    console.warn(`[multi-agent] ${errors.length} agent(s) had errors:`, errors.map(e => `${e.agentId}: ${e.error}`).join('; '))
  }

  return {
    success: true,
    batchId,
    agentResults,
    errors,
    totalElapsed
  }
}

export default generateMultiAgentQuestions
