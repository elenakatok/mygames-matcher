import { useCallback, useEffect, useState } from 'react'
import { colors, typography, spacing } from '@mygames/game-ui'
import { getOnlineGroups, groupParticipantsOnline, type OnlineGroup, type OnlineOccupant } from '../api'

// ═══════════════════════════════════════════════════════════════════════════════
// THE ONLINE INSTRUCTOR CONTROL — pre-group the whole roster before anyone logs in.
//
// ⚠ SIMPLER THAN THE STAGE GAMES' VERSION, ON PURPOSE. A stage game bot-fills a short
// group itself (there is no one else to play the empty seat). The matcher does NOT: it
// hands off HUMAN members and the Beer Game fills its own empty seats with bots. So a
// short group of, say, 2 students is fine — it just needs to be TOPPED UP to full so the
// shared `startAllGroups` (which only hands off full groups) will hand it off, and that
// top-up is a per-group action on each group's row in the Groups panel, not a roster-wide
// button here. So this panel is ONE button: form the groups.
//
// It pre-groups the WHOLE roster (including students who have not logged in yet) — that is
// the online flow: the instructor groups everyone in advance, then students arrive into a
// group that already exists.
// ═══════════════════════════════════════════════════════════════════════════════

/** The label the control strip promises. Change both or neither — see the strip. */
export const GROUP_BUTTON_LABEL = 'Group participants'
const REGROUP_BUTTON_LABEL = 'Re-group participants'

const btn: React.CSSProperties = {
  padding: '0.35rem 0.8rem', fontWeight: 700, borderRadius: 4,
  border: `1px solid ${colors.borderMid}`, cursor: 'pointer',
}

export default function OnlineMatchControl({ onChanged }: { onChanged?: () => void }) {
  const [groups, setGroups] = useState<OnlineGroup[]>([])
  const [pool, setPool] = useState<OnlineOccupant[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const r = await getOnlineGroups()
      setGroups(r.groups ?? [])
      setPool(r.no_group ?? [])
      setError(null)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [])

  useEffect(() => {
    void refresh()
    const t = setInterval(() => { void refresh() }, 3000)
    return () => clearInterval(t)
  }, [refresh])

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true); setError(null); setNote(null)
    try {
      const r = await fn() as Record<string, unknown>
      await refresh()
      onChanged?.()
      return r
    } catch (e) {
      setError(`${label}: ${e instanceof Error ? e.message : String(e)}`)
      return null
    } finally { setBusy(false) }
  }

  // "started" here means handed off (seats_locked_at set at hand-off) — the instance-wide
  // regroup lock, mirrored from the server so the button disables the moment it would fail.
  const anyStarted = groups.some((g) => g.started)
  const grouped = groups.reduce((n, g) => n + g.occupants.length, 0)
  const short = groups.filter((g) => g.free_seats > 0)

  return (
    <section data-testid="online-match-control" style={{ marginTop: spacing.gapSm }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: spacing.gapSm, flexWrap: 'wrap' }}>
        <button
          data-testid="online-group-participants"
          style={{ ...btn, background: anyStarted ? colors.white : '#15803d',
                   color: anyStarted ? colors.textMuted : colors.white,
                   opacity: anyStarted ? 0.6 : 1,
                   cursor: busy || anyStarted ? 'not-allowed' : 'pointer' }}
          disabled={busy || anyStarted}
          onClick={() => act('Grouping', async () => {
            const r = await groupParticipantsOnline()
            setNote(`${r.groups} group(s) formed from ${r.total_humans} student(s)` +
              (r.short_group_size ? ` — one group of ${r.short_group_size}` : ''))
            return r
          })}
        >
          {busy ? 'Working…' : groups.length === 0 ? GROUP_BUTTON_LABEL : REGROUP_BUTTON_LABEL}
        </button>

        {anyStarted && (
          <span data-testid="online-locked-note" style={{ fontSize: typography.sizeXs, color: colors.textMuted }}>
            A group has been handed off — regrouping is locked.
          </span>
        )}
      </div>

      {note && <p data-testid="online-note" style={{ margin: `${spacing.gapSm} 0 0`, fontSize: typography.sizeXs, color: colors.textSecondary }}>{note}</p>}
      {error && <p role="alert" data-testid="online-error" style={{ margin: `${spacing.gapSm} 0 0`, fontSize: typography.sizeXs, color: '#b91c1c' }}>{error}</p>}

      <p style={{ margin: `${spacing.gapSm} 0 0`, fontSize: typography.sizeXs, color: colors.textSecondary }}>
        {grouped} student(s) grouped
        {short.length > 0 && ` · ${short.length} group(s) still short a seat — top up to hand off`}
        {pool.length > 0 && ` · ${pool.length} in no group`}
      </p>
    </section>
  )
}
