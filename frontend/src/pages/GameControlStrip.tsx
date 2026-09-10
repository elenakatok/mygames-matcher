import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { onAuthStateChanged } from 'firebase/auth'
import { authInstructor as auth } from '../firebase'
import { SEATS_PER_GROUP } from '../groupSize'
import { GroupsPanel, MoveMemberControl, colors, typography, spacing, type GroupsPanelRow } from '@mygames/game-ui'
import OnlineMatchControl, { GROUP_BUTTON_LABEL } from './OnlineMatchControl'
import PanelBoundary from './PanelBoundary'
import {
  getGameConfig, setClockMode, getOnlineGroups, moveSeat, topUpGroupWithBots, startAllGroups,
  type OnlineGroup,
} from '../api'

// ═══════════════════════════════════════════════════════════════════════════════
// THE INSTRUCTOR'S CONTROL STRIP — session mode, Start (= hand-off), and live per-group
// status. Rendered in the shared dashboard's `underHeadline` slot, above the roster.
//
// ⚠ NO ROUND LOOP HERE, so it is SIMPLER than a stage game's strip. A stage game merges
// two calls per row — `getGameDashboard` (round/stage/who-owes) with `getOnlineGroups`
// (seats). The matcher has no round loop and no `getGameDashboard`: a group is either
// waiting to be handed off, or already in the Beer Game. So this strip reads ONE call,
// `getOnlineGroups`, and a row's status is just that binary.
//
// ── "START" MEANS HAND OFF ───────────────────────────────────────────────────
// `startAllGroups` provisions every ready (full, not-yet-handed-off) group into the Beer
// Game and stores its game code, which is what releases each student's redirect. It is
// re-pressable: a later press hands off groups that filled since.
//
// ⚠ THE MATCHER NEEDS "START" IN BOTH MODES. A stage game auto-opens an online group's
// round as its seats arrive, so online has no Start button. The matcher has no such
// trigger — nothing hands a group off until the instructor presses Start — so the button
// is shown in classroom AND online.
//
// ── SHORT GROUPS ─────────────────────────────────────────────────────────────
// `startAllGroups` only hands off FULL groups. A short group (fewer than four real
// students) is topped up to full with placeholder seats on its own row; the hand-off drops
// those placeholders and the Beer Game bot-fills instead. So a short group is handed off by
// first pressing "Fill … with placeholders" on its row, then Start.
// ═══════════════════════════════════════════════════════════════════════════════

const POLL_MS = 4000

function statusLine(g: OnlineGroup): string {
  if (g.started) return 'handed off — in the Beer Game'
  if (g.free_seats > 0) return `${g.occupants.length} of ${g.seat_count} — short ${g.free_seats} seat${g.free_seats === 1 ? '' : 's'}`
  return 'full — ready to hand off'
}

function StartClass({ readyCount, onDone }: { readyCount: number; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [summary, setSummary] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const go = async () => {
    if (readyCount === 0 || busy) return
    if (!window.confirm(`Start the Beer Game for all ${readyCount} ready group${readyCount === 1 ? '' : 's'}?`)) return
    setBusy(true); setErr(null)
    try {
      const r = await startAllGroups()
      setSummary(`${r.started} handed off`)
      onDone()
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not hand off.') }
    setBusy(false)
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: spacing.gapSm }}>
      <button
        data-testid="start-class"
        onClick={go}
        disabled={busy || readyCount === 0}
        title={readyCount === 0 ? 'No full groups are ready to hand off.' : `Hand off ${readyCount} ready group${readyCount === 1 ? '' : 's'}.`}
        style={{ padding: '0.35rem 0.8rem', fontWeight: 700, cursor: busy || readyCount === 0 ? 'not-allowed' : 'pointer', borderRadius: 4, border: `1px solid ${colors.borderMid}`, background: readyCount === 0 ? colors.white : '#15803d', color: readyCount === 0 ? colors.textMuted : colors.white, opacity: readyCount === 0 ? 0.6 : 1 }}
      >
        {busy ? 'Starting…' : 'Start the game'}
      </button>
      {summary && <span data-testid="start-class-summary" style={{ fontSize: typography.sizeXs, color: colors.textSecondary }}>{summary}</span>}
      {err && <span data-testid="start-class-error" role="alert" style={{ fontSize: typography.sizeXs, color: '#b91c1c' }}>{err}</span>}
    </span>
  )
}

export default function GameControlStrip() {
  const [clockMode, setClockMode_] = useState<string | null>(null)
  const [modeSaving, setModeSaving] = useState(false)
  const [seats, setSeats] = useState<OnlineGroup[]>([])
  const [pool, setPool] = useState<{ participant_id: string; display_name: string }[]>([])
  const [error, setError] = useState<string | null>(null)
  const [everLoaded, setEverLoaded] = useState(false)
  const failures = useRef(0)

  // Nothing goes out until the instructor session exists — the shared dashboard mounts
  // this slot before the session lands, and an unauthenticated call answers "Missing token".
  const [sessionReady, setSessionReady] = useState(false)
  useEffect(() => onAuthStateChanged(auth, (u) => setSessionReady(!!u)), [])

  const STARTUP_GRACE = 4

  const refresh = useCallback(async () => {
    try {
      const online = await getOnlineGroups()
      setSeats(online.groups ?? [])
      setPool(online.no_group ?? [])
      setError(null)
      setEverLoaded(true)
      failures.current = 0
    } catch (e) {
      failures.current += 1
      const msg = e instanceof Error ? e.message : String(e)
      if (everLoaded || failures.current > STARTUP_GRACE) setError(msg)
    }
  }, [everLoaded])

  useEffect(() => {
    if (!sessionReady) return
    void (async () => {
      try { setClockMode_((await getGameConfig()).clock_mode ?? 'on') } catch { setClockMode_('on') }
    })()
    void refresh()
    const t = setInterval(() => { void refresh() }, POLL_MS)
    return () => clearInterval(t)
  }, [refresh, sessionReady])

  const online = clockMode === 'off'
  const anyStarted = seats.some((g) => g.started)
  // Ready to hand off = full and not yet handed off.
  const readyCount = seats.filter((g) => !g.started && g.free_seats === 0).length

  /*
    Destinations for the No-Group pool and per-group moves: not-started groups with a free
    seat OR a placeholder seat to evict (moving a stranded student into a full-with-placeholder
    group evicts the placeholder and gives them a real group).
  */
  const destinations = useMemo(
    () => seats
      .filter((s) => !s.started && (s.free_seats > 0 || s.occupants.some((o) => o.is_bot)))
      .map((s) => ({
        id: s.group_id,
        number: s.group_number ?? null,
        replacesBot: s.free_seats === 0,
      })),
    [seats],
  )

  const place = async (participantId: string, dest: string) => {
    setError(null)
    try { await moveSeat(participantId, dest === 'new' ? 'new' : dest); await refresh() }
    catch (e) { setError(`Place: ${e instanceof Error ? e.message : 'failed'}`) }
  }

  const move = async (participantId: string, dest: string) => {
    setError(null)
    try { await moveSeat(participantId, dest); await refresh() }
    catch (e) { setError(`Move: ${e instanceof Error ? e.message : 'failed'}`) }
  }

  const rows: GroupsPanelRow[] = seats.map((g) => {
    const bots = g.occupants.filter((o) => o.is_bot).length
    const humanMembers = g.occupants
      .filter((o) => !o.is_bot)
      .map((o) => ({ participantId: o.participant_id, name: o.display_name }))
    return {
      key: g.group_id,
      number: g.group_number,
      status: statusLine(g),
      live: g.started,
      filled: g.occupants.length,
      seatCount: g.seat_count ?? SEATS_PER_GROUP,
      bots,
      // Handed off == seats locked (seats_locked_at set at hand-off). GroupsPanel renders
      // "🔒 locked" instead of the move/fill actions, freezing a group that is already in
      // the Beer Game while its not-yet-handed-off siblings stay rearrangeable.
      locked: g.started,
      actions: !g.started
        ? (
          <>
            <MoveMemberControl
              testId={`group-actions-${g.group_number}`}
              groupNumber={g.group_number}
              members={humanMembers}
              destinations={destinations.filter((d) => d.id !== g.group_id)}
              onMove={move}
            />
            {g.free_seats > 0 && (
              <TopUp groupId={g.group_id} seats={g.free_seats} onDone={refresh} onError={setError} />
            )}
          </>
        )
        : undefined,
    }
  })

  const chooseMode = async (m: 'on' | 'off') => {
    if (m === clockMode || modeSaving || anyStarted) return
    setModeSaving(true); setError(null)
    try {
      const c = await setClockMode(m)
      setClockMode_(c.clock_mode === 'off' ? 'off' : 'on')
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not change mode.') }
    setModeSaving(false)
  }
  const modeBtn = (active: boolean): React.CSSProperties => ({
    padding: '0.4rem 0.9rem', fontWeight: 600, cursor: anyStarted ? 'not-allowed' : 'pointer',
    borderRadius: 4, border: `1px solid ${active ? colors.text : colors.borderLight}`,
    background: active ? colors.text : colors.white,
    color: active ? colors.white : colors.textSecondary,
    opacity: anyStarted && !active ? 0.5 : 1,
  })

  return (
    <>
    <div
      data-testid="session-mode-switch"
      style={{ margin: '0 0 1rem', padding: '0.6rem 1rem', border: `1px solid ${colors.borderMid}`,
               borderRadius: 8, background: colors.surfaceSubtle, fontFamily: typography.fontFamily }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: spacing.gapMd, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700 }}>Session mode:</span>
        <div style={{ display: 'flex', gap: spacing.gapSm }}
             title={anyStarted ? 'A group has been handed off — mode is locked for this session.' : ''}>
          <button data-testid="mode-classroom" style={modeBtn(clockMode === 'on')}
            disabled={modeSaving || clockMode === null || anyStarted}
            onClick={() => chooseMode('on')}>Classroom — attendance code</button>
          <button data-testid="mode-online" style={modeBtn(clockMode === 'off')}
            disabled={modeSaving || clockMode === null || anyStarted}
            onClick={() => chooseMode('off')}>Online — pre-grouped</button>
        </div>
        {clockMode && (
          <span style={{ fontSize: typography.sizeXs, color: colors.textSecondary }}>
            {clockMode === 'on'
              ? 'Students confirm attendance with a code, then Match Now groups those present.'
              : 'Pre-group the whole roster; students arrive into a group that already exists.'}
          </span>
        )}
        {anyStarted && <span style={{ fontSize: typography.sizeXs, color: colors.textMuted }}>Locked — a group has been handed off.</span>}
      </div>
    </div>

    <GroupsPanel
      testId="game-control-strip"
      rows={rows}
      noGroup={pool.map((p) => ({ participantId: p.participant_id, name: p.display_name }))}
      destinations={destinations}
      onPlace={place}
      headerActions={
        seats.length > 0 ? <StartClass readyCount={readyCount} onDone={refresh} /> : undefined
      }
      emptyMessage={
        !everLoaded && !error
          ? <span data-testid="control-strip-loading">Connecting…</span>
          : online ? `Press “${GROUP_BUTTON_LABEL}” to form groups.`
          : 'Match students into groups to begin.'
      }
      footer={
        error ? <p role="alert" data-testid="control-error" style={{ color: '#b91c1c', fontSize: typography.sizeXs, margin: `${spacing.gapSm} 0 0` }}>{error}</p> : undefined
      }
    >
      {online && (
        <PanelBoundary name="Online grouping">
          <OnlineMatchControl onChanged={refresh} />
        </PanelBoundary>
      )}
    </GroupsPanel>
    </>
  )
}

/** Fill this group's empty seats with placeholder seats so a short group can be handed off. */
function TopUp({
  groupId, seats, onDone, onError,
}: { groupId: string; seats: number; onDone: () => void; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false)
  return (
    <button
      data-testid={`strip-fill-${groupId}`}
      disabled={busy}
      style={{ fontSize: typography.sizeXs }}
      onClick={async () => {
        setBusy(true)
        try { await topUpGroupWithBots(groupId); onDone() }
        catch (e) { onError(`Fill: ${e instanceof Error ? e.message : 'failed'}`) }
        setBusy(false)
      }}
    >Fill {seats} seat{seats === 1 ? '' : 's'} with placeholders</button>
  )
}
