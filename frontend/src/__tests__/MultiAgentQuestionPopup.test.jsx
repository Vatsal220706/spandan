import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import MultiAgentQuestionPopup from '../components/MultiAgentQuestionPopup'

const q = (text) => ({
  id: text,
  type: 'MCQ',
  question: text,
  options: [{ text: 'A', isCorrect: true }, { text: 'B', isCorrect: false }, { text: 'C', isCorrect: false }, { text: 'D', isCorrect: false }],
  explanation: ''
})

const agentResults = {
  agent_1: { agentId: 'agent_1', label: 'Basic', color: '#f59e0b', icon: '⚡', efficiencyLevel: 60, questions: [q('Basic question?')], error: null },
  agent_3: { agentId: 'agent_3', label: 'Advanced', color: '#10b981', icon: '🧠', efficiencyLevel: 90, questions: [q('Advanced question?')], error: null }
}

const renderPopup = (evaluatorResults, extra = {}) => render(
  <MultiAgentQuestionPopup agentResults={agentResults} evaluatorResults={evaluatorResults} onApprove={jest.fn()} onClose={jest.fn()} onRegenerate={jest.fn()} {...extra} />
)

describe('MultiAgentQuestionPopup evaluator states', () => {
  it('shows a Basic recommendation and selects it via "Use This"', () => {
    renderPopup([{
      questionIndex: 0, status: 'recommended', recommendedAgentId: 'agent_1', score: 88, reasoning: 'Clearest and correct.',
      agentLabel: 'Basic', agentColor: '#f59e0b', agentIcon: '⚡',
      candidates: [
        { agentId: 'agent_1', verdict: 'recommended', score: 88, flags: [] },
        { agentId: 'agent_3', verdict: 'rejected', score: 30, flags: ['invalid_answer'] }
      ]
    }])
    expect(screen.getByText('AI Evaluator Recommends')).toBeTruthy()
    expect(screen.getByText('Score 88/100')).toBeTruthy()
    expect(screen.getByText(/Answer key looks wrong/)).toBeTruthy()
    fireEvent.click(screen.getByText('Use This'))
    expect(screen.getByText(/question selected/)).toBeTruthy()
  })

  it('shows no recommendation (and no star) when no candidate is good enough', () => {
    renderPopup([{
      questionIndex: 0, status: 'no_good_candidate', recommendedAgentId: null, score: null,
      reasoning: 'No candidate met the quality bar.', candidates: []
    }])
    expect(screen.getByText('No Strong Candidate')).toBeTruthy()
    expect(screen.queryByText('Use This')).toBeNull()
    expect(screen.queryByText('⭐ RECOMMENDED')).toBeNull()
  })

  it('shows an unavailable notice when the evaluator failed', () => {
    renderPopup([{ questionIndex: 0, status: 'unavailable', recommendedAgentId: null, reasoning: 'Could not assess.', candidates: [] }])
    expect(screen.getByText('AI Evaluator Unavailable')).toBeTruthy()
    expect(screen.queryByText('Use This')).toBeNull()
  })

  it('still supports the older result format without a status', () => {
    renderPopup([{ questionIndex: 0, recommendedAgentId: 'agent_3', reasoning: 'Best.', agentLabel: 'Advanced', agentColor: '#10b981', agentIcon: '🧠' }])
    expect(screen.getByText('AI Evaluator Recommends')).toBeTruthy()
  })

  it('shows a notice when long input was truncated', () => {
    renderPopup([], { transcriptInfo: { wordCount: 9000, truncated: true, usedWords: 7500 } })
    expect(screen.getByText(/most recent 7,500 words/)).toBeTruthy()
  })
})
