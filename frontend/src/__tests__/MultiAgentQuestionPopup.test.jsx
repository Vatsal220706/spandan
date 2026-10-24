import React from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import MultiAgentQuestionPopup, { AUTO_LAUNCH_DELAY_S } from '../components/MultiAgentQuestionPopup'

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

describe('MultiAgentQuestionPopup auto-launch', () => {
  const twoSlotResults = {
    agent_1: { agentId: 'agent_1', label: 'Basic', color: '#f59e0b', icon: '⚡', efficiencyLevel: 60, questions: [q('Basic Q1?'), q('Basic Q2?')], error: null },
    agent_3: { agentId: 'agent_3', label: 'Advanced', color: '#10b981', icon: '🧠', efficiencyLevel: 90, questions: [q('Advanced Q1?'), q('Advanced Q2?')], error: null }
  }
  const rec = (questionIndex, agentId, status = 'recommended') => ({
    questionIndex, status, recommendedAgentId: status === 'unavailable' ? null : agentId, score: 80, reasoning: 'Best.',
    agentLabel: agentId, agentColor: '#000', agentIcon: '*', candidates: []
  })
  const tick = (seconds) => { for (let i = 0; i < seconds; i++) act(() => { jest.advanceTimersByTime(1000) }) }
  const renderAuto = (evaluatorResults, extra = {}) => {
    const onApprove = jest.fn()
    render(
      <MultiAgentQuestionPopup agentResults={twoSlotResults} evaluatorResults={evaluatorResults} launchMode="auto"
        roomSettings={{ timeToAnswer: 5, points: 100 }} onApprove={onApprove} onClose={jest.fn()} onRegenerate={jest.fn()} {...extra} />
    )
    return onApprove
  }

  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('launches Agent 4\'s recommended question after the countdown', () => {
    const onApprove = renderAuto([rec(0, 'agent_3'), rec(1, 'agent_1')])
    expect(screen.getByText(/Launching/)).toBeTruthy()
    tick(AUTO_LAUNCH_DELAY_S - 1)
    expect(onApprove).not.toHaveBeenCalled()
    tick(1)
    expect(onApprove).toHaveBeenCalledTimes(1)
    expect(onApprove.mock.calls[0][0].question).toBe('Advanced Q1?')
    expect(onApprove.mock.calls[0][1].agentId).toBe('agent_3')
  })

  it('moves to the next question when the answer time ends and launches its recommendation', () => {
    const onApprove = renderAuto([rec(0, 'agent_3'), rec(1, 'agent_1')])
    tick(AUTO_LAUNCH_DELAY_S)        // slot 1 launches
    tick(5)                          // its 5s answer time ends → advance
    tick(AUTO_LAUNCH_DELAY_S)        // slot 2 launches
    expect(onApprove).toHaveBeenCalledTimes(2)
    expect(onApprove.mock.calls[1][0].question).toBe('Basic Q2?')
  })

  it.each(['needs_review', 'no_good_candidate', 'unavailable'])('waits for the teacher when Agent 4 says %s', (status) => {
    const onApprove = renderAuto([rec(0, 'agent_3', status)])
    tick(AUTO_LAUNCH_DELAY_S + 2)
    expect(onApprove).not.toHaveBeenCalled()
    expect(screen.getByText(/Auto-launch is waiting/)).toBeTruthy()
  })

  it('Cancel stops the auto-launch for that question', () => {
    const onApprove = renderAuto([rec(0, 'agent_3')])
    fireEvent.click(screen.getByText('Cancel'))
    tick(AUTO_LAUNCH_DELAY_S + 2)
    expect(onApprove).not.toHaveBeenCalled()
    expect(screen.getByText(/you took over this question/)).toBeTruthy()
  })

  it('selecting a different card takes over the slot', () => {
    const onApprove = renderAuto([rec(0, 'agent_3')])
    fireEvent.click(screen.getAllByText('Select')[0]) // Basic's card
    tick(AUTO_LAUNCH_DELAY_S + 2)
    expect(onApprove).not.toHaveBeenCalled()
  })

  it('never auto-launches in manual mode', () => {
    const onApprove = renderAuto([rec(0, 'agent_3')], { launchMode: 'manual' })
    tick(AUTO_LAUNCH_DELAY_S + 2)
    expect(onApprove).not.toHaveBeenCalled()
    expect(screen.queryByTestId('auto-launch-bar')).toBeNull()
  })
})
