// The room's multi-agent launch mode: teacher-selected ('manual', default) or Agent 4's pick
// launched automatically ('auto'). Saved with the rest of the room settings.
import Room from '../models/Room.js'

const errorsFor = (settings) => new Room({ name: 'R', code: 'ABC123', settings }).validateSync()?.errors || {}

describe('Room settings.launchMode', () => {
  it('defaults to manual', () => {
    expect(new Room({ name: 'R' }).settings.launchMode).toBe('manual')
  })

  it('accepts manual and auto', () => {
    expect(errorsFor({ launchMode: 'auto' })['settings.launchMode']).toBeUndefined()
    expect(errorsFor({ launchMode: 'manual' })['settings.launchMode']).toBeUndefined()
  })

  it('rejects any other value', () => {
    expect(errorsFor({ launchMode: 'sometimes' })['settings.launchMode']).toBeDefined()
  })
})
