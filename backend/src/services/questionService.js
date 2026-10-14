import dotenv from 'dotenv'
dotenv.config()
import Question from '../models/Question.js'
import Response from '../models/Response.js'
import Room from '../models/Room.js'
import { config, AI_PROVIDERS } from '../config.js'

// Re-export for convenience
export { AI_PROVIDERS }

export const createQuestion = async (data, createdBy) => {
  const question = new Question({
    roomId: data.roomId,  // Use roomId to match Question model
    question: data.question,
    options: data.options,
    type: data.type || 'MCQ',
    status: data.status || 'pending',  // pending for manual, approved for AI
    segmentIndex: data.segmentIndex || 0,
    timeToAnswer: data.timer || data.timeToAnswer || 30,
    points: data.points || 100,
    createdBy
  })

  await question.save()
  return question
}

export const getQuestionById = async (id) => {
  const question = await Question.findById(id).populate('createdBy', 'name email')
  
  if (!question) {
    throw new Error('Question not found')
  }
  
  return question
}

export const getQuestionsByRoom = async (roomId) => {
  return Question.find({ roomId: roomId }).sort({ createdAt: 1 })
}

export const updateQuestion = async (questionId, updates, userId) => {
  const question = await Question.findById(questionId)
  
  if (!question) {
    throw new Error('Question not found')
  }
  
  // Check ownership
  if (question.createdBy.toString() !== userId.toString()) {
    throw new Error('Not authorized to update this question')
  }
  
  Object.assign(question, updates)
  await question.save()
  
  return question
}

export const deleteQuestion = async (questionId, userId) => {
  const question = await Question.findById(questionId)
  
  if (!question) {
    throw new Error('Question not found')
  }
  
  if (question.createdBy.toString() !== userId.toString()) {
    throw new Error('Not authorized to delete this question')
  }
  
  await Question.findByIdAndDelete(questionId)
  
  // Also delete related responses
  await Response.deleteMany({ question: questionId })
  
  return true
}

export const setActiveQuestion = async (roomId, questionId) => {
  // Deactivate all questions in the room
  await Question.updateMany(
    { roomId: roomId },
    { $set: { isActive: false } }
  )
  
  // Activate the specified question
  const question = await Question.findByIdAndUpdate(
    questionId,
    { $set: { isActive: true } },
    { new: true }
  )
  
  if (!question) {
    throw new Error('Question not found')
  }
  
  // Update room's currentQuestion
  await Room.findByIdAndUpdate(roomId, { currentQuestion: questionId })
  
  return question
}

export const submitResponse = async (data, studentId) => {
  const { questionId, selectedOption, responseTime } = data
  
  // Get the question to check correct answer
  const question = await Question.findById(questionId)
  
  if (!question) {
    throw new Error('Question not found')
  }
  
  const isCorrect = selectedOption === question.correctOptionIndex
  
  const response = new Response({
    question: questionId,
    roomId: question.roomId,
    studentId: studentId,
    selectedOption,
    isCorrect,
    responseTime
  })

  await response.save()
  
  return response
}

export const getResponsesByQuestion = async (questionId) => {
  return Response.find({ question: questionId })
    .populate('student', 'name email')
    .sort({ createdAt: -1 })
}

export const getResponsesByRoom = async (roomId) => {
  return Response.find({ roomId: roomId })
    .populate('studentId', 'name email')
    .sort({ createdAt: -1 })
}

export const getQuestionResults = async (questionId) => {
  const responses = await Response.find({ question: questionId })
  
  const totalResponses = responses.length
  
  if (totalResponses === 0) {
    return {
      totalResponses: 0,
      results: {},
      correctPercentage: 0
    }
  }
  
  const results = {}
  let correctCount = 0
  
  responses.forEach(response => {
    const option = response.selectedOption
    results[option] = (results[option] || 0) + 1
    
    if (response.isCorrect) {
      correctCount++
    }
  })
  
  return {
    totalResponses,
    results,
    correctPercentage: Math.round((correctCount / totalResponses) * 100)
  }
}

// Question Type Mix helper
function getQuestionTypeMix(numQuestions) {
  return Array(numQuestions).fill('MCQ')
}

// Generate question types from provided mix percentages
function generateFromMix(questionTypeMix, numQuestions) {
  if (!questionTypeMix) {
    return getQuestionTypeMix(numQuestions)
  }

  const { MCQ = 0, TF = 0, MSQ = 0 } = questionTypeMix
  const mcqVal = Number(MCQ) || 0
  const tfVal = Number(TF) || 0
  const msqVal = Number(MSQ) || 0
  const total = mcqVal + tfVal + msqVal

  if (total <= 0) {
    return getQuestionTypeMix(numQuestions)
  }

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

// Build prompt for question generation
export function buildQuestionPrompt(transcript, questionTypes, difficulty, agentProfile = null) {
  const diff = String(difficulty || 'medium').toLowerCase()
  
  let relativeHierarchy = '';
  let bloomEmphasis = '';
  let toughness = '';
  let comprehension = '';
  let sentenceLengthRule = '- One sentence each. Answerable in ~15 seconds.';

  if (agentProfile === 'basic') {
    relativeHierarchy = `DIFFICULTY TIER: LEVEL 1 of 3 (EASIEST).
- This is the BASIC level: questions must be straightforward, direct, and foundational.
- Direct definition or explicit fact check directly from the transcript text.
- Must be the easiest of all three agents. No deceptive wording, no subtle traps.`;
    bloomEmphasis = 'Focus purely on Remember and direct Understand levels. Straightforward definitions, key concepts, and clearly stated facts.';
    toughness = 'Easiest tier: direct, clear comprehension. Anyone who paid basic attention should answer with ease.';
    comprehension = '- Test direct comprehension using definitions, examples, and key points explicitly stated in the transcript.';
    sentenceLengthRule = '- MUST be very short and concise (under 15 words if possible).';
  } else if (agentProfile === 'intermediate') {
    relativeHierarchy = `DIFFICULTY TIER: LEVEL 2 of 3 (MODERATE).
- CRITICAL RULE: Intermediate MUST NOT be harder than Advanced!
- It should test standard understanding: why a concept is used, what purpose it serves, or how two mentioned ideas relate.
- Moderate difficulty: more thoughtful than Basic, but straightforward and fair.
- DO NOT use tricky wording, deceptive technicalities, or subtle edge-case traps (those belong strictly to Advanced).`;
    bloomEmphasis = 'Focus on Understand and Apply levels. Tests core purpose, main functionality, and clear relationships between ideas mentioned in the transcript.';
    toughness = 'Moderate tier: tests solid understanding of what was taught without trick questions. Clearly easier and more direct than Advanced, but deeper than Basic.';
    comprehension = '- Test understanding of the purpose or relationship of concepts directly stated in the transcript.';
    sentenceLengthRule = '- One clear, balanced sentence.';
  } else if (agentProfile === 'advanced') {
    relativeHierarchy = `DIFFICULTY TIER: LEVEL 3 of 3 (HARDEST).
- CRITICAL RULE: Advanced MUST unambiguously be the most challenging and thought-provoking question of the three agents!
- It tests deep analytical precision: subtle distinctions (e.g. necessary vs sufficient conditions, defining criteria vs benefits), evaluating whether a nuanced statement strictly holds, or catching subtle misconceptions.
- Must still use only the transcript vocabulary and context, but requires the highest cognitive precision.`;
    bloomEmphasis = 'Focus on Analyze and Evaluate levels. Tests subtle boundaries, precise necessary conditions, or evaluating subtle misconceptions.';
    toughness = 'Hardest tier: Requires careful analytical discernment. Must be clearly more challenging than both Basic and Intermediate.';
    comprehension = '- Test analytical precision and subtle distinction strictly within the transcript concepts.';
    sentenceLengthRule = '- One precise, carefully crafted sentence.';
  } else {
    // Normal single-agent mode behavior
    bloomEmphasis = diff === 'easy'
      ? 'Since difficulty is EASY, lean toward the Understand and Apply levels — but still test genuine comprehension and simple inference, never rote recall.'
      : diff === 'hard'
        ? 'Since difficulty is HARD, skew toward the Analyze and Evaluate levels — most questions should require multi-step reasoning or spotting a subtly flawed inference.'
        : 'For MEDIUM difficulty, balance across Understand, Apply, Analyze and Evaluate, with a slight lean toward Analyze.'
        
    toughness = 'Genuinely thoughtful — it must make the student reason, never go out of context.';
    comprehension = '- Test comprehension, inference and reasoning strictly based on the session content.';
    sentenceLengthRule = '- One sentence each. Answerable in ~15 seconds.';
  }

  const typeInstructions = questionTypes.map((type, index) => {
    switch (type) {
      case 'MCQ':
        if (agentProfile === 'basic') return `${index + 1}. MCQ: A direct question with 4 options testing a core definition or fact from the transcript. Exactly ONE correct.`;
        if (agentProfile === 'intermediate') return `${index + 1}. MCQ: A question with 4 options testing how or why a concept is used in the transcript. Clear and direct, not tricky. Exactly ONE correct.`;
        if (agentProfile === 'advanced') return `${index + 1}. MCQ: A challenging question with 4 options testing precise analysis or subtle distinctions. Exactly ONE correct; distractors should be plausible misconceptions.`;
        return `${index + 1}. MCQ: A question with 4 options (A–D), exactly ONE correct; the 3 distractors must be plausible misconceptions drawn strictly from the transcript context. Mark the correct answer.`
      case 'TF':
        if (agentProfile === 'basic') return `${index + 1}. T/F: A short, direct factual statement explicitly stated in the transcript. Mark whether it is True or False.`;
        if (agentProfile === 'intermediate') return `${index + 1}. T/F: A clear statement testing the core purpose or relationship of a concept from the transcript. Mark whether it is True or False. (Do not make it a tricky edge case; keep it clearly simpler than Advanced).`;
        if (agentProfile === 'advanced') return `${index + 1}. T/F: A challenging statement testing a subtle distinction (such as necessary condition vs outcome) using the transcript's concepts. Mark whether it is True or False.`;
        return `${index + 1}. T/F: A statement that is plausible-sounding but subtly right OR subtly wrong based strictly on the transcript. Mark the correct answer.`
      case 'MSQ':
        return `${index + 1}. MSQ: A question with 2–4 correct options (out of 4–5); all options must be strictly within the transcript context. Mark ALL correct options.`
      default:
        return ''
    }
  }).join('\n')

  return `You are an expert educational assessment designer. Using ONLY the session content below, write ${questionTypes.length} high-quality quiz questions.

SESSION CONTENT:
${transcript}

${agentProfile ? `${relativeHierarchy}` : `DIFFICULTY: ${difficulty.toUpperCase()}`}

QUESTION TYPES (produce exactly these, in this order):
${typeInstructions}

HOW TO WRITE GOOD QUESTIONS:
${sentenceLengthRule}
- ${toughness}
${comprehension}
- ${bloomEmphasis} (Bloom levels only guide YOU while writing — do not label or mention them anywhere in the output.)
- STRICT CONTEXT AND VOCABULARY RULE: Every question, statement, and option MUST stay strictly within the context of the transcript. The words, terminology, and concepts in the question and options MUST be taken directly from the transcript. Do NOT introduce outside topics, external domains, or hypothetical scenarios not mentioned in the transcript.
- Distractors and false statements must be plausible within the transcript's subject matter — never obviously wrong or completely out of context.
- The "explanation" is a brief "why" that TEACHES: state what makes the answer correct and why the tempting alternative is wrong, in one or two sentences.

WORDING:
- Write each question so it stands on its own as a direct subject-knowledge question.
- Do NOT point at the material with lazy stems. Never use the words "source material", "source", "transcript", "transcription", "passage", "text", "excerpt", "recording", "audio", "context", "speaker", "narrator", "presenter", or "author", and never refer to whoever produced the content as "the speaker" in ANY form (e.g. "the speaker said/mentioned/states/explains/argues/concludes", "as per the speaker", "the speaker's point"), nor open with "According to the source/passage/text".
- ONLY when a question is genuinely about HOW an idea was framed or illustrated may you refer to "the session", "the discussion", or "the instructor" — never "the speaker" or "the source material".
  BAD:  "According to the source material, what caused the failure?"
  GOOD: "A single low-cost component caused a total system failure — what does this best demonstrate about complex engineered systems?"

OUTPUT FORMAT (respond ONLY with valid JSON):
{
  "questions": [
    {
      "type": "MCQ",
      "question": "The question text here?",
      "options": [
        { "text": "Option A", "isCorrect": true },
        { "text": "Option B", "isCorrect": false },
        { "text": "Option C", "isCorrect": false },
        { "text": "Option D", "isCorrect": false }
      ],
      "explanation": "Brief explanation of the answer"
    },
    {
      "type": "TF",
      "question": "The statement here?",
      "options": [
        { "text": "True", "isCorrect": true },
        { "text": "False", "isCorrect": false }
      ],
      "explanation": "Brief explanation"
    },
    {
      "type": "MSQ",
      "question": "The question here?",
      "options": [
        { "text": "Option A", "isCorrect": true },
        { "text": "Option B", "isCorrect": false },
        { "text": "Option C", "isCorrect": true },
        { "text": "Option D", "isCorrect": false }
      ],
      "explanation": "Brief explanation of which options are correct"
    }
  ]
}

IMPORTANT:
- Respond ONLY with valid JSON, no markdown or additional text
- Make questions clear and unambiguous
- Base every question ONLY on the session content; use NO outside knowledge or external domains.
- All vocabulary, terms, and subject matter in the questions must come directly from the transcript only. Do not go out of context.
- For MSQ, ensure at least 2 options are correct
- Ensure all options are distinct and that ONLY the marked option(s) are correct; every unmarked option must be a plausible but genuinely incorrect distractor, with no option that could be argued as an alternative correct answer
- For True/False questions, balance the correct answers across the set — roughly half should be correct "True" and half correct "False"; do not make most statements True (or most False)`
}

// Parse questions from AI response
export function parseQuestions(responseText, expectedTypes) {
  try {
    let jsonStr = typeof responseText === 'string' ? responseText : String(responseText ?? '')
    
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
    if (jsonMatch) {
      jsonStr = jsonMatch[1]
    }
    
    // Find JSON array or object
    const match = jsonStr.match(/(\{[\s\S]*\}|\[[\s\S]*\])/)
    if (!match) {
      throw new Error('No JSON object or array found in response')
    }

    let rawJson = match[0]
    // Clean trailing commas before closing braces/brackets (common LLM JSON error)
    rawJson = rawJson.replace(/,\s*([\}\]])/g, '$1')

    const parsed = JSON.parse(rawJson)
    const questions = Array.isArray(parsed) ? parsed : (parsed.questions || [])
    
    return questions.map((q, index) => ({
      id: `q_${Date.now()}_${index}`,
      type: q.type || expectedTypes[index] || 'MCQ',
      question: q.question || 'Question text missing',
      options: parseOptions(q.options || [], q.type),
      explanation: q.explanation || '',
      segmentIndex: 0,
      createdAt: new Date().toISOString()
    }))
  } catch (error) {
    // Log the RAW model text so a failure is diagnosable instead of a silent []. Truncate huge
    // responses (keep head + tail) so logs stay readable.
    const raw = typeof responseText === 'string' ? responseText : String(responseText ?? '')
    const shown = raw.length > 2000
      ? raw.slice(0, 1000) + `\n…[${raw.length - 2000} chars truncated]…\n` + raw.slice(-1000)
      : raw
    console.error('Failed to parse questions:', error?.message || error)
    console.error(`[gen:parse-fail] raw model response (${raw.length} chars): ${shown}`)
    return []
  }
}

// Parse options ensuring correct structure
export function parseOptions(options, type) {
  if (type === 'TF') {
    // For True/False, use AI-provided options if valid
    if (Array.isArray(options) && options.length === 2) {
      const trueIdx = options.findIndex(o => (o.text || '').toLowerCase().startsWith('true'))
      const falseIdx = options.findIndex(o => (o.text || '').toLowerCase().startsWith('false'))
      
      if (trueIdx !== -1 && falseIdx !== -1) {
        // Return with correct marking preserved
        return [
          { text: 'True', isCorrect: !!options[trueIdx].isCorrect },
          { text: 'False', isCorrect: !!options[falseIdx].isCorrect }
        ]
      }
    }
    // Default TF - mark first as correct if AI didn't specify
    return [
      { text: 'True', isCorrect: true },
      { text: 'False', isCorrect: false }
    ]
  }

  if (!Array.isArray(options) || options.length < 2) {
    return [
      { text: 'Option A', isCorrect: true },
      { text: 'Option B', isCorrect: false },
      { text: 'Option C', isCorrect: false },
      { text: 'Option D', isCorrect: false }
    ]
  }

  return options.map(opt => ({
    text: opt.text || opt.option || 'Unknown',
    isCorrect: opt.isCorrect || opt.correct || false
  }))
}

// MiniMax API call
async function generateWithMiniMax(prompt) {
  const apiKey = config.minimaxApiKey
  const isSamagamaKey = apiKey.startsWith('sk_live_')

  // samagama.in keys use https://api.vicharanashala.ai/v1/chat/completions with model 'minimaxm27'
  const url = isSamagamaKey
    ? 'https://api.vicharanashala.ai/v1/chat/completions'
    : 'https://api.minimax.io/v1/text/chatcompletion_v2'
  const modelName = isSamagamaKey ? 'minimaxm27' : 'MiniMax-M2.7'

  // Headers: Send both Authorization: Bearer and x-api-key for maximum compatibility
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
    'x-api-key': apiKey
  }

  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: modelName,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 8000
      })
    })
  } catch (err) {
    throw new Error(`Samagama Gateway connection error: ${err.message}`)
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    if (response.status === 502) {
      throw new Error(`Samagama Gateway Error (502 Bad Gateway): The LLM server at api.vicharanashala.ai is currently under maintenance or restarting. Please try again in a few minutes.`)
    }
    throw new Error(`API Gateway error (${response.status}): ${errorText.substring(0, 300)}`)
  }

  const data = await response.json()

  // Check for MiniMax base_resp error response (official endpoint format)
  if (data.base_resp && data.base_resp.status_code && data.base_resp.status_code !== 0) {
    throw new Error(`MiniMax API error (${data.base_resp.status_code}): ${data.base_resp.status_msg}`)
  }

  const choice = data.choices?.[0]
  const content = choice?.message?.content || ''
  const reasoning = choice?.message?.reasoning_content || ''
  const finish = choice?.finish_reason
  const usage = data.usage || {}
  console.log(`[gen:minimax] finish=${finish} contentLen=${content.length} reasoningLen=${reasoning.length} completion_tokens=${usage.completion_tokens ?? '?'} reasoning_tokens=${usage.completion_tokens_details?.reasoning_tokens ?? '?'} prompt_tokens=${usage.prompt_tokens ?? '?'}`)
  // The model normally returns the JSON answer in `content`. If `content` is empty (the reasoning
  // model occasionally puts everything in `reasoning_content`), fall back to reasoning so a
  // recoverable answer isn't lost. If BOTH are empty, log the full choice so it's diagnosable.
  const text = content || reasoning
  if (!text) {
    console.error('[gen:minimax] EMPTY response (no content, no reasoning). finish=' + finish +
      ' raw choice: ' + (JSON.stringify(choice || {})).slice(0, 1500))
  } else if (!content && reasoning) {
    console.warn(`[gen:minimax] content empty — falling back to reasoning_content (${reasoning.length} chars)`)
  }
  return text
}

// OpenAI API call
async function generateWithOpenAI(prompt, model = 'gpt-4o-mini') {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.openaiApiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.7,
      max_tokens: 8000
    })
  })

  if (!response.ok) {
    const errorData = await response.text()
    throw new Error(`OpenAI API error: ${response.status} - ${errorData}`)
  }

  const data = await response.json()
  return data.choices?.[0]?.message?.content || ''
}

// Anthropic (Claude) API call
async function generateWithAnthropic(prompt, model = 'claude-sonnet-4-20250514') {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.anthropicApiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      max_tokens: 8000,
      temperature: 0.7
    })
  })

  if (!response.ok) {
    const errorData = await response.text()
    throw new Error(`Anthropic API error: ${response.status} - ${errorData}`)
  }

  const data = await response.json()
  return data.content?.[0]?.text || ''
}

// Google Gemini API call
async function generateWithGoogle(prompt, model = 'gemini-2.0-flash') {
  const actualModel = (!model || model.includes('3.6') || model.includes('default')) ? 'gemini-2.0-flash' : model
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${actualModel}:generateContent?key=${config.googleApiKey}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            {
              text: prompt
            }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 8000
      }
    })
  })

  if (!response.ok) {
    const errorData = await response.text()
    throw new Error(`Google API error: ${response.status} - ${errorData}`)
  }

  const data = await response.json()
  return data.candidates?.[0]?.content?.parts?.[0]?.text || ''
}

// Main question generation function
export async function generateQuestions(transcript, cfg) {
  const { numQuestions = 2, difficulty = 'medium', provider = 'minimax', questionTypeMix = null } = cfg || {}

  if (!transcript || transcript.trim().length === 0) {
    throw new Error('Transcript is required')
  }

  // Use provided questionTypeMix or generate default based on numQuestions
  const questionTypes = questionTypeMix 
    ? generateFromMix(questionTypeMix, numQuestions)
    : getQuestionTypeMix(numQuestions)
  const prompt = buildQuestionPrompt(transcript, questionTypes, difficulty)

  console.log(`Generating ${numQuestions} questions with ${provider} from a ${transcript.length}-char transcript...`)

  let responseText

  switch (provider) {
    case 'minimax':
      if (!config.minimaxApiKey) throw new Error('MiniMax API key not configured')
      responseText = await generateWithMiniMax(prompt)
      break
    case 'openai':
      if (!config.openaiApiKey) throw new Error('OpenAI API key not configured')
      responseText = await generateWithOpenAI(prompt)
      break
    case 'anthropic':
      if (!config.anthropicApiKey) throw new Error('Anthropic API key not configured')
      responseText = await generateWithAnthropic(prompt)
      break
    case 'google':
      if (!config.googleApiKey) throw new Error('Google API key not configured')
      responseText = await generateWithGoogle(prompt)
      break
    default:
      throw new Error(`Unknown provider: ${provider}`)
  }

  console.log(`[gen] ${provider} returned ${responseText?.length || 0} chars; preview: ${JSON.stringify((responseText || '').slice(0, 140))}`)
  const questions = parseQuestions(responseText, questionTypes)
  if (questions.length === 0) {
    console.error(`[gen] parsed 0 questions from a ${responseText?.length || 0}-char ${provider} response (numQuestions=${numQuestions}, transcript=${transcript.length} chars) — see [gen:parse-fail] above for the raw text`)
  } else {
    console.log(`Generated ${questions.length} questions successfully`)
  }

  return questions
}