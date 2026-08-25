import React, { useState } from 'react'
import { SEATS_PER_GROUP_WORD } from '../groupSize'
import { doc, getDoc } from 'firebase/firestore'
import { auth, db, rtdb } from '../firebase'
import { assignRole, confirmReady, verifyAttendanceCode, recordLogin, CLASSROOM_URL } from '../api'
import { useEffect, useRef } from 'react'
import {
  useStudentSession,
  GameHeader,
  WaitingRoom,
  typography,
  colors,
  layout,
  spacing,
} from '@mygames/game-ui'
import type { BootstrapArgs } from '@mygames/game-ui'
import OnlineGroupReveal from '../game/OnlineGroupReveal'
import HandoffRedirect from './HandoffRedirect'

/**
 * The display name, used on the no-token screen.
 */
const GAME_TITLE = 'The Beer Game'

// ── Phase state ───────────────────────────────────────────────────────────────
//
// THE SHARED PRE-GAME FLOW, minus what the matcher does not own. There is NO info page,
// NO knowledge check and NO prep here: the matcher only MATCHES, then hands the group off
// to the Beer Game, which is where a student actually plays. So the flow is the standard
// join path — hold → confirmation → attendance code → waiting room (in class) or
// online_holding (online) — and then, at 'matched', the student is REDIRECTED into the
// Beer Game rather than shown a play screen (see HandoffRedirect).
//
// Roles are assigned by the GUEST GAME at hand-off, so nothing role-specific is ever shown.
type GamePhase =
  | { name: 'loading' }
  | { name: 'error';           message: string }
  | { name: 'hold' }
  | { name: 'confirmation' }
  | { name: 'attendance-code' }
  | { name: 'waiting-room' }
  | { name: 'online_holding' }   // ONLINE: pre-grouped at deploy, but not handed off yet
  | { name: 'matched';         groupId: string }

// The per-instance clock/mode setting. 'off' = ONLINE (no attendance code, no waiting
// room, group reveal on login); 'on' = CLASSROOM. recordLogin returns this.
type Mode = 'on' | 'off'

// ── Phase routing ─────────────────────────────────────────────────────────────

// Returns the underlying phase PLUS, in online mode, the group to reveal first (the reveal
// is a gate layered in front of the phase). Classroom routing (mode 'on') is the standard
// join path; online (mode 'off') skips the attendance code and waiting room.
async function routeToPhase(
  participantId: string,
  gameInstanceId: string,
  mode: Mode,
): Promise<{ phase: GamePhase; revealGroupId: string | null }> {
  const snap = await getDoc(
    doc(db, 'game_instances', gameInstanceId, 'participants', participantId),
  )
  const d = snap.data() ?? {}

  // ── Read the group once (if any) — used for both the online detection and the reveal ──
  let group: Record<string, unknown> | undefined
  if (d.group_id) {
    const gsnap = await getDoc(doc(db, 'game_instances', gameInstanceId, 'groups', d.group_id as string))
    group = gsnap.exists() ? (gsnap.data() as Record<string, unknown>) : undefined
  }
  const isOnlineGroup = Array.isArray(group?.members)

  // ⚠ ONLINE STUDENTS MUST NEVER SEE THE ATTENDANCE-CODE / "I'm in class" SCREENS. A student
  // who has been placed in an ONLINE-FORMED group (it carries members[]) is, by definition,
  // in an online session — so route them online even if the mode signal came back 'on' (a
  // flaky recordLogin, or the instructor flipping to online after the student loaded). This
  // is what makes online play bypass the code screen reliably.
  const effectiveMode: Mode = mode === 'off' || isOnlineGroup ? 'off' : 'on'

  // ── Underlying phase ────────────────────────────────────────────────────────
  let phase: GamePhase
  if (effectiveMode === 'off') {
    // ONLINE: no attendance code, no waiting room. Grouped → hand-off screen; not yet → holding.
    phase = d.group_id ? { name: 'matched', groupId: d.group_id as string } : { name: 'online_holding' }
  } else {
    // CLASSROOM — standard join routing.
    if (!d.confirmed_ready_at)            phase = { name: 'hold' }
    else if (!d.attendance_confirmed_at)  phase = { name: 'confirmation' }
    else if (!d.group_id)                 phase = { name: 'waiting-room' }
    else                                  phase = { name: 'matched', groupId: d.group_id as string }
  }

  // ── Online reveal gate: a pre-grouped student sees their group first, until it locks ──
  // Only for a group formed by online grouping (members[]); seats_locked_at is stamped at
  // hand-off, so the reveal shows until the group is handed off to the Beer Game.
  let revealGroupId: string | null = null
  if (effectiveMode === 'off' && d.group_id && isOnlineGroup && group?.seats_locked_at == null) {
    revealGroupId = d.group_id as string
  }

  return { phase, revealGroupId }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function Play() {
  const p       = new URLSearchParams(window.location.search)
  const token   = p.get('token')
  const testPid = import.meta.env.DEV ? p.get('_pid') : null
  const testGid = import.meta.env.DEV ? p.get('_gid') : null

  const [phase, setPhase]             = useState<GamePhase>({ name: 'loading' })
  const [revealGroupId, setRevealGroupId] = useState<string | null>(null)
  const revealDismissed               = useRef(false)
  const [confError,   setConfError]   = useState<string | null>(null)
  const [confLoading, setConfLoading] = useState(false)
  const [codeValue,   setCodeValue]   = useState('')
  const [codeError,   setCodeError]   = useState<string | null>(null)
  const [codeLoading, setCodeLoading] = useState(false)

  // ── Session lifecycle ────────────────────────────────────────────────────

  const session = useStudentSession({
    auth,
    token,
    testIds: (testPid && testGid) ? { participantId: testPid, gameInstanceId: testGid } : null,
    bootstrap: async (args: BootstrapArgs) => {
      const r = await assignRole(args)
      return {
        participantId:  r.participant_id,
        gameInstanceId: r.game_instance_id,
        customToken:    r.customToken,
      }
    },
  })

  // ── Phase routing ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (session.kind !== 'ready') return
    const { participantId, gameInstanceId } = session
    let cancelled = false

    const run = async () => {
      // Session establishment: stamp last_login_at (best-effort) and learn the mode. On any
      // failure we fall back to 'on' (the classroom flow), so a transient recordLogin error
      // never strands a classroom student.
      let m: Mode = 'on'
      try {
        const rec = await recordLogin()
        m = rec.clock_mode === 'off' ? 'off' : 'on'
      } catch { /* best-effort; default to classroom routing */ }
      if (cancelled) return

      let res: { phase: GamePhase; revealGroupId: string | null }
      try {
        res = await routeToPhase(participantId, gameInstanceId, m)
      } catch (err) {
        if (!cancelled) setPhase({ name: 'error', message: err instanceof Error ? err.message : 'Failed to load session.' })
        return
      }
      if (cancelled) return
      setPhase(res.phase)
      setRevealGroupId(m === 'off' && res.revealGroupId && !revealDismissed.current ? res.revealGroupId : null)
    }

    void run()
    return () => { cancelled = true }
  }, [session])

  // ── Render: pre-session states (no header) ────────────────────────────────

  if (session.kind === 'loading' || (session.kind === 'ready' && phase.name === 'loading')) {
    return (
      <main style={{ padding: '2rem', fontFamily: typography.fontFamily }}>
        <p>Loading…</p>
      </main>
    )
  }

  if (session.kind === 'no-token') {
    return (
      <main style={{ padding: '2rem', fontFamily: typography.fontFamily, maxWidth: '480px', margin: '2rem auto' }}>
        <h2 style={{ marginBottom: '0.75rem' }}>{GAME_TITLE}</h2>
        <p>Please launch this game from the classroom to join a session.</p>
        <p style={{ marginTop: '1.5rem' }}><a href={CLASSROOM_URL}>← Go to classroom</a></p>
      </main>
    )
  }

  if (session.kind === 'error') {
    return (
      <main style={{ padding: '2rem', fontFamily: typography.fontFamily }}>
        <p style={{ color: '#c00' }}>{session.message}</p>
        <p><a href={CLASSROOM_URL}>← Return to classroom</a></p>
      </main>
    )
  }

  if (phase.name === 'error') {
    return (
      <main style={{ padding: '2rem', fontFamily: typography.fontFamily }}>
        <p style={{ color: '#c00' }}>{phase.message}</p>
        <p><a href={CLASSROOM_URL}>← Return to classroom</a></p>
      </main>
    )
  }

  const { participantId, gameInstanceId } = session

  // ── Join handlers ──────────────────────────────────────────────────────────

  const handleConfirmReady = () => {
    setConfLoading(true)
    setConfError(null)
    confirmReady({})
      .then(() => setPhase({ name: 'attendance-code' }))
      .catch((err: unknown) => {
        setConfError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
        setConfLoading(false)
      })
  }

  const handleAttendanceCode = (e: React.FormEvent) => {
    e.preventDefault()
    const code = codeValue.trim()
    if (code.length < 4) return
    setCodeLoading(true)
    setCodeError(null)
    verifyAttendanceCode({}, code)
      .then(() => setPhase({ name: 'waiting-room' }))
      .catch((err: unknown) => {
        setCodeError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
        setCodeLoading(false)
      })
  }

  // ── Render: session ready — header persists across all phases ─────────────

  // Online reveal GATE: shown in front of the underlying phase until the student continues
  // (or the group is handed off / locks).
  if (revealGroupId) {
    return (
      <div style={{ fontFamily: typography.fontFamily }}>
        <GameHeader />
        <OnlineGroupReveal
          gameInstanceId={gameInstanceId}
          groupId={revealGroupId}
          participantId={participantId}
          onContinue={() => { revealDismissed.current = true; setRevealGroupId(null) }}
        />
      </div>
    )
  }

  return (
    <div style={{ fontFamily: typography.fontFamily }}>
      <GameHeader />

      {phase.name === 'online_holding' && (
        <main style={{ padding: layout.pagePad, maxWidth: layout.contentWidth, margin: '0 auto' }}>
          <h1 style={{ marginTop: 0 }}>Not in a group yet</h1>
          <p data-testid="online-holding" style={{ lineHeight: 1.6, color: colors.textSecondary }}>
            You are not in a group yet. This page will update when your instructor
            forms them.
          </p>
        </main>
      )}

      {phase.name === 'hold' && (
        <main style={{ padding: layout.pagePad, maxWidth: layout.contentWidth, margin: '0 auto' }}>
          <h1 style={{ marginTop: 0 }}>Ready to begin</h1>
          <p style={{ lineHeight: 1.6, marginBottom: spacing.gapSm }}>
            When class begins and your instructor starts the session, you&apos;ll be placed
            in a group of {SEATS_PER_GROUP_WORD} and taken into the game.
          </p>
          <p style={{ color: colors.textSecondary, marginBottom: layout.pagePad }}>
            You can close this tab and come back later — your place is saved.
          </p>
          <button onClick={() => setPhase({ name: 'confirmation' })}>
            I&apos;m in class — continue
          </button>
        </main>
      )}

      {phase.name === 'confirmation' && (
        <main style={{ padding: layout.pagePad, maxWidth: layout.contentWidth, margin: '0 auto' }}>
          <h1 style={{ marginTop: 0 }}>Ready to play?</h1>
          <p style={{ lineHeight: 1.6, marginBottom: spacing.gapSm }}>
            You&apos;ll be placed in a group of {SEATS_PER_GROUP_WORD}. Only continue if you are in class and
            ready to take part right now.
          </p>
          {confError && (
            <p style={{ color: '#c00', marginBottom: spacing.gapSm }}>{confError}</p>
          )}
          <div style={{ display: 'flex', gap: spacing.gapBtn }}>
            <button onClick={handleConfirmReady} disabled={confLoading}>
              {confLoading ? 'Confirming…' : "Yes, I'm ready"}
            </button>
            <button
              onClick={() => setPhase({ name: 'hold' })}
              disabled={confLoading}
              style={{ background: 'none', border: '1px solid #ccc' }}
            >
              Not now
            </button>
          </div>
        </main>
      )}

      {phase.name === 'attendance-code' && (
        <main style={{ padding: layout.pagePad, maxWidth: '540px', margin: '0 auto' }}>
          <h1 style={{ marginTop: 0 }}>Enter attendance code</h1>
          <p style={{ lineHeight: 1.6, marginBottom: layout.pagePad }}>
            Enter the code your instructor is displaying.
          </p>
          <form onSubmit={handleAttendanceCode}>
            <input
              value={codeValue}
              onChange={e => setCodeValue(e.target.value.toUpperCase())}
              maxLength={6}
              placeholder="e.g. ABJKM"
              autoFocus
              autoCapitalize="characters"
              spellCheck={false}
              disabled={codeLoading}
              style={{
                fontSize:     '2rem',
                letterSpacing: '0.25em',
                width:         '100%',
                padding:       '0.5rem 0.75rem',
                boxSizing:     'border-box',
                fontFamily:    'monospace',
                textTransform: 'uppercase',
              }}
            />
            {codeError && (
              <p style={{ color: '#c00', marginTop: '0.75rem' }}>{codeError}</p>
            )}
            <button
              type="submit"
              disabled={codeLoading || codeValue.trim().length < 4}
              style={{ marginTop: spacing.gapMd }}
            >
              {codeLoading ? 'Checking…' : 'Submit'}
            </button>
          </form>
        </main>
      )}

      {phase.name === 'waiting-room' && (
        <WaitingRoom
          participantId={participantId}
          gameInstanceId={gameInstanceId}
          db={db}
          rtdb={rtdb}
          onMatched={(groupId) => setPhase({ name: 'matched', groupId })}
        />
      )}

      {phase.name === 'matched' && (
        <HandoffRedirect
          participantId={participantId}
          gameInstanceId={gameInstanceId}
          groupId={phase.groupId}
        />
      )}
    </div>
  )
}
