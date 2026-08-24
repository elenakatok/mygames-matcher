// Seed a browsable ONLINE instance into the running emulator, for the frontend smoke test.
// Starts a throwaway roster server, syncs a roster, switches to online mode, pre-groups.
import http from 'node:http'
const PROJECT = 'matcher-mygames-live'
const FN = `http://localhost:5005/${PROJECT}/us-central1`
const GID = process.argv[2] ?? 'browse1'
const CB_PORT = 5599
const ROSTER = [
  { participant_id: 'stu1', name: 'Ada Lovelace', email: 'ada@example.edu', external_id: 'stu1' },
  { participant_id: 'stu2', name: 'Alan Turing', email: 'alan@example.edu', external_id: 'stu2' },
  { participant_id: 'stu3', name: 'Grace Hopper', email: 'grace@example.edu', external_id: 'stu3' },
  { participant_id: 'stu4', name: 'Edsger Dijkstra', email: 'ed@example.edu', external_id: 'stu4' },
]
const call = async (name, data) => {
  const r = await fetch(`${FN}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) })
  const j = await r.json().catch(() => null)
  return j && 'result' in j ? j.result : { error: j?.error?.message ?? `http ${r.status}` }
}
const server = http.createServer((req, r) => {
  r.writeHead(200, { 'Content-Type': 'application/json' })
  r.end(JSON.stringify({ participants: ROSTER, instructor_email: 'prof@example.edu' }))
})
await new Promise((res) => server.listen(CB_PORT, '127.0.0.1', res))
console.log('mode', await call('updateGameConfig', { _dev: { game_instance_id: GID }, clock_mode: 'off' }))
console.log('sync', await call('syncRoster', { _dev: { game_instance_id: GID, roster_url: `http://localhost:${CB_PORT}`, callback_secret: 'test' } }))
console.log('group', await call('groupParticipantsOnline', { _dev: { game_instance_id: GID } }))
server.close()
console.log(`\nSeeded instance "${GID}".`)
console.log(`  Dashboard: /dashboard?_dev_game_instance_id=${GID}`)
console.log(`  Student:   /?_pid=stu1&_gid=${GID}`)
