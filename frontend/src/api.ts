import { httpsCallable, type Functions } from 'firebase/functions'
import { FirebaseError } from 'firebase/app'
import { functions, functionsInstructor } from './firebase'

// ═══════════════════════════════════════════════════════════════════════════════
// THE MATCHER'S CALLABLE SURFACE — front-of-house ONLY.
//
// ⚠ THIS IS DELIBERATELY SMALLER THAN A NORMAL GAME'S api.ts. The matcher matches and
// HANDS OFF; it never plays a round, scores, runs a knowledge check, or writes reports.
// Every one of those callables lives in the GUEST GAME (the Beer Game), not here — so
// there is no getGameDashboard/openRound/getRoundView/submit*, no getReportData, no KC,
// and no finalizeInstance/pushResultsToClassroom (the Beer Game pushes participation
// grades directly to the classroom). If you find yourself adding one, it probably belongs
// in the guest game.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * DEV ONLY: the `_dev_game_instance_id` the dashboard bootstraps with, threaded into
 * every instructor call. The shared dashboard establishes a Firebase session from that
 * query param, but the per-game instructor callables resolve their instance from the
 * CALL, not the session, so without this they answer "Missing token" against a good
 * session. In production the param does not exist and nothing is added.
 */
function devArgs(): object {
  if (!import.meta.env.DEV) return {}
  const iid = new URLSearchParams(window.location.search).get('_dev_game_instance_id')
  return iid ? { _dev: { game_instance_id: iid } } : {}
}

async function callOn<T>(instance: Functions, name: string, data: object = {}): Promise<T> {
  data = { ...devArgs(), ...data }
  const fn = httpsCallable<object, T>(instance, name)
  const result = await fn(data)
  return result.data
}

// ⚠ TWO Firebase apps (see firebase.ts): student callables must go through the STUDENT app
// and instructor callables through the INSTRUCTOR app, or the token attached is the wrong
// session's. callFn = student; callFnInstructor = instructor.
const callFn = <T>(name: string, data: object = {}) => callOn<T>(functions, name, data)
const callFnInstructor = <T>(name: string, data: object = {}) => callOn<T>(functionsInstructor, name, data)

// ── Types ─────────────────────────────────────────────────────────────────────

export type TestArgs   = { _test: { participant_id: string; game_instance_id: string } }
export type TokenArgs  = { token: string }
export type BearerArgs = Record<string, never>   // empty — auth is in Authorization header
export type CallArgs   = TestArgs | TokenArgs | BearerArgs

export type AssignRoleResult = {
  ok:               boolean
  role:             string
  customToken:      string
  participant_id:   string
  game_instance_id: string
}

export const CLASSROOM_URL = import.meta.env.DEV
  ? 'http://localhost:5173'
  : 'https://classroom.mygames.live'

/*
 * ⚠ NO PLAY ORIGIN IN THE FRONTEND (D12 — "One source of truth for the play URL").
 * This file used to hold PLAY_URL (from VITE_PLAY_URL), a dead playLinkFor, and
 * reportLinkFor — a second copy of the guest's origin that could drift silently from the one
 * students are actually sent to. All three are gone. Student links are minted by getSeatLink;
 * the instructor report link is written onto the group doc at hand-off (`report_url`); both
 * come from functions/src/tenants.ts playUrl.
 */

/**
 * Mint this student's short-lived signed deep link into the guest game (D2).
 * Called on every render of the redirect screen, so an expiry measured in seconds costs
 * nothing — see functions/src/seatToken.ts for why it is 120s.
 */
export const getSeatLink = (args: CallArgs = {} as BearerArgs) =>
  callFn<{ url: string; expires_in: number }>('getSeatLink', args)

// onCall auth errors arrive as FirebaseError with code 'functions/permission-denied'
// or 'functions/unauthenticated' — not HTTP status strings.
export function isAuthError(err: unknown): boolean {
  if (!(err instanceof FirebaseError)) return false
  return (
    err.code === 'functions/permission-denied' ||
    err.code === 'functions/unauthenticated'
  )
}

// ── Student API ─────────────────────────────────────────────────────────────────

/** Bootstrap — no session yet; classroom JWT or _test bypass travels in data. */
export const assignRole = (args: CallArgs) =>
  callFn<AssignRoleResult>('assignRole', args)

export const confirmReady = (args: CallArgs) =>
  callFn<{ ok: boolean }>('confirmReady', args)

export const verifyAttendanceCode = (args: CallArgs, code: string) =>
  callFn<{ ok: boolean }>('verifyAttendanceCode', { ...args, code })

// recordLogin: stamps last_login_at server-side AND returns clock_mode so the UI can
// pick online vs classroom routing (config is server-only-readable). Called once on
// session establishment, both modes.
export const recordLogin = (args: CallArgs = {} as BearerArgs) =>
  callFn<{ ok: boolean; clock_mode: string; group_id: string | null }>('recordLogin', args)

// "I can't reach my group" flag — writes a passive flag on the student's group and
// returns the group number + instructor_email for the mailto To:.
export const flagGroup = (args: CallArgs = {} as BearerArgs) =>
  callFn<{ ok: boolean; already_flagged: boolean; group_number: number; instructor_email: string | null }>('flagGroup', args)

// ── Clock-mode control (per-instance setting; instructor sets before matching) ──
export type GameConfig = { ok: boolean; clock_mode?: string; instructor_email?: string }
export const getGameConfig = () => callFnInstructor<GameConfig>('getGameConfig', {})
export const setClockMode = (mode: 'on' | 'off') => callFnInstructor<GameConfig>('updateGameConfig', { clock_mode: mode })

// ── Instructor API ────────────────────────────────────────────────────────────

export type InstructorSessionArgs =
  | { token: string }
  | { _dev: { game_instance_id: string } }

/** Bootstrap — no session yet; JWT travels in data; SDK attaches nothing. */
export const getInstructorSession = (args: InstructorSessionArgs) =>
  callFnInstructor<{ ok: boolean; customToken: string }>('getInstructorSession', args)

/** Remaining instructor calls: SDK auto-attaches Firebase Bearer when session exists. */
export const syncRoster = () =>
  callFnInstructor<{ ok: boolean; synced: number; skipped: number }>('syncRoster', {})

export const generateAttendanceCode = () =>
  callFnInstructor<{ ok: boolean; code: string }>('generateAttendanceCode', {})

// The classroom matcher: forms full groups of `groupSize` from present, eligible
// students (shared triggerMatching; keys on attendance + presence). A remainder < groupSize
// is left in the No-Group pool — top it up to full with placeholder seats to hand it off.
export const triggerMatching = () =>
  callFnInstructor<{ ok: boolean; groups: unknown[]; alreadyMatched?: boolean }>('triggerMatching', {})

// ── Online-mode instructor grouping + seat management ────────────────────────────

/** One seat as the getOnlineGroups callable returns it. */
export type OnlineOccupant = {
  participant_id: string
  display_name:   string
  email:          string | null
  is_bot:         boolean
}
export type OnlineGroup = {
  group_id:     string
  group_number: number
  started:      boolean
  seat_count:   number
  free_seats:   number
  occupants:    OnlineOccupant[]
  /**
   * Whether Start will hand this group off, and if not, why — from the SAME plan
   * startAllGroups decides with (functions/src/handoffPlan.ts). Seat count alone is not
   * readiness: online, a full group still waits until every human has logged in.
   */
  handoff?:     GroupHandOff | null
}

export type HandOffStatus = 'handed_off' | 'short' | 'waiting' | 'ready'
export type WaitingMember = { participant_id: string; display_name: string }
export type GroupHandOff = { status: HandOffStatus; waiting: WaitingMember[] }
export type HandOffOutcome = 'started' | 'already_running' | 'skipped_short' | 'skipped_waiting'
/** startAllGroups' reply: the counters it always returned, plus what it did with each group. */
export type StartAllResult = {
  ok: boolean
  started: number
  skipped_short?: number
  skipped_waiting?: number
  already_running?: number
  groups?: Array<{ group_id: string; group_number: number; outcome: HandOffOutcome; waiting: WaitingMember[] }>
}

/**
 * The group-reveal DOCUMENT's member shape — a Firestore doc the student screen reads.
 * ⚠ NOT the same as OnlineOccupant: the callable returns `occupants`, the group doc
 * carries `members`.
 */
export type OnlineMember = { participant_id: string; display_name: string; email: string | null }

/** Pre-form random groups from the whole roster (online mode; re-runnable until the first handoff). */
export const groupParticipantsOnline = () =>
  callFnInstructor<{ ok: boolean; groups: number; full_groups: number; short_group_size: number | null; total_humans: number }>(
    'groupParticipantsOnline', {})

/** The online groups (with members) + the No-Group pool, for the grouping panel. */
export const getOnlineGroups = () =>
  callFnInstructor<{ ok: boolean; seat_count: number; groups: OnlineGroup[]; no_group: OnlineOccupant[] }>(
    'getOnlineGroups', {})

/** Move a human into another group (both modes; rejected once a group is handed off / locked).
 *  If the destination is full but has a placeholder seat, the move evicts one — evicted_bot names it. */
export const moveSeat = (participantId: string, targetGroupId: string) =>
  callFnInstructor<{ ok: boolean; moved: boolean; evicted_bot?: string | null }>('moveSeat', { participant_id: participantId, target_group_id: targetGroupId })

/**
 * Fill a group's empty seats with placeholder seats so a SHORT group can be handed off.
 *
 * ⚠ THIS IS HOW A SHORT GROUP REACHES THE GUEST GAME. `startAllGroups` only hands off
 * groups that are FULL (`occupants.length === seatCount`), so a group of 2 real students
 * would be skipped forever. Topping it up to `seatCount` with placeholder seats makes it
 * "full" — and the hand-off EXCLUDES those placeholders (functions/src/handoff.ts), so the
 * Beer Game receives only the real students and fills the rest with its own bots. The
 * placeholder seats never reach the guest game.
 */
export const topUpGroupWithBots = (groupId: string) =>
  callFnInstructor<{ ok: boolean; added: number }>('topUpGroupWithBots', { group_id: groupId })

/**
 * The ONE "Start class" control — shared, idempotent, re-pressable. For the matcher,
 * "starting" a group HANDS IT OFF to the guest game (provisions a Beer Game session and
 * stores its gameCode on the group). A later press hands off groups that became ready
 * since, and skips groups already handed off.
 */
export const startAllGroups = () =>
  callFnInstructor<StartAllResult>('startAllGroups', {})

// ── End-of-assignment operational report — "who arrived / who is in a game" ──
export type GroupCategory = 'finished' | 'in_progress' | 'never_started'
export type OnlineReportGroup = {
  groupId: string
  groupNumber: number
  category: GroupCategory
  humanCount: number
  botCount: number
  flagged: boolean
  flagStale: boolean
  reporterName: string | null
  rounds: number
}
export type OnlineReportStudent = {
  participantId: string
  name: string
  groupNumber: number | null
  category: GroupCategory | 'no_group'
  arrived: boolean | null
  lastLoginMs: number | null
  flagged: boolean
  playedWithBots: boolean
  absences: number
  rounds: number | null
}
export type OnlineReport = {
  ok: boolean
  absence_label: string
  arrival_data_present: boolean
  counts: { finished: number; inProgress: number; neverStarted: number; flagged: number }
  groups: OnlineReportGroup[]
  students: OnlineReportStudent[]
}
export const getOnlineReport = () => callFnInstructor<OnlineReport>('getOnlineReport', {})
