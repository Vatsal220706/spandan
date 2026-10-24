import React, { useState, useEffect, useRef } from 'react'
import QuestionEditor from './QuestionEditor'

/**
 * MultiAgentQuestionPopup
 *
 * Full-screen overlay showing questions from all agents side-by-side.
 * Supports multi-question navigation: if each agent generates N questions,
 * the teacher sees question[0] from all agents first, selects & launches one,
 * then clicks "Next" to see question[1], etc.
 *
 * Props:
 *   agentResults      — { agent_1: { questions, label, color, icon, error, elapsed }, ... }
 *   evaluatorResults  — [{ questionIndex, status, recommendedAgentId, score, reasoning, agentLabel, agentColor,
 *                          agentIcon, candidates: [{ agentId, verdict, score, flags, note, ... }] }]
 *                       status: 'recommended' | 'needs_review' | 'no_good_candidate' | 'unavailable'
 *   transcriptInfo    — { wordCount, truncated, usedWords } (optional)
 *   onApprove         — (question, agentInfo) => void — called when teacher selects & launches
 *   onClose           — () => void
 *   onRegenerate      — () => void — re-run all agents
 *   isRegenerating    — boolean
 *   roomSettings      — { timeToAnswer, points, ... }
 */

// Short teacher-facing labels for the evaluator's flags.
const FLAG_LABELS = {
  empty_question: 'Missing question text',
  placeholder_options: 'Placeholder options',
  wrong_option_count: 'Wrong number of options',
  no_correct_option: 'No correct answer marked',
  multiple_correct_options: 'More than one correct answer',
  too_few_correct_options: 'MSQ needs 2+ correct answers',
  duplicate_options: 'Duplicate options',
  type_mismatch: 'Different type than requested',
  invalid_answer: 'Answer key looks wrong',
  not_grounded: 'Not supported by the content',
  evidence_not_found: 'No supporting quote found',
  not_evaluated: 'Not evaluated'
}

const VERDICT_STYLE = {
  recommended: { label: 'Recommended', color: '#f59e0b' },
  acceptable: { label: 'Good', color: '#10b981' },
  needs_review: { label: 'Review', color: '#f97316' },
  rejected: { label: 'Not recommended', color: '#ef4444' }
}

// Auto-launch: seconds the teacher has to cancel before Agent 4's pick is launched.
export const AUTO_LAUNCH_DELAY_S = 5

function MultiAgentQuestionPopup({
  agentResults = {},
  evaluatorResults = [],
  transcriptInfo = null,
  launchMode = 'manual', // 'auto' = launch Agent 4's recommended question automatically
  onApprove,
  onClose,
  onRegenerate,
  isRegenerating = false,
  roomSettings = {}
}) {
  // Current question index (for multi-question navigation)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [selectedAgent, setSelectedAgent] = useState(null)
  const [editingAgent, setEditingAgent] = useState(null)
  const [editedQuestions, setEditedQuestions] = useState({}) // `${agentId}_${index}` -> edited question
  const [launchedIndices, setLaunchedIndices] = useState(new Set()) // which question indices have been launched
  const [launchCountdown, setLaunchCountdown] = useState(null)
  const intervalRef = useRef(null)
  // Auto-launch state: on/off for this popup (the teacher can switch it off here), the seconds
  // left before an auto-launch, and the slots the teacher took over by selecting or editing.
  const [autoMode, setAutoMode] = useState(launchMode === 'auto')
  const [autoCountdown, setAutoCountdown] = useState(null)
  const [manualSlots, setManualSlots] = useState(new Set())
  const autoTimerRef = useRef(null)

  // Clean up countdown intervals on unmount
  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
      if (autoTimerRef.current) clearInterval(autoTimerRef.current)
    }
  }, [])

  // Reset selection when navigating to a new question
  useEffect(() => {
    setSelectedAgent(null)
    setEditingAgent(null)
    setLaunchCountdown(null)
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
  }, [currentIndex])

  // Sort agents by efficiency level
  const sortedAgents = Object.entries(agentResults)
    .sort(([, a], [, b]) => (a.efficiencyLevel || 0) - (b.efficiencyLevel || 0))

  // Total number of questions (max across agents)
  const totalQuestions = Math.max(
    ...Object.values(agentResults).map(r => r.questions?.length || 0),
    1
  )

  const isCurrentLaunched = launchedIndices.has(currentIndex)
  const isLastQuestion = currentIndex >= totalQuestions - 1
  const allDone = launchedIndices.size >= totalQuestions

  // Evaluator recommendation for the current question index
  const currentRecommendation = evaluatorResults.find(r => r.questionIndex === currentIndex) || null
  // Older responses had no status; treat a recommendation with an agent id as 'recommended'.
  const recStatus = currentRecommendation?.status || (currentRecommendation?.recommendedAgentId ? 'recommended' : null)
  const hasPick = !!currentRecommendation?.recommendedAgentId &&
    (recStatus === 'recommended' || recStatus === 'needs_review')
  const getCandidateEval = (agentId) =>
    currentRecommendation?.candidates?.find(c => c.agentId === agentId) || null

  // Auto-select the evaluator's recommendation
  const handleUseRecommendation = () => {
    if (hasPick && !isCurrentLaunched) {
      setSelectedAgent(currentRecommendation.recommendedAgentId)
    }
  }

  // Get the question for an agent at the current index
  const getQuestion = (agentId) => {
    const editKey = `${agentId}_${currentIndex}`
    if (editedQuestions[editKey]) return editedQuestions[editKey]
    const result = agentResults[agentId]
    return result?.questions?.[currentIndex] || null
  }

  // Handle question edit
  const handleQuestionEdit = (agentId, updatedQuestion) => {
    const editKey = `${agentId}_${currentIndex}`
    setEditedQuestions(prev => ({ ...prev, [editKey]: updatedQuestion }))
  }

  // The teacher acting on this slot (select / edit / cancel) stops auto-launch for it.
  const takeOverSlot = () => {
    if (!autoMode) return
    setManualSlots(prev => new Set([...prev, currentIndex]))
  }

  // Handle select
  const handleSelect = (agentId) => {
    if (isCurrentLaunched) return
    takeOverSlot()
    setSelectedAgent(agentId === selectedAgent ? null : agentId)
  }

  // Handle launch (agentIdArg is passed by auto-launch; manual launch uses the selected card)
  const handleLaunch = (agentIdArg) => {
    const agentId = typeof agentIdArg === 'string' ? agentIdArg : selectedAgent
    if (!agentId || isCurrentLaunched) return
    const question = getQuestion(agentId)
    if (!question) return

    const agentInfo = agentResults[agentId]
    const launchQuestion = {
      ...question,
      timeToAnswer: roomSettings.timeToAnswer || 30,
      points: roomSettings.points || 100,
      agent: agentId,
      efficiencyLevel: agentInfo?.efficiencyLevel
    }

    setLaunchedIndices(prev => new Set([...prev, currentIndex]))

    // Start countdown timer (with ref for cleanup on unmount)
    const timer = roomSettings.timeToAnswer || 30
    setLaunchCountdown(timer)
    if (intervalRef.current) clearInterval(intervalRef.current)
    intervalRef.current = setInterval(() => {
      setLaunchCountdown(prev => {
        if (prev <= 1) {
          clearInterval(intervalRef.current)
          intervalRef.current = null
          return 0
        }
        return prev - 1
      })
    }, 1000)

    onApprove(launchQuestion, { agentId, ...agentInfo })
  }

  // --- Auto-launch (launchMode 'auto') ---
  // Only a confident pick ('recommended') is launched automatically. 'needs_review',
  // 'no_good_candidate', 'unavailable', or a slot the teacher took over waits for the teacher.
  const recommendedId = hasPick ? currentRecommendation.recommendedAgentId : null
  const canAutoLaunch = autoMode && recStatus === 'recommended' && !!recommendedId &&
    !!getQuestion(recommendedId) && !isCurrentLaunched && !manualSlots.has(currentIndex) && !isRegenerating

  // Arm the countdown: select Agent 4's pick and count down AUTO_LAUNCH_DELAY_S seconds.
  useEffect(() => {
    if (autoTimerRef.current) {
      clearInterval(autoTimerRef.current)
      autoTimerRef.current = null
    }
    if (!canAutoLaunch) {
      setAutoCountdown(null)
      return
    }
    setSelectedAgent(recommendedId)
    setAutoCountdown(AUTO_LAUNCH_DELAY_S)
    autoTimerRef.current = setInterval(() => {
      setAutoCountdown(prev => (prev === null ? null : Math.max(0, prev - 1)))
    }, 1000)
    return () => {
      if (autoTimerRef.current) {
        clearInterval(autoTimerRef.current)
        autoTimerRef.current = null
      }
    }
  }, [canAutoLaunch, currentIndex, recommendedId])

  // Countdown reached zero: launch the recommended question.
  useEffect(() => {
    if (autoCountdown === 0 && canAutoLaunch) {
      setAutoCountdown(null)
      handleLaunch(recommendedId)
    }
  }, [autoCountdown]) // eslint-disable-line react-hooks/exhaustive-deps

  // When an auto-launched question's answer time ends, move to the next slot (which then
  // auto-launches its own recommendation, or waits for the teacher).
  useEffect(() => {
    if (autoMode && isCurrentLaunched && launchCountdown === 0 && !isLastQuestion) {
      setCurrentIndex(prev => prev + 1)
    }
  }, [autoMode, isCurrentLaunched, launchCountdown, isLastQuestion])

  // Why auto-launch is waiting on this slot (shown to the teacher).
  const autoPauseReason = !autoMode || isCurrentLaunched || canAutoLaunch ? null
    : manualSlots.has(currentIndex) ? 'you took over this question'
      : !currentRecommendation ? 'Agent 4 has no recommendation for this question'
        : recStatus === 'needs_review' ? 'Agent 4 wants you to review its pick first'
          : recStatus === 'unavailable' ? 'Agent 4 could not evaluate this question'
            : recStatus === 'no_good_candidate' ? 'no candidate met the quality bar'
              : isRegenerating ? 'questions are being regenerated'
                : 'no recommended question is available'

  // Navigate to next question
  const handleNext = () => {
    if (currentIndex < totalQuestions - 1) {
      setCurrentIndex(prev => prev + 1)
    }
  }

  // Navigate to previous question
  const handlePrev = () => {
    if (currentIndex > 0) {
      setCurrentIndex(prev => prev - 1)
    }
  }

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      background: 'rgba(0, 0, 0, 0.75)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 2000,
      padding: '20px'
    }}>
      <div
        style={{
          background: 'var(--bg-card, #1e1e2e)',
          borderRadius: '20px',
          padding: '28px',
          width: '100%',
          maxWidth: '1100px',
          maxHeight: '90vh',
          overflow: 'auto',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
          border: '1px solid var(--border-color, #333)'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '20px'
        }}>
          <div>
            <h2 style={{
              margin: 0,
              fontSize: '20px',
              fontWeight: '700',
              color: 'var(--text-primary, #fff)'
            }}>
              🤖 AI Agent Question Comparison
            </h2>
            <p style={{
              margin: '4px 0 0',
              fontSize: '13px',
              color: 'var(--text-secondary, #999)'
            }}>
              Compare questions from different AI agents and select the best one to launch
            </p>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={onRegenerate}
              disabled={isRegenerating}
              style={{
                padding: '8px 16px',
                borderRadius: '8px',
                border: '1px solid var(--border-color, #333)',
                background: 'var(--bg-secondary, #2a2a3e)',
                color: 'var(--text-primary, #fff)',
                fontSize: '13px',
                cursor: isRegenerating ? 'not-allowed' : 'pointer',
                opacity: isRegenerating ? 0.5 : 1
              }}
            >
              {isRegenerating ? '⏳ Regenerating...' : '🔄 Regenerate'}
            </button>
            <button
              onClick={onClose}
              style={{
                padding: '8px 16px',
                borderRadius: '8px',
                border: 'none',
                background: 'var(--bg-secondary, #2a2a3e)',
                color: 'var(--text-secondary, #999)',
                fontSize: '13px',
                cursor: 'pointer'
              }}
            >
              ✕ Close
            </button>
          </div>
        </div>

        {/* Auto-launch status (room setting: launch Agent 4's pick automatically) */}
        {launchMode === 'auto' && (
          <div
            data-testid="auto-launch-bar"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '12px',
              marginBottom: '14px',
              padding: '10px 14px',
              borderRadius: '10px',
              background: autoMode ? '#f59e0b10' : 'var(--bg-secondary, #2a2a3e)',
              border: autoMode ? '1px solid #f59e0b40' : '1px solid var(--border-color, #333)',
              fontSize: '13px',
              color: 'var(--text-primary, #fff)'
            }}
          >
            <div style={{ minWidth: 0 }}>
              {!autoMode && 'Auto-launch is off for this session — select and launch questions yourself.'}
              {autoMode && autoCountdown !== null && (
                <>⭐ Launching <strong>{agentResults[recommendedId]?.label || 'Agent 4’s pick'}</strong>’s question in <strong>{autoCountdown}s</strong></>
              )}
              {autoMode && autoCountdown === null && autoPauseReason && (
                <>⏸ Auto-launch is waiting — {autoPauseReason}. Select and launch a question yourself.</>
              )}
              {autoMode && autoCountdown === null && !autoPauseReason && isCurrentLaunched && (
                isLastQuestion
                  ? '✓ All recommended questions launched.'
                  : <>Next question launches automatically when this one ends{launchCountdown ? ` (${launchCountdown}s)` : ''}.</>
              )}
            </div>
            <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
              {autoMode && autoCountdown !== null && (
                <button
                  onClick={takeOverSlot}
                  style={{
                    padding: '6px 12px',
                    borderRadius: '8px',
                    border: '1px solid #f59e0b',
                    background: 'transparent',
                    color: '#f59e0b',
                    fontSize: '12px',
                    fontWeight: '600',
                    cursor: 'pointer'
                  }}
                >
                  Cancel
                </button>
              )}
              <button
                onClick={() => setAutoMode(prev => !prev)}
                style={{
                  padding: '6px 12px',
                  borderRadius: '8px',
                  border: 'none',
                  background: 'var(--bg-primary, #1a1a2e)',
                  color: 'var(--text-secondary, #999)',
                  fontSize: '12px',
                  cursor: 'pointer'
                }}
              >
                {autoMode ? 'Switch to manual' : 'Turn auto-launch back on'}
              </button>
            </div>
          </div>
        )}

        {/* Question Navigation Bar (only when multiple questions) */}
        {totalQuestions > 1 && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '12px',
            marginBottom: '18px',
            padding: '10px 16px',
            borderRadius: '10px',
            background: 'var(--bg-secondary, #2a2a3e)'
          }}>
            <button
              onClick={handlePrev}
              disabled={currentIndex === 0}
              style={{
                padding: '6px 14px',
                borderRadius: '6px',
                border: 'none',
                background: currentIndex === 0 ? 'transparent' : 'var(--bg-primary, #1a1a2e)',
                color: currentIndex === 0 ? 'var(--text-secondary, #666)' : 'var(--text-primary, #fff)',
                fontSize: '13px',
                fontWeight: '600',
                cursor: currentIndex === 0 ? 'not-allowed' : 'pointer'
              }}
            >
              ← Prev
            </button>

            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              {Array.from({ length: totalQuestions }, (_, i) => (
                <button
                  key={i}
                  onClick={() => setCurrentIndex(i)}
                  style={{
                    width: '32px',
                    height: '32px',
                    borderRadius: '50%',
                    border: i === currentIndex ? '2px solid #3b82f6' : '2px solid transparent',
                    background: launchedIndices.has(i)
                      ? '#10b981'
                      : i === currentIndex
                        ? '#3b82f620'
                        : 'var(--bg-primary, #1a1a2e)',
                    color: launchedIndices.has(i) ? 'white' : 'var(--text-primary, #fff)',
                    fontSize: '13px',
                    fontWeight: '700',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    transition: 'all 0.2s ease'
                  }}
                >
                  {launchedIndices.has(i) ? '✓' : i + 1}
                </button>
              ))}
            </div>

            <button
              onClick={handleNext}
              disabled={isLastQuestion}
              style={{
                padding: '6px 14px',
                borderRadius: '6px',
                border: 'none',
                background: isLastQuestion ? 'transparent' : 'var(--bg-primary, #1a1a2e)',
                color: isLastQuestion ? 'var(--text-secondary, #666)' : 'var(--text-primary, #fff)',
                fontSize: '13px',
                fontWeight: '600',
                cursor: isLastQuestion ? 'not-allowed' : 'pointer'
              }}
            >
              Next →
            </button>

            <span style={{ fontSize: '12px', color: 'var(--text-secondary, #999)', marginLeft: '8px' }}>
              Question {currentIndex + 1} of {totalQuestions}
              {launchedIndices.size > 0 && ` • ${launchedIndices.size} launched`}
            </span>
          </div>
        )}

        {/* Long-input notice: the agents only saw the most recent part of the text */}
        {transcriptInfo?.truncated && (
          <div style={{
            marginBottom: '12px',
            padding: '8px 14px',
            borderRadius: '10px',
            background: 'var(--bg-secondary, #2a2a3e)',
            fontSize: '12px',
            color: 'var(--text-secondary, #999)'
          }}>
            ℹ️ The text was long ({transcriptInfo.wordCount.toLocaleString()} words), so questions were generated from the most recent {transcriptInfo.usedWords.toLocaleString()} words.
          </div>
        )}

        {/* Evaluator: no usable recommendation for this question */}
        {currentRecommendation && !hasPick && (
          <div style={{
            marginBottom: '18px',
            padding: '14px 18px',
            borderRadius: '12px',
            background: recStatus === 'unavailable' ? 'var(--bg-secondary, #2a2a3e)' : '#ef444410',
            border: recStatus === 'unavailable' ? '1.5px solid var(--border-color, #333)' : '1.5px solid #ef444440',
            display: 'flex',
            alignItems: 'flex-start',
            gap: '12px'
          }}>
            <div style={{ fontSize: '22px', flexShrink: 0, marginTop: '1px' }}>
              {recStatus === 'unavailable' ? 'ℹ️' : '⚠️'}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: '12px',
                fontWeight: '700',
                color: recStatus === 'unavailable' ? 'var(--text-secondary, #999)' : '#ef4444',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                marginBottom: '5px'
              }}>
                {recStatus === 'unavailable' ? 'AI Evaluator Unavailable' : 'No Strong Candidate'}
              </div>
              <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-secondary, #bbb)', lineHeight: '1.5' }}>
                {currentRecommendation.reasoning}
              </p>
            </div>
          </div>
        )}

        {/* Evaluator Recommendation Banner */}
        {currentRecommendation && hasPick && (
          <div style={{
            marginBottom: '18px',
            padding: '14px 18px',
            borderRadius: '12px',
            background: 'linear-gradient(135deg, #f59e0b12, #f59e0b06)',
            border: `1.5px solid #f59e0b50`,
            display: 'flex',
            alignItems: 'flex-start',
            gap: '12px'
          }}>
            {/* Star icon */}
            <div style={{
              fontSize: '22px',
              flexShrink: 0,
              marginTop: '1px'
            }}>⭐</div>

            {/* Recommendation text */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                marginBottom: '5px',
                flexWrap: 'wrap'
              }}>
                <span style={{
                  fontSize: '12px',
                  fontWeight: '700',
                  color: '#f59e0b',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em'
                }}>{recStatus === 'needs_review' ? 'Best Available — Review Before Launching' : 'AI Evaluator Recommends'}</span>
                <span style={{
                  padding: '2px 10px',
                  borderRadius: '20px',
                  background: `${currentRecommendation.agentColor}22`,
                  border: `1px solid ${currentRecommendation.agentColor}60`,
                  color: currentRecommendation.agentColor,
                  fontSize: '12px',
                  fontWeight: '700'
                }}>
                  {currentRecommendation.agentIcon} {currentRecommendation.agentLabel}
                </span>
                {typeof currentRecommendation.score === 'number' && (
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary, #999)' }}>
                    Score {currentRecommendation.score}/100
                  </span>
                )}
              </div>
              <p style={{
                margin: 0,
                fontSize: '13px',
                color: 'var(--text-secondary, #bbb)',
                lineHeight: '1.5'
              }}>
                {currentRecommendation.reasoning}
              </p>
            </div>

            {/* Use Recommendation button */}
            {!isCurrentLaunched && (
              <button
                onClick={handleUseRecommendation}
                style={{
                  padding: '8px 14px',
                  borderRadius: '8px',
                  border: 'none',
                  background: selectedAgent === currentRecommendation.recommendedAgentId
                    ? '#f59e0b'
                    : '#f59e0b20',
                  color: selectedAgent === currentRecommendation.recommendedAgentId
                    ? 'white'
                    : '#f59e0b',
                  fontSize: '12px',
                  fontWeight: '700',
                  cursor: 'pointer',
                  flexShrink: 0,
                  transition: 'all 0.2s ease',
                  whiteSpace: 'nowrap'
                }}
              >
                {selectedAgent === currentRecommendation.recommendedAgentId ? '✓ Selected' : 'Use This'}
              </button>
            )}
          </div>
        )}

        {/* Agent Cards */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: sortedAgents.length <= 2 ? `repeat(${sortedAgents.length}, 1fr)` : 'repeat(3, 1fr)',
          gap: '16px',
          marginBottom: '20px'
        }}>
          {sortedAgents.map(([agentId, result]) => {
            const question = getQuestion(agentId)
            const isSelected = selectedAgent === agentId
            const isEditing = editingAgent === agentId
            const isRecommended = hasPick && currentRecommendation.recommendedAgentId === agentId
            const candidateEval = getCandidateEval(agentId)
            const verdictStyle = candidateEval ? VERDICT_STYLE[candidateEval.verdict] : null
            const hasError = !!result.error && result.questions.length === 0
            const hasNoQuestionAtIndex = !question && !hasError

            return (
              <div
                key={agentId}
                style={{
                  borderRadius: '14px',
                  border: isSelected
                    ? `2px solid ${result.color || '#3b82f6'}`
                    : isRecommended
                      ? `2px solid #f59e0b80`
                      : '2px solid var(--border-color, #333)',
                  background: isSelected
                    ? `${result.color || '#3b82f6'}08`
                    : isRecommended
                      ? '#f59e0b06'
                      : 'var(--bg-secondary, #2a2a3e)',
                  padding: '18px',
                  transition: 'all 0.2s ease',
                  position: 'relative',
                  opacity: (isCurrentLaunched && !isSelected) ? 0.4 : 1
                }}
              >
                {/* Star badge on recommended card */}
                {isRecommended && (
                  <div style={{
                    position: 'absolute',
                    top: '-10px',
                    right: '12px',
                    background: '#f59e0b',
                    color: 'white',
                    fontSize: '10px',
                    fontWeight: '700',
                    padding: '2px 8px',
                    borderRadius: '20px',
                    letterSpacing: '0.04em',
                    boxShadow: '0 2px 6px #f59e0b40'
                  }}>⭐ RECOMMENDED</div>
                )}

                {/* Agent Header */}
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: '14px'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '20px' }}>{result.icon || '🤖'}</span>
                    <div>
                      <div style={{
                        fontSize: '14px',
                        fontWeight: '700',
                        color: result.color || 'var(--text-primary, #fff)'
                      }}>
                        {result.label || agentId}
                      </div>
                      <div style={{
                        fontSize: '11px',
                        color: 'var(--text-secondary, #999)'
                      }}>
                        {result.elapsed ? `${result.elapsed}s` : ''} {result.questions.length > 0 ? `• ${result.questions.length} Q` : ''}
                      </div>
                    </div>
                  </div>
                  {/* Evaluator verdict for this candidate */}
                  {verdictStyle && question && !hasError && (
                    <span
                      title={candidateEval.note || ''}
                      style={{
                        padding: '2px 8px',
                        borderRadius: '20px',
                        fontSize: '11px',
                        fontWeight: '700',
                        whiteSpace: 'nowrap',
                        color: verdictStyle.color,
                        background: `${verdictStyle.color}18`,
                        border: `1px solid ${verdictStyle.color}50`
                      }}
                    >
                      {verdictStyle.label}{typeof candidateEval.score === 'number' ? ` · ${candidateEval.score}` : ''}
                    </span>
                  )}
                </div>

                {/* Evaluator flags (why a candidate needs review / was not recommended) */}
                {candidateEval?.flags?.length > 0 && question && !hasError && (
                  <div style={{
                    marginBottom: '10px',
                    fontSize: '11px',
                    color: 'var(--text-secondary, #999)',
                    lineHeight: '1.4'
                  }}>
                    ⚠️ {candidateEval.flags.map(f => FLAG_LABELS[f] || f).join(' · ')}
                  </div>
                )}

                {/* Error State */}
                {hasError && (
                  <div style={{
                    padding: '16px',
                    borderRadius: '10px',
                    background: '#ef444415',
                    border: '1px solid #ef444440',
                    color: '#ef4444',
                    fontSize: '13px',
                    textAlign: 'center'
                  }}>
                    ❌ {result.error}
                  </div>
                )}

                {/* No question at this index (agent generated fewer questions) */}
                {hasNoQuestionAtIndex && !hasError && (
                  <div style={{
                    padding: '16px',
                    borderRadius: '10px',
                    background: 'var(--bg-primary, #1a1a2e)',
                    color: 'var(--text-secondary, #999)',
                    fontSize: '13px',
                    textAlign: 'center',
                    fontStyle: 'italic'
                  }}>
                    No question generated at this index
                  </div>
                )}

                {/* Question Display */}
                {question && !hasError && (
                  <div>
                    {/* Question Type Badge */}
                    <div style={{
                      display: 'inline-block',
                      padding: '2px 8px',
                      borderRadius: '4px',
                      fontSize: '11px',
                      fontWeight: '600',
                      background: 'var(--bg-primary, #1a1a2e)',
                      color: 'var(--text-secondary, #999)',
                      marginBottom: '10px'
                    }}>
                      {question.type || 'MCQ'}
                    </div>

                    {isEditing ? (
                      <QuestionEditor
                        question={question}
                        onChange={(updated) => handleQuestionEdit(agentId, updated)}
                      />
                    ) : (
                      <>
                        {/* Question Text */}
                        <div style={{
                          fontSize: '14px',
                          lineHeight: '1.5',
                          color: 'var(--text-primary, #fff)',
                          marginBottom: '12px',
                          fontWeight: '500'
                        }}>
                          {question.question}
                        </div>

                        {/* Options */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '12px' }}>
                          {(question.options || []).map((opt, idx) => (
                            <div
                              key={idx}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '8px',
                                padding: '6px 10px',
                                borderRadius: '6px',
                                background: opt.isCorrect ? '#10b98115' : 'var(--bg-primary, #1a1a2e)',
                                border: opt.isCorrect ? '1px solid #10b98140' : '1px solid transparent',
                                fontSize: '13px',
                                color: 'var(--text-primary, #fff)'
                              }}
                            >
                              <span style={{
                                width: '20px',
                                height: '20px',
                                borderRadius: question.type === 'MSQ' ? '4px' : '50%',
                                border: opt.isCorrect ? '2px solid #10b981' : '2px solid var(--border-color, #444)',
                                background: opt.isCorrect ? '#10b981' : 'transparent',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                fontSize: '10px',
                                color: 'white',
                                flexShrink: 0
                              }}>
                                {opt.isCorrect && '✓'}
                              </span>
                              {opt.text}
                            </div>
                          ))}
                        </div>

                        {/* Explanation */}
                        {question.explanation && (
                          <div style={{
                            padding: '8px 10px',
                            borderRadius: '8px',
                            background: 'var(--bg-primary, #1a1a2e)',
                            fontSize: '12px',
                            color: 'var(--text-secondary, #999)',
                            lineHeight: '1.4',
                            borderLeft: `3px solid ${result.color || '#3b82f6'}`
                          }}>
                            💡 {question.explanation}
                          </div>
                        )}
                      </>
                    )}

                    {/* Action Buttons */}
                    <div style={{
                      display: 'flex',
                      gap: '8px',
                      marginTop: '14px'
                    }}>
                      {!isCurrentLaunched && (
                        <>
                          <button
                            onClick={() => { takeOverSlot(); setEditingAgent(isEditing ? null : agentId) }}
                            style={{
                              flex: 1,
                              padding: '8px',
                              borderRadius: '8px',
                              border: '1px solid var(--border-color, #333)',
                              background: 'transparent',
                              color: 'var(--text-secondary, #999)',
                              fontSize: '12px',
                              cursor: 'pointer'
                            }}
                          >
                            {isEditing ? '✓ Done' : '✏️ Edit'}
                          </button>
                          <button
                            onClick={() => handleSelect(agentId)}
                            style={{
                              flex: 2,
                              padding: '8px',
                              borderRadius: '8px',
                              border: 'none',
                              background: isSelected ? result.color || '#3b82f6' : 'var(--bg-primary, #1a1a2e)',
                              color: isSelected ? 'white' : 'var(--text-primary, #fff)',
                              fontSize: '13px',
                              fontWeight: '600',
                              cursor: 'pointer',
                              transition: 'all 0.2s ease'
                            }}
                          >
                            {isSelected ? '✓ Selected' : 'Select'}
                          </button>
                        </>
                      )}
                      {isCurrentLaunched && isSelected && (
                        <div style={{
                          width: '100%',
                          padding: '8px',
                          borderRadius: '8px',
                          background: '#10b981',
                          color: 'white',
                          fontSize: '13px',
                          fontWeight: '600',
                          textAlign: 'center'
                        }}>
                          ✓ Launched {launchCountdown !== null && launchCountdown > 0 ? `(${launchCountdown}s)` : ''}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* Launch Bar — visible when a question is selected but not yet launched */}
        {selectedAgent && !isCurrentLaunched && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 20px',
            borderRadius: '12px',
            background: `${agentResults[selectedAgent]?.color || '#3b82f6'}15`,
            border: `1px solid ${agentResults[selectedAgent]?.color || '#3b82f6'}40`
          }}>
            <div style={{ fontSize: '14px', color: 'var(--text-primary, #fff)' }}>
              <strong>{agentResults[selectedAgent]?.icon} {agentResults[selectedAgent]?.label}</strong>
              {' '}question selected
            </div>
            <button
              onClick={handleLaunch}
              style={{
                padding: '10px 24px',
                borderRadius: '10px',
                border: 'none',
                background: agentResults[selectedAgent]?.color || '#3b82f6',
                color: 'white',
                fontSize: '14px',
                fontWeight: '700',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                boxShadow: `0 4px 12px ${agentResults[selectedAgent]?.color || '#3b82f6'}40`
              }}
            >
              🚀 Launch to Students
            </button>
          </div>
        )}

        {/* Post-launch: Next Question button or Finish */}
        {isCurrentLaunched && (
          <div style={{
            display: 'flex',
            justifyContent: 'center',
            gap: '12px',
            marginTop: '8px'
          }}>
            {!isLastQuestion ? (
              <button
                onClick={handleNext}
                style={{
                  padding: '10px 24px',
                  borderRadius: '10px',
                  border: 'none',
                  background: '#3b82f6',
                  color: 'white',
                  fontSize: '14px',
                  fontWeight: '600',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px'
                }}
              >
                Next Question →
              </button>
            ) : (
              <button
                onClick={onClose}
                style={{
                  padding: '10px 24px',
                  borderRadius: '10px',
                  border: 'none',
                  background: '#10b981',
                  color: 'white',
                  fontSize: '14px',
                  fontWeight: '600',
                  cursor: 'pointer'
                }}
              >
                ✅ All Done ({launchedIndices.size}/{totalQuestions} launched)
              </button>
            )}
          </div>
        )}

        {/* All agents failed — show clear error state */}
        {sortedAgents.length > 0 && sortedAgents.every(([, r]) => r.error && r.questions.length === 0) && (
          <div style={{
            textAlign: 'center',
            padding: '20px',
            borderRadius: '12px',
            background: '#ef444410',
            border: '1px solid #ef444430',
            marginBottom: '12px'
          }}>
            <div style={{ fontSize: '16px', marginBottom: '8px' }}>❌ All agents failed to generate questions</div>
            <div style={{ fontSize: '13px', color: 'var(--text-secondary, #999)', marginBottom: '12px' }}>
              This can happen due to API rate limits, network issues, or very short transcripts.
            </div>
            <button
              onClick={onRegenerate}
              disabled={isRegenerating}
              style={{
                padding: '10px 20px',
                borderRadius: '8px',
                border: 'none',
                background: '#3b82f6',
                color: 'white',
                fontSize: '14px',
                fontWeight: '600',
                cursor: isRegenerating ? 'not-allowed' : 'pointer',
                opacity: isRegenerating ? 0.5 : 1
              }}
            >
              {isRegenerating ? '⏳ Retrying...' : '🔄 Try Again'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export default MultiAgentQuestionPopup
