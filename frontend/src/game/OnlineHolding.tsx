import { useEffect, useRef } from 'react'
import { doc, onSnapshot } from 'firebase/firestore'
import { colors, layout } from '@mygames/game-ui'
import { db } from '../firebase'

// ═══════════════════════════════════════════════════════════════════════════════
// ONLINE HOLDING — shown to an online student who is not in a group yet.
//
// LIVE. It subscribes to the student's own participant doc and, the moment group_id
// appears, hands control back to Play (onGrouped), which re-runs routeToPhase. It replaces
// 764a1a4's stopgap, which told the student to reload because the branch was static text
// behind a routeToPhase that read the doc ONCE.
//
// ⚠ The exit condition is participants/<pid>.group_id ALONE. gameCode is NOT this screen's
// exit: it is the exit of the NEXT screen, HandoffRedirect, which already subscribes to it.
// ⚠ onGrouped must re-run routeToPhase(…, 'off') AND apply the reveal gate. Setting phase
// 'matched' directly — WaitingRoom's classroom onMatched pattern — skips the reveal.
//
// Deliberately a per-game copy, NOT game-ui's WaitingRoom: that registers RTDB presence (read
// only by classroom matching), carries the attendance-code-only latecomer_absent branch, and
// has classroom copy — none of which apply online. Modelled on grays2's
// phases/OnlineWaiting.tsx.
// ═══════════════════════════════════════════════════════════════════════════════

export default function OnlineHolding({
  participantId,
  gameInstanceId,
  onGrouped,
}: {
  participantId: string
  gameInstanceId: string
  /** Re-route now that the student has a group. Resolves when the attempt is over. */
  onGrouped: () => Promise<void>
}) {
  const onGroupedRef = useRef(onGrouped)
  onGroupedRef.current = onGrouped
  const inFlight = useRef(false)

  // The first snapshot fires immediately, so a group formed between routeToPhase's read and
  // this mount is still caught. No permanent latch: if a re-route fails, this screen stays
  // mounted and the next change to the doc tries again. A successful one unmounts it.
  useEffect(() => {
    const ref = doc(db, 'game_instances', gameInstanceId, 'participants', participantId)
    return onSnapshot(
      ref,
      (snap) => {
        const groupId = snap.data()?.['group_id']
        if (typeof groupId !== 'string' || !groupId || inFlight.current) return
        inFlight.current = true
        void onGroupedRef.current().finally(() => { inFlight.current = false })
      },
      (err) => console.error('[OnlineHolding] participant subscription failed', err),
    )
  }, [participantId, gameInstanceId])

  return (
    <main style={{ padding: layout.pagePad, maxWidth: layout.contentWidth, margin: '0 auto' }}>
      <h1 style={{ marginTop: 0 }}>Not in a group yet</h1>
      <p data-testid="online-holding" style={{ lineHeight: 1.6, color: colors.textSecondary }}>
        You are not in a group yet. This page will update by itself when your instructor
        forms the groups.
      </p>
    </main>
  )
}
