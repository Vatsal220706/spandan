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
  const response = await fetch(`${API_URL}/questions/generate-multi`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ transcript, config })
  })

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}))
    throw new Error(errData.error || `HTTP ${response.status}`)
  }

  return response.json()
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
