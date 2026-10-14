/**
 * Frontend service for multi-agent question generation.
 * Calls POST /api/questions/generate-multi and returns grouped agent results.
 */

import { API_URL } from '../config.js'
import useAuthStore from '../stores/authStore.js'

/**
 * Request multi-agent question generation.
 * @param {string} transcript — The transcript text
 * @param {Object} config — { numQuestions, difficulty, questionTypeMix, agents }
 * @returns {Promise<Object>} — { success, batchId, agentResults, errors, totalElapsed }
 */
export const requestMultiAgentGeneration = async (transcript, config) => {
  const token = useAuthStore.getState().token

  // 300s timeout — 3 agents run sequentially on the backend (~60s each max)
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 300_000)

  try {
    const response = await fetch(`${API_URL}/questions/generate-multi`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ transcript, config }),
      signal: controller.signal
    })

    clearTimeout(timeoutId)

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}))
      throw new Error(errData.error || `HTTP ${response.status}`)
    }

    return response.json()
  } catch (err) {
    clearTimeout(timeoutId)
    if (err.name === 'AbortError') {
      throw new Error('Multi-agent generation timed out. The AI agents took too long — try with a shorter transcript.')
    }
    throw err
  }
}

/**
 * Fetch available agent configurations.
 * @returns {Promise<Object>} — { success, agents: [...] }
 */
export const getAgentConfigs = async () => {
  const token = useAuthStore.getState().token
  const response = await fetch(`${API_URL}/questions/agents`, {
    headers: token ? { 'Authorization': `Bearer ${token}` } : {}
  })
  return response.json()
}
