import { InstructorDashboard as SharedDashboard } from '@mygames/game-ui'
import { authInstructor, functionsInstructor, rtdbInstructor } from '../firebase'
import { SEATS_PER_GROUP } from '../groupSize'
import GameControlStrip from './GameControlStrip'

// ═══════════════════════════════════════════════════════════════════════════════
// THE MATCHER'S INSTRUCTOR DASHBOARD — the shared dashboard, plus the control strip.
//
// ⚠ NO FINALIZE / SCORE HANDLING IS WIRED, and that is deliberate: the matcher never
// grades. The Beer Game pushes participation grades to the classroom directly when its
// game ends, so this dashboard passes no `scoreAndRecord`, `submitInstructorOutcome` or
// `beforeFinalize`. The shared component still renders a Finalize button, but it stays
// disabled (a matcher group never reaches the "all complete" state that would enable it),
// so it is inert. See the session handoff for the open item to hide it via a game-ui prop.
//
// ONE matching role, `player`; the Beer Game's seat roles (Retailer / Wholesaler /
// Distributor / Factory) are assigned at hand-off and never reach this roster, so there is
// no `displayRoles`.
// ═══════════════════════════════════════════════════════════════════════════════

const roleLabels: Record<string, string> = { player: 'Player' }

export default function InstructorDashboard() {
  return (
    <SharedDashboard
      title="Instructor Dashboard — The Beer Game"
      roleLabels={roleLabels}
      // Gate Match Now on a full group's worth of present students, mirroring
      // gameDefinition.composition ({ player: 4 }).
      composition={{ player: SEATS_PER_GROUP }}
      functions={functionsInstructor}
      auth={authInstructor}
      rtdb={rtdbInstructor}
      reportsRoute="/reports"
      settingsRoute="/settings"
      // ⚠ Opt into the re-runnable "Finalize & record" button (not the run-once Finalize).
      // The matcher never grades — this ENDS every handed-off Beer Game session, which makes
      // each push its participation grades. It is always available and safe to click again as
      // more groups finish, so a team that never finished (a member left) no longer blocks
      // grading everyone else. See functions/src/online.ts scoreAndRecord.
      scoreAndRecord={{ callableName: 'scoreAndRecord', label: 'Finalize & record' }}
      underHeadline={<GameControlStrip />}
    />
  )
}
