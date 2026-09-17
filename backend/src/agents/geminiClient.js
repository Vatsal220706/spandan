/**
 * Shared Gemini API client for multi-agent question generation.
 *
 * Extracted from the existing `generateWithGoogle()` in questionService.js and
 * enhanced with `systemInstruction` support so each agent can have its own persona
 * while sharing the same API key and model.
 *
 * Usage:
 *   import { callGemini } from './geminiClient.js'
 *   const text = await callGemini({ systemInstruction, userPrompt })
 */

import { config } from '../config.js'

const DEFAULT_MODEL = 'gemini-3.6-flash'
const DEFAULT_TEMPERATURE = 0.7
const DEFAULT_MAX_TOKENS = 8000

/**
 * Call the Gemini API with an optional system instruction (agent persona)
 * and a user prompt (the actual question generation request).
 *
 * @param {Object} opts
 * @param {string} opts.userPrompt         — The question generation prompt (transcript + instructions)
 * @param {string} [opts.systemInstruction] — Agent-specific system instruction (persona/profile)
 * @param {string} [opts.model]            — Gemini model name (default: gemini-3.6-flash)
 * @param {number} [opts.temperature]      — Sampling temperature (default: 0.7)
 * @param {number} [opts.maxOutputTokens]  — Max output tokens (default: 8000)
 * @returns {Promise<string>} — The raw text response from Gemini
 */
export async function callGemini({
  userPrompt,
  systemInstruction = '',
  model = DEFAULT_MODEL,
  temperature = DEFAULT_TEMPERATURE,
  maxOutputTokens = DEFAULT_MAX_TOKENS
}) {
  if (!config.googleApiKey) {
    throw new Error('Google API key not configured. Set GOOGLE_API_KEY in your .env file.')
  }

  if (!userPrompt || userPrompt.trim().length === 0) {
    throw new Error('userPrompt is required')
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.googleApiKey}`

  // Build the request body. The Gemini REST API accepts an optional top-level
  // `systemInstruction` field that acts like a system prompt — the model treats
  // it as persistent context separate from the user's message.
  const body = {
    contents: [
      {
        parts: [{ text: userPrompt }]
      }
    ],
    generationConfig: {
      temperature,
      maxOutputTokens
    }
  }

  // Only include systemInstruction if the agent provides one
  if (systemInstruction && systemInstruction.trim().length > 0) {
    body.systemInstruction = {
      parts: [{ text: systemInstruction }]
    }
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })

  if (!response.ok) {
    const errorData = await response.text().catch(() => '')
    throw new Error(`Gemini API error (${response.status}): ${errorData.substring(0, 500)}`)
  }

  const data = await response.json()
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || ''

  if (!text) {
    const finishReason = data.candidates?.[0]?.finishReason || 'UNKNOWN'
    console.error(`[geminiClient] Empty response. finishReason=${finishReason}`)
    throw new Error(`Gemini returned empty response (finishReason: ${finishReason})`)
  }

  return text
}

export default callGemini
