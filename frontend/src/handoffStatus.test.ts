import { describe, expect, it } from 'vitest'
import type { OnlineGroup, StartAllResult } from './api'
import { confirmText, joinNames, reportLines, statusLine, waitingGroups, willHandOff } from './handoffStatus'

const occ = (id: string, name: string, is_bot = false) => ({ participant_id: id, display_name: name, email: null, is_bot })
const full = (n: number, handoff: OnlineGroup['handoff']): OnlineGroup => ({
  group_id: `g${n}`, group_number: n, started: false, seat_count: 4, free_seats: 0,
  occupants: [occ('a', 'Ana'), occ('b', 'Ben'), occ('c', 'Cy'), occ('d', 'Honeydew Austin')], handoff,
})
const waiting = full(2, { status: 'waiting', waiting: [{ participant_id: 'd', display_name: 'Honeydew Austin' }] })
const ready = full(1, { status: 'ready', waiting: [] })

describe('joinNames', () => {
  it('reads as a sentence', () => {
    expect(joinNames(['Ana'])).toBe('Ana')
    expect(joinNames(['Ana', 'Ben'])).toBe('Ana and Ben')
    expect(joinNames(['Ana', 'Ben', 'Cy'])).toBe('Ana, Ben and Cy')
  })
})

describe('the row', () => {
  it('names the student a full group is waiting on, and never says ready', () => {
    expect(statusLine(waiting)).toBe('full — waiting on Honeydew Austin to log in')
    expect(statusLine(waiting)).not.toMatch(/ready/)
  })
  it('a fully logged-in full group is still ready', () => {
    expect(statusLine(ready)).toBe('full — ready to hand off')
  })
  it('short and handed-off rows are unchanged', () => {
    expect(statusLine({ ...ready, free_seats: 1, occupants: ready.occupants.slice(0, 3) })).toBe('3 of 4 — short 1 seat')
    expect(statusLine({ ...ready, started: true, handoff: { status: 'handed_off', waiting: [] } })).toBe('handed off — in the Beer Game')
  })
})

describe('what Start will hand off', () => {
  it('follows the server plan, not the seat count', () => {
    expect(willHandOff(waiting)).toBe(false)
    expect(willHandOff(ready)).toBe(true)
  })
  it('falls back to seat count only for a server with no plan', () => {
    expect(willHandOff({ ...waiting, handoff: undefined })).toBe(true)
  })
})

describe('the confirm dialog', () => {
  it('counts only the groups that will start, and names what is skipped and why', () => {
    const t = confirmText(1, waitingGroups([ready, waiting]))
    expect(t).toMatch(/^Start the Beer Game for 1 ready group\?/)
    expect(t).toMatch(/Group 2 is waiting on Honeydew Austin to log in\./)
  })
  it('says nothing extra when nothing is waiting', () => {
    expect(confirmText(2, [])).toBe('Start the Beer Game for 2 ready groups?')
  })
})

describe('the report after the call', () => {
  it('names what was handed off and every skip with its reason', () => {
    const r: StartAllResult = {
      ok: true, started: 1, skipped_waiting: 1, skipped_short: 1, already_running: 1,
      groups: [
        { group_id: 'g1', group_number: 1, outcome: 'started', waiting: [] },
        { group_id: 'g2', group_number: 2, outcome: 'skipped_waiting', waiting: [{ participant_id: 'd', display_name: 'Honeydew Austin' }] },
        { group_id: 'g3', group_number: 3, outcome: 'skipped_short', waiting: [] },
        { group_id: 'g4', group_number: 4, outcome: 'already_running', waiting: [] },
      ],
    }
    expect(reportLines(r)).toEqual([
      '1 handed off — group 1',
      'Group 2 not started — waiting on Honeydew Austin to log in.',
      'Group 3 not started — not full; fill its empty seats first.',
    ])
  })
  it('"0 handed off" is never the whole story when a group was skipped', () => {
    const r: StartAllResult = {
      ok: true, started: 0, skipped_waiting: 1,
      groups: [{ group_id: 'g2', group_number: 2, outcome: 'skipped_waiting', waiting: [{ participant_id: 'd', display_name: 'Honeydew Austin' }] }],
    }
    expect(reportLines(r)).toEqual(['0 handed off', 'Group 2 not started — waiting on Honeydew Austin to log in.'])
  })
})
