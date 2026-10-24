import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'

jest.mock('../services/questionService', () => ({
  getAIProviders: jest.fn().mockResolvedValue({ success: true, providers: [] })
}))

import RoomSettingsModal from '../components/RoomSettingsModal'

const base = { questionsPerSegment: 3, difficulty: 'medium', multiAgentEnabled: true, activeAgents: ['agent_1', 'agent_2', 'agent_3'] }

describe('RoomSettingsModal question launch mode', () => {
  it('defaults to teacher selection and saves the auto-launch choice', () => {
    const onSave = jest.fn()
    render(<RoomSettingsModal isOpen settings={base} onSave={onSave} onClose={jest.fn()} />)
    expect(screen.getByText(/Teacher selects/).closest('button').getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByText(/Auto-launch Agent 4/))
    fireEvent.click(screen.getByText('Save Settings'))
    expect(onSave.mock.calls[0][0].launchMode).toBe('auto')
  })

  it('hides the launch choice when multi-agent generation is off', () => {
    render(<RoomSettingsModal isOpen settings={{ ...base, multiAgentEnabled: false }} onSave={jest.fn()} onClose={jest.fn()} />)
    expect(screen.queryByText(/Auto-launch Agent 4/)).toBeNull()
  })
})
