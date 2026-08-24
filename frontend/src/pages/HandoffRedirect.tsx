import { useEffect, useRef, useState } from 'react'
import { doc, onSnapshot } from 'firebase/firestore'
import { colors, typography, layout, spacing } from '@mygames/game-ui'
import { db } from '../firebase'
import { playLinkFor } from '../api'

// ═══════════════════════════════════════════════════════════════════════════════
// THE HAND-OFF, STUDENT SIDE — the one genuinely new screen in the matcher, and the
// whole reason it exists. Every other game plays here; the matcher instead sends the
// student INTO the Beer Game.
//
// A matched group carries a `gameCode` only once the instructor has "started" it (which,
// for the matcher, means it has been provisioned into the Beer Game — see
// functions/src/handoff.ts). So this screen:
//   • matched, no gameCode yet  → "your group is ready, waiting for the instructor to start"
//   • gameCode present          → redirect to the Beer Game's play deep link
//
// It subscribes to the group doc so the redirect happens the instant the hand-off lands,
// with no reload. The redirect is guarded by a ref so React's re-renders (and StrictMode's
// double-invoke in dev) cannot fire it twice.
// ═══════════════════════════════════════════════════════════════════════════════

export default function HandoffRedirect({
  participantId,
  gameInstanceId,
  groupId,
}: {
  participantId: string
  gameInstanceId: string
  groupId: string
}) {
  const [error, setError] = useState<string | null>(null)
  const redirected = useRef(false)

  useEffect(() => {
    const ref = doc(db, 'game_instances', gameInstanceId, 'groups', groupId)
    const unsub = onSnapshot(
      ref,
      (snap) => {
        const gameCode = snap.exists() ? (snap.data()?.gameCode as string | undefined) : undefined
        if (gameCode && !redirected.current) {
          redirected.current = true
          window.location.href = playLinkFor(gameCode, participantId)
        }
      },
      (e) => setError(e instanceof Error ? e.message : 'Could not read your group.'),
    )
    return () => unsub()
  }, [gameInstanceId, groupId, participantId])

  return (
    <main
      data-testid="handoff-redirect"
      style={{ padding: layout.pagePad, maxWidth: layout.contentWidth, margin: '0 auto', fontFamily: typography.fontFamily }}
    >
      <h1 style={{ marginTop: 0 }}>Your group is ready</h1>
      <p style={{ lineHeight: 1.6, color: colors.textSecondary, marginBottom: spacing.gapMd }}>
        You&apos;ve been placed in a group. As soon as your instructor starts the game, this
        page will take you straight into it — no need to refresh.
      </p>
      <p data-testid="handoff-waiting" style={{ color: colors.textMuted }}>
        Waiting for the game to start…
      </p>
      {error && <p role="alert" style={{ color: '#c00', marginTop: spacing.gapSm }}>{error}</p>}
    </main>
  )
}
