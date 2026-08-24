import { useEffect, useState } from 'react'
import { doc, onSnapshot } from 'firebase/firestore'
import { colors, typography, layout, spacing } from '@mygames/game-ui'
import { db } from '../firebase'
import type { OnlineMember } from '../api'
import OnlineMemberList from './OnlineMemberList'

// ═══════════════════════════════════════════════════════════════════════════════
// OnlineGroupReveal — the screen an ONLINE student lands on right after login: who is in
// their group (name + email) so they can reach each other and schedule a time to play.
//
// Reads members[] straight off the group doc (denormalized at grouping time): no RTDB
// attending overlay, no email plumbing. LIVE via onSnapshot so a re-group before hand-off
// is reflected without a reload.
// ═══════════════════════════════════════════════════════════════════════════════

export default function OnlineGroupReveal({
  gameInstanceId,
  groupId,
  participantId,
  onContinue,
}: {
  gameInstanceId: string
  groupId: string
  participantId: string
  onContinue: () => void
}) {
  const [members, setMembers] = useState<OnlineMember[] | null>(null)

  useEffect(() => {
    const ref = doc(db, 'game_instances', gameInstanceId, 'groups', groupId)
    const unsub = onSnapshot(ref, (snap) => {
      const m = snap.exists() ? (snap.data()?.members as OnlineMember[] | undefined) : undefined
      setMembers(Array.isArray(m) ? m : [])
    }, () => setMembers([]))
    return () => unsub()
  }, [gameInstanceId, groupId])

  return (
    <main
      data-testid="online-reveal"
      style={{ padding: layout.pagePad, maxWidth: layout.contentWidth, margin: '0 auto', fontFamily: typography.fontFamily }}
    >
      <h1 style={{ marginTop: 0 }}>Your group</h1>
      <p style={{ lineHeight: 1.6, marginBottom: spacing.gapMd }}>
        You’ll play with the people below. This is an online section, so there’s no
        set class time — <strong>reach out to your group, agree on a time, and play the whole
        game together in one sitting.</strong> Roles are assigned when the
        game begins.
      </p>

      <OnlineMemberList members={members ?? []} participantId={participantId} />

      {members && members.length <= 1 && (
        <p style={{ color: colors.textSecondary, marginBottom: spacing.gapMd }}>
          You’re on your own for now — your instructor may add others (or stand-in players) before
          the game begins. Check back here; this list stays current.
        </p>
      )}

      <button data-testid="reveal-continue" onClick={onContinue} style={{ marginTop: spacing.gapSm }}>
        Continue
      </button>
    </main>
  )
}
