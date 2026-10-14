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
 *   agentResults   — { agent_1: { questions, label, color, icon, error, elapsed }, ... }
 *   onApprove      — (question, agentInfo) => void — called when teacher selects & launches
 *   onClose        — () => void
 *   onRegenerate   — () => void — re-run all agents
 *   isRegenerating — boolean
 *   roomSettings   — { timeToAnswer, points, ... }
 */
function MultiAgentQuestionPopup({
  agentResults = {},
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

  // Clean up countdown interval on unmount
  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
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

  // Handle select
  const handleSelect = (agentId) => {
    if (isCurrentLaunched) return
    setSelectedAgent(agentId === selectedAgent ? null : agentId)
  }

  // Handle launch
  const handleLaunch = () => {
    if (!selectedAgent || isCurrentLaunched) return
    const question = getQuestion(selectedAgent)
    if (!question) return

    const agentInfo = agentResults[selectedAgent]
    const launchQuestion = {
      ...question,
      timeToAnswer: roomSettings.timeToAnswer || 30,
      points: roomSettings.points || 100,
      agent: selectedAgent,
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

    onApprove(launchQuestion, { agentId: selectedAgent, ...agentInfo })
  }

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
            const hasError = !!result.error && result.questions.length === 0
            const hasNoQuestionAtIndex = !question && !hasError

            return (
              <div
                key={agentId}
                style={{
                  borderRadius: '14px',
                  border: isSelected
                    ? `2px solid ${result.color || '#3b82f6'}`
                    : '2px solid var(--border-color, #333)',
                  background: isSelected
                    ? `${result.color || '#3b82f6'}08`
                    : 'var(--bg-secondary, #2a2a3e)',
                  padding: '18px',
                  transition: 'all 0.2s ease',
                  position: 'relative',
                  opacity: (isCurrentLaunched && !isSelected) ? 0.4 : 1
                }}
              >
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
                </div>

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
                            onClick={() => setEditingAgent(isEditing ? null : agentId)}
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
