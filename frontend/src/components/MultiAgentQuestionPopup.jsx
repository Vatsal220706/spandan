import React, { useState } from 'react'
import QuestionEditor from './QuestionEditor'

/**
 * MultiAgentQuestionPopup
 *
 * Full-screen overlay showing questions from all agents side-by-side.
 * The teacher can compare, edit, select one, and launch it to students.
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
  const [selectedAgent, setSelectedAgent] = useState(null)
  const [editingAgent, setEditingAgent] = useState(null)
  const [editedQuestions, setEditedQuestions] = useState({}) // agentId -> edited question
  const [launched, setLaunched] = useState(false)
  const [launchCountdown, setLaunchCountdown] = useState(null)

  // Sort agents by efficiency level
  const sortedAgents = Object.entries(agentResults)
    .sort(([, a], [, b]) => (a.efficiencyLevel || 0) - (b.efficiencyLevel || 0))

  // Get the question for an agent (edited version if available, otherwise original)
  const getQuestion = (agentId) => {
    if (editedQuestions[agentId]) return editedQuestions[agentId]
    const result = agentResults[agentId]
    return result?.questions?.[0] || null
  }

  // Handle question edit
  const handleQuestionEdit = (agentId, updatedQuestion) => {
    setEditedQuestions(prev => ({ ...prev, [agentId]: updatedQuestion }))
  }

  // Handle select
  const handleSelect = (agentId) => {
    setSelectedAgent(agentId === selectedAgent ? null : agentId)
  }

  // Handle launch
  const handleLaunch = () => {
    if (!selectedAgent) return
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

    setLaunched(true)

    // Start countdown timer
    const timer = roomSettings.timeToAnswer || 30
    setLaunchCountdown(timer)
    const interval = setInterval(() => {
      setLaunchCountdown(prev => {
        if (prev <= 1) {
          clearInterval(interval)
          return 0
        }
        return prev - 1
      })
    }, 1000)

    onApprove(launchQuestion, { agentId: selectedAgent, ...agentInfo })
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
          marginBottom: '24px'
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
              disabled={isRegenerating || launched}
              style={{
                padding: '8px 16px',
                borderRadius: '8px',
                border: '1px solid var(--border-color, #333)',
                background: 'var(--bg-secondary, #2a2a3e)',
                color: 'var(--text-primary, #fff)',
                fontSize: '13px',
                cursor: (isRegenerating || launched) ? 'not-allowed' : 'pointer',
                opacity: (isRegenerating || launched) ? 0.5 : 1
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
                  opacity: (launched && !isSelected) ? 0.4 : 1
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
                        {result.elapsed ? `${result.elapsed}s` : ''} {result.questions.length > 0 ? '• Generated' : ''}
                      </div>
                    </div>
                  </div>
                  {/* Efficiency Badge */}
                  <span style={{
                    padding: '3px 10px',
                    borderRadius: '20px',
                    fontSize: '12px',
                    fontWeight: '700',
                    background: `${result.color || '#3b82f6'}20`,
                    color: result.color || '#3b82f6',
                    border: `1px solid ${result.color || '#3b82f6'}40`
                  }}>
                    {result.efficiencyLevel || '?'}%
                  </span>
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
                      {!launched && (
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
                      {launched && isSelected && (
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

        {/* Launch Bar */}
        {selectedAgent && !launched && (
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

        {/* Post-launch: Next Question / Finish */}
        {launched && launchCountdown === 0 && (
          <div style={{
            display: 'flex',
            justifyContent: 'center',
            gap: '12px',
            marginTop: '8px'
          }}>
            <button
              onClick={onClose}
              style={{
                padding: '10px 24px',
                borderRadius: '10px',
                border: 'none',
                background: '#3b82f6',
                color: 'white',
                fontSize: '14px',
                fontWeight: '600',
                cursor: 'pointer'
              }}
            >
              📋 Finish
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export default MultiAgentQuestionPopup
