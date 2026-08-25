import { useEffect, useMemo, useState } from 'react'
import { signInWithCustomToken, signOut, setPersistence, browserSessionPersistence } from 'firebase/auth'
import { collection, onSnapshot } from 'firebase/firestore'
import { authInstructor, dbInstructor } from '../firebase'
import { getInstructorSession, reportLinkFor, CLASSROOM_URL } from '../api'
import { colors, typography, spacing } from '@mygames/game-ui'

// ═══════════════════════════════════════════════════════════════════════════════
// The matcher's Reports page — reached from the dashboard's "Reports →" button, like every
// other game. One group's report at a time, chosen from a dropdown (the Crisis pattern:
// Reports.tsx "By group (selector)"). The report CONTENT lives in the Beer Game (its own
// project), so it is embedded in an <iframe> pointing at the Beer Game's read-only report
// page (?report=<gameCode>). Only groups that have been HANDED OFF (carry a gameCode) have a
// report; the dropdown lists exactly those.
//
// Session: this page needs the instructor session to read the group docs. It resumes the
// existing instructor_<gid> session (the dashboard navigates here in-SPA, so it is already
// signed in), and falls back to exchanging the launch token — the same guard the dashboard
// uses, so a cold load / refresh of /reports still works.
// ═══════════════════════════════════════════════════════════════════════════════

type Group = { number: number; gameCode: string }

export default function MatcherReports() {
  const p       = new URLSearchParams(window.location.search)
  const devGid  = import.meta.env.DEV ? p.get('_dev_game_instance_id') : null
  const token   = p.get('token')
  const gid     = devGid ?? p.get('game_instance_id')

  const [ready, setReady]   = useState(false)
  const [error, setError]   = useState<string | null>(null)
  const [groups, setGroups] = useState<Group[]>([])
  const [sel, setSel]       = useState(0)

  // ── Resume (or exchange for) the instructor session ──────────────────────────
  useEffect(() => {
    let cancelled = false
    const establish = async () => {
      await authInstructor.authStateReady()
      if (cancelled) return
      const expectedUid = gid ? `instructor_${gid}` : null
      if (authInstructor.currentUser && expectedUid && authInstructor.currentUser.uid === expectedUid) {
        setReady(true); return
      }
      if (authInstructor.currentUser) { await signOut(authInstructor); if (cancelled) return }
      const args = devGid ? { _dev: { game_instance_id: devGid } } : token ? { token } : null
      if (!args) { setError('No launch token — open Reports from the dashboard.'); return }
      try {
        const r = await getInstructorSession(args)
        if (p.get('_session') === 'tab') await setPersistence(authInstructor, browserSessionPersistence)
        await signInWithCustomToken(authInstructor, r.customToken)
        if (!cancelled) setReady(true)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to establish session.')
      }
    }
    void establish()
    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── The handed-off groups (numbered exactly as the dashboard numbers them: group ids
  //    sorted, index + 1) — only those carrying a gameCode have a report. ──────────
  useEffect(() => {
    if (!ready || !gid) return
    const unsub = onSnapshot(
      collection(dbInstructor, 'game_instances', gid, 'groups'),
      (snap) => {
        const sorted = snap.docs.slice().sort((a, b) => a.id.localeCompare(b.id))
        const list: Group[] = []
        sorted.forEach((d, i) => {
          const code = (d.data() as Record<string, unknown>)['gameCode']
          if (typeof code === 'string' && code) list.push({ number: i + 1, gameCode: code })
        })
        setGroups(list)
        setSel((s) => (s < list.length ? s : 0))
      },
      (e) => setError(e instanceof Error ? e.message : String(e)),
    )
    return () => unsub()
  }, [ready, gid])

  const iframeSrc = useMemo(() => (groups[sel] ? reportLinkFor(groups[sel].gameCode) : null), [groups, sel])

  const wrap: React.CSSProperties = { maxWidth: 1000, margin: '0 auto', padding: `1.5rem ${spacing.gapLg ?? '1.5rem'}`, fontFamily: typography.fontFamily }

  if (error) {
    return (
      <main style={wrap}>
        <h1 style={{ marginTop: 0 }}>Reports — The Beer Game</h1>
        <p style={{ color: '#c00' }}>{error}</p>
        <p><a href={CLASSROOM_URL}>← Return to classroom</a></p>
      </main>
    )
  }
  if (!ready) return <main style={wrap}><p>Loading…</p></main>

  return (
    <main style={wrap}>
      <h1 style={{ marginTop: 0, marginBottom: spacing.gapSm }}>Reports — The Beer Game</h1>
      <p style={{ color: colors.textSecondary, marginTop: 0 }}>
        Orders and inventory over time, by group. Pick a group to see its report.
      </p>

      {groups.length === 0 ? (
        <p data-testid="reports-empty" style={{ color: colors.textSecondary }}>
          No groups have been handed off yet. Start a group from the dashboard, and its report
          appears here once it&apos;s in the Beer Game.
        </p>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: spacing.gapSm, margin: `${spacing.gapMd} 0` }}>
            <label htmlFor="report-group" style={{ fontWeight: 600 }}>Group:</label>
            <select
              id="report-group"
              data-testid="report-group-select"
              value={sel}
              onChange={(e) => setSel(Number(e.target.value))}
              style={{ fontSize: typography.sizeSm, padding: '0.3rem 0.5rem', borderRadius: 4, border: `1px solid ${colors.borderMid}` }}
            >
              {groups.map((g, i) => <option key={g.gameCode} value={i}>Group {g.number}</option>)}
            </select>
          </div>

          {iframeSrc && (
            <iframe
              data-testid="report-frame"
              key={iframeSrc}
              src={iframeSrc}
              title={`Beer Game report — Group ${groups[sel]?.number}`}
              style={{ width: '100%', height: '70vh', border: `1px solid ${colors.border}`, borderRadius: 8, background: colors.white }}
            />
          )}
        </>
      )}
    </main>
  )
}
