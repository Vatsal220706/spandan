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
  const { numQuestions = 1, difficulty = 'medium', questionTypes } = cfg
  const startTime = Date.now()

  try {
    // Build the user prompt (same prompt all agents receive — the difference is the systemInstruction)
    const userPrompt = buildQuestionPrompt(transcript, questionTypes, difficulty)

    console.log(`[multi-agent] Running ${agentConfig.label} (${agentConfig.agentId})...`)

    // Call Gemini with this agent's persona
    const responseText = await callGemini({
      userPrompt,
      systemInstruction: agentConfig.systemInstruction
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

// Helper: determine question types for generation
function resolveQuestionTypes(numQuestions, questionTypeMix) {
  // Inline the mix logic so we don't need to import the private helpers.
  // Each agent generates 1 question by default in multi-agent mode,
  // so we mostly just need a single type.
  if (questionTypeMix) {
    const { MCQ = 0, TF = 100, MSQ = 0 } = questionTypeMix
    const total = MCQ + TF + MSQ
    if (total <= 0) return ['MCQ']

    const types = []
    const mcqCount = Math.round((MCQ / total) * numQuestions)
    const tfCount = Math.round((TF / total) * numQuestions)
    const msqCount = numQuestions - mcqCount - tfCount

    for (let i = 0; i < mcqCount; i++) types.push('MCQ')
    for (let i = 0; i < tfCount; i++) types.push('TF')
    for (let i = 0; i < msqCount; i++) types.push('MSQ')

    // Shuffle
    for (let i = types.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [types[i], types[j]] = [types[j], types[i]]
    }

    return types.slice(0, numQuestions)
  }

  // Default: 1 question = MCQ, 2 = MCQ+TF, 3 = MCQ+TF+MSQ
  if (numQuestions === 1) return ['MCQ']
  if (numQuestions === 2) return ['MCQ', 'TF']
  if (numQuestions === 3) return ['MCQ', 'TF', 'MSQ']
  return ['MCQ']
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
    agents: requestedAgents = ['agent_1', 'agent_2', 'agent_3']
  } = cfg

  if (!transcript || transcript.trim().length === 0) {
    throw new Error('Transcript is required')
  }

  // Validate requested agents
  const validAgents = requestedAgents.filter(id => AGENTS[id])
  if (validAgents.length === 0) {
    throw new Error('No valid agents specified. Use: agent_1, agent_2, agent_3')
  }

  // Resolve question types once (same types for all agents for fair comparison)
  const questionTypes = resolveQuestionTypes(numQuestions, questionTypeMix)

  console.log(`[multi-agent] Starting generation with ${validAgents.length} agent(s): ${validAgents.join(', ')}`)
  console.log(`[multi-agent] Config: ${numQuestions} question(s) per agent, difficulty=${difficulty}, types=${questionTypes.join(',')}`)

  const startTime = Date.now()
  const agentResults = {}
  const errors = []

  // Generate a unique batch ID so all questions from this run can be linked
  const batchId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

  // Run agents SEQUENTIALLY (same API key — can't parallelize without rate limits)
  for (const agentId of validAgents) {
    const agentConfig = AGENTS[agentId]
    const result = await runSingleAgent(agentConfig, transcript, {
      numQuestions,
      difficulty,
      questionTypes
    })

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
