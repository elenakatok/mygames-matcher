import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { authInstructor, functionsInstructor } from './firebase'
import Play from './pages/Play'
import InstructorDashboard from './pages/InstructorDashboard'
import MatcherReports from './pages/MatcherReports'
import { configSections } from './configSections'
import { SettingsPage } from '@mygames/game-ui'

// The matcher has THREE routes, not the fleet's five: it has no /reports and no /configure
// because it never scores or runs a round — the guest game (the Beer Game) owns all of
// that. Keep the paths — the classroom app and the instructor's bookmarks assume
// /dashboard and /settings, and renaming one breaks a link nothing in this repo can see.

/** SINGLE undifferentiated MATCHING role. The Beer Game's seat roles are assigned at hand-off. */
const roleLabels: Record<string, string> = { player: 'Player' }

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/"          element={<Play />} />
        <Route path="/dashboard" element={<InstructorDashboard />} />
        <Route path="/reports"   element={<MatcherReports />} />
        <Route path="/settings"  element={
          <SettingsPage
            title="Settings — The Beer Game"
            functions={functionsInstructor}
            auth={authInstructor}
            roleLabels={roleLabels}
            showReservationPrices={false}
            configSections={configSections}
          />
        } />
      </Routes>
    </BrowserRouter>
  )
}
