import { colors, typography, spacing } from '@mygames/game-ui'
import type { OnlineMember } from '../api'

// ═══════════════════════════════════════════════════════════════════════════════
// OnlineMemberList — the group-member presentation used by the online group reveal:
// full list, display name + email as a mailto link. One source of markup.
// ═══════════════════════════════════════════════════════════════════════════════

const MAILTO_SUBJECT = encodeURIComponent(`The Beer Game — scheduling a time to play`)

export default function OnlineMemberList({
  members, participantId,
}: {
  members: OnlineMember[]
  participantId: string
}) {
  return (
    <ul
      data-testid="member-list"
      style={{ listStyle: 'none', padding: 0, margin: `${spacing.gapMd} 0`, display: 'grid', gap: spacing.gapSm }}
    >
      {members.map((m) => {
        const isYou = m.participant_id === participantId
        return (
          <li
            key={m.participant_id}
            data-testid="member-item"
            style={{
              padding: `${spacing.gapSm} ${spacing.gapMd}`,
              border: `1px solid ${colors.border}`,
              borderRadius: 6,
              background: isYou ? colors.confirmBg : colors.surfaceSubtle,
              display: 'flex',
              alignItems: 'baseline',
              gap: spacing.gapMd,
              flexWrap: 'wrap',
            }}
          >
            <span style={{ fontWeight: isYou ? 700 : 600, color: colors.textStrong, overflowWrap: 'anywhere' }}>
              {m.display_name}{isYou && ' · you'}
            </span>
            {m.email ? (
              <a
                data-testid="member-email"
                href={`mailto:${m.email}?subject=${MAILTO_SUBJECT}`}
                style={{ fontSize: typography.sizeXs, color: colors.textMuted, overflowWrap: 'anywhere' }}
              >
                {m.email}
              </a>
            ) : (
              <span style={{ fontSize: typography.sizeXs, color: colors.textMuted }}>no email on file</span>
            )}
          </li>
        )
      })}
    </ul>
  )
}
