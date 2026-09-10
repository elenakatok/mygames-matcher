// ═══════════════════════════════════════════════════════════════════════════════
// WHAT THE INSTRUCTOR IS TOLD ABOUT "START" — the group row, the confirm dialog, and the
// report after the call.
//
// ⚠ WHY THIS EXISTS. In production (2026-09-10) a group read "full — ready to hand off 4/4",
// the dialog said "Start the Beer Game for all 1 ready group?", the instructor clicked OK, and
// nothing happened: startAllGroups had (correctly) skipped the group because one member had
// not logged in, returned success, and the screen said "0 handed off". Seat count and
// readiness are different questions, and the reason sat nowhere near the action.
//
// Everything here is formatted from the SERVER's plan — getOnlineGroups' `handoff` and
// startAllGroups' `groups` — never re-derived, so the row, the dialog and the outcome cannot
// disagree with what Start actually does. Pure, so it is unit-tested (handoffStatus.test.ts).
// ═══════════════════════════════════════════════════════════════════════════════
import type { OnlineGroup, StartAllResult, WaitingMember } from './api'

/** "Ana" · "Ana and Ben" · "Ana, Ben and Cy". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

export const waitingOn = (w: WaitingMember[]): string =>
  `waiting on ${joinNames(w.map((m) => m.display_name))} to log in`

/** The group row's status text. */
export function statusLine(g: OnlineGroup): string {
  if (g.started) return 'handed off — in the Beer Game'
  if (g.free_seats > 0) return `${g.occupants.length} of ${g.seat_count} — short ${g.free_seats} seat${g.free_seats === 1 ? '' : 's'}`
  if (g.handoff?.status === 'waiting') return `full — ${waitingOn(g.handoff.waiting)}`
  return 'full — ready to hand off'
}

/**
 * Start will hand this group off. The server's plan decides; seat count is only the fallback
 * for a server that predates the plan (the old behaviour, not a second opinion).
 */
export function willHandOff(g: OnlineGroup): boolean {
  if (g.handoff) return g.handoff.status === 'ready'
  return !g.started && g.free_seats === 0
}

export type WaitingGroup = { number: number; waiting: WaitingMember[] }

/** Full groups Start will skip because a member has not logged in. */
export function waitingGroups(groups: OnlineGroup[]): WaitingGroup[] {
  return groups
    .filter((g) => !g.started && g.handoff?.status === 'waiting')
    .map((g) => ({ number: g.group_number, waiting: g.handoff?.waiting ?? [] }))
}

export const waitingSentence = (w: WaitingGroup): string => `Group ${w.number} is ${waitingOn(w.waiting)}.`

const groupsWord = (n: number): string => `${n} ready group${n === 1 ? '' : 's'}`

/** The confirm dialog: the count that will ACTUALLY hand off, and what will be skipped and why. */
export function confirmText(readyCount: number, waiting: WaitingGroup[]): string {
  const head = `Start the Beer Game for ${groupsWord(readyCount)}?`
  if (waiting.length === 0) return head
  return `${head}\n\nNot included — a group starts only once every member has logged in:\n` +
    waiting.map((w) => `• ${waitingSentence(w)}`).join('\n') +
    '\n\nPress Start again after they log in.'
}

const groupList = (nums: number[]): string =>
  nums.length === 1 ? `group ${nums[0]}` : `groups ${joinNames(nums.map(String))}`

/** The report after the call: what was handed off, and every group that was not, with why. */
export function reportLines(r: StartAllResult): string[] {
  const started = (r.groups ?? []).filter((g) => g.outcome === 'started').map((g) => g.group_number)
  const lines = [`${r.started} handed off${started.length ? ` — ${groupList(started)}` : ''}`]
  for (const g of r.groups ?? []) {
    if (g.outcome === 'skipped_waiting') lines.push(`Group ${g.group_number} not started — ${waitingOn(g.waiting)}.`)
    if (g.outcome === 'skipped_short') lines.push(`Group ${g.group_number} not started — not full; fill its empty seats first.`)
  }
  // A server that predates per-group outcomes still reports its counters.
  if (!r.groups && (r.skipped_waiting ?? 0) > 0) {
    lines.push(`${r.skipped_waiting} group${r.skipped_waiting === 1 ? '' : 's'} waiting for a member to log in.`)
  }
  return lines
}
