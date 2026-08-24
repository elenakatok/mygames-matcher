// ═══════════════════════════════════════════════════════════════════════════════
// THE MATCHER END-TO-END HARNESS — empty instance to a landed HAND-OFF.
//
// ⚠ WHAT THIS PROVES, AND WHY EACH STEP CALLS THE REAL CALLABLE.
//
// The matcher's whole job is: run the standard classroom matching front-of-house, then
// HAND matched groups to a guest game (the Beer Game) and release each student's redirect.
// So this harness walks the SAME callables the shared UI invokes, in the SAME order a human
// causes them, for BOTH modes — and asserts the hand-off actually happened (the group gets
// a gameCode, is locked, and the guest game received the HUMAN members only, bots excluded).
//
// A harness that seeds a matched group and calls startAllGroups directly would miss exactly
// the reachability bugs that shipped twice in the sibling stage game (a callable never
// exported; a start control never invoked). This one presses the buttons.
//
// THE ONLY CONCESSION TO THE EMULATOR: participant bootstrap via `_test`/`_dev` (how the real
// client authenticates there too), presence written straight to RTDB (what the browser does),
// and PROVISION_URL_OVERRIDE pointing the hand-off at this file's mock Beer Game instead of
// the live one. That override is FUNCTIONS_EMULATOR-gated in handoff.ts — a deployed matcher
// can never be redirected by it.
//
//   node matcher-e2e.mjs        (env KEEP=1 leaves the stack up)
// ═══════════════════════════════════════════════════════════════════════════════

import { openSync, mkdirSync, writeSync } from 'node:fs'
import { spawn, execSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT   = 'matcher-mygames-live'
const ROOT      = path.dirname(fileURLToPath(import.meta.url))
const FUNCTIONS = `http://localhost:5005/${PROJECT}/us-central1`
const PORTS     = [9101, 5005, 8082, 9002]
const CB_PORT   = 5599
const PROVISION_SECRET = 'test-provision-secret'

const LOG_DIR = path.join(ROOT, 'e2e-logs')
mkdirSync(LOG_DIR, { recursive: true })
const LOG_FILE = path.join(LOG_DIR, `e2e-${new Date().toISOString().replace(/[:.]/g, '-')}.log`)
const LOG_FD = openSync(LOG_FILE, 'a')
for (const s of ['stdout', 'stderr']) {
  const passThrough = process[s].write.bind(process[s])
  process[s].write = (chunk, enc, cb) => {
    try { writeSync(LOG_FD, typeof chunk === 'string' ? chunk : Buffer.from(chunk)) } catch { /* */ }
    return passThrough(chunk, enc, cb)
  }
}
const logFatal = (label, err) => {
  try { writeSync(LOG_FD, `\n${label}\n${err && err.stack ? err.stack : String(err)}\n`) } catch { /* */ }
}
process.on('uncaughtException', (err) => { logFatal('UNCAUGHT EXCEPTION', err); console.error(err); process.exit(1) })
process.on('unhandledRejection', (err) => { logFatal('UNHANDLED REJECTION', err); console.error(err); process.exit(1) })

let PASS = 0, FAIL = 0
const banner = (m) => console.log('\n' + '─'.repeat(72) + '\n' + m + '\n' + '─'.repeat(72))
const check = (c, n) => { if (c) { PASS++; console.log(`  ✓ ${n}`) } else { FAIL++; console.log(`  ✗ FAIL: ${n}`) } }

// ── callable helper ─────────────────────────────────────────────────────────────
async function callFn(name, data) {
  const res = await fetch(`${FUNCTIONS}/${name}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }),
  })
  let body = null
  try { body = await res.json() } catch { /* */ }
  if (res.ok && body && 'result' in body) return { ok: true, result: body.result }
  return { ok: false, error: body?.error?.message ?? `http ${res.status}` }
}

const asStudent = (gid, pid, extra = {}) => ({ _test: { participant_id: pid, game_instance_id: gid }, ...extra })
const asDev     = (gid, extra = {}) => ({ _dev: { game_instance_id: gid }, ...extra })

// ── the mock classroom (roster source) + mock Beer Game (provisioning sink) ──────
let cbServer = null
let provisionRequests = []   // every hand-off body the mock Beer Game received
let rosterRequests = 0
let nextGameCode = 1
const ROSTER = [
  { participant_id: 'stu1', name: 'Ada Lovelace',    email: 'ada@example.edu',   external_id: 'stu1' },
  { participant_id: 'stu2', name: 'Alan Turing',     email: 'alan@example.edu',  external_id: 'stu2' },
  { participant_id: 'stu3', name: 'Grace Hopper',    email: 'grace@example.edu', external_id: 'stu3' },
  { participant_id: 'stu4', name: 'Edsger Dijkstra', email: 'ed@example.edu',    external_id: 'stu4' },
  { participant_id: 'stu5', name: 'Katherine Johnson', email: 'kj@example.edu',  external_id: 'stu5' },
  { participant_id: 'stu6', name: 'Barbara Liskov',  email: 'liskov@example.edu', external_id: 'stu6' },
]
function startClassroom() {
  return new Promise((res) => {
    cbServer = http.createServer((req, r) => {
      let b = ''
      req.on('data', (c) => (b += c))
      req.on('end', () => {
        let parsed = null
        try { parsed = JSON.parse(b) } catch { /* */ }
        r.writeHead(200, { 'Content-Type': 'application/json' })
        // The mock BEER GAME: a hand-off carries `groups` — answer with a game code.
        if (parsed && Array.isArray(parsed.groups)) {
          provisionRequests.push(parsed)
          const code = `BEER${String(nextGameCode++).padStart(3, '0')}`
          r.end(JSON.stringify({ gameCode: code })); return
        }
        // Otherwise it is a roster pull.
        rosterRequests++
        r.end(JSON.stringify({ participants: ROSTER, instructor_email: 'prof@example.edu' }))
      })
    })
    cbServer.listen(CB_PORT, '127.0.0.1', res)
  })
}
const CB = `http://localhost:${CB_PORT}`

// ── stack ──────────────────────────────────────────────────────────────────────
const children = []
const freePorts = () => { for (const p of PORTS) { try { execSync(`lsof -ti tcp:${p} -sTCP:LISTEN | xargs kill -9`, { stdio: 'ignore' }) } catch { /* */ } } }
async function bringUp() {
  banner('BOOT — build functions, boot emulators, start the mock classroom + Beer Game')
  freePorts(); await sleep(1000)
  execSync('npm run build', { cwd: path.join(ROOT, 'functions'), stdio: 'inherit' })
  const log = openSync(path.join(ROOT, 'e2e-emu.log'), 'a')
  children.push(spawn('firebase',
    ['emulators:start', '--only', 'auth,functions,firestore,database', '--project', PROJECT],
    { cwd: ROOT, detached: true, stdio: ['ignore', log, log],
      env: { ...process.env,
             PROVISION_URL_OVERRIDE: CB,
             PROVISION_SECRET_BEERGAME: PROVISION_SECRET } }))
  const start = Date.now()
  for (;;) {
    try { const r = await fetch(`${FUNCTIONS}/health`); if (r.ok) break } catch { /* */ }
    if (Date.now() - start > 150_000) throw new Error('functions never came up')
    await sleep(800)
  }
  await startClassroom()
  await sleep(800)
  console.log('  Stack ready ✅')
}
const tearDown = () => {
  if (cbServer) { try { cbServer.close() } catch { /* */ } }
  if (process.env.KEEP === '1') return
  for (const c of children) { try { process.kill(-c.pid, 'SIGKILL') } catch { /* */ } }
  freePorts()
}

// ── button-named steps ───────────────────────────────────────────────────────────
const syncRoster = (gid) => callFn('syncRoster', { _dev: { game_instance_id: gid, roster_url: CB, callback_secret: 'test' } })
const setMode    = (gid, mode) => callFn('updateGameConfig', asDev(gid, { clock_mode: mode }))
const genCode    = (gid) => callFn('generateAttendanceCode', asDev(gid, {}))
const assignRole = (gid, pid) => callFn('assignRole', asStudent(gid, pid, {}))
const confirmReady = (gid, pid) => callFn('confirmReady', asStudent(gid, pid, {}))
const verifyAttend = (gid, pid, code) => callFn('verifyAttendanceCode', asStudent(gid, pid, { code }))
const matchNow   = (gid) => callFn('triggerMatching', asDev(gid, {}))
const startAll   = (gid) => callFn('startAllGroups', asDev(gid, {}))
const getRoster  = (gid) => callFn('getRoster', asDev(gid, {}))
const getOnline  = (gid) => callFn('getOnlineGroups', asDev(gid, {}))
const groupOnline = (gid) => callFn('groupParticipantsOnline', asDev(gid, {}))
const recordLogin = (gid, pid) => callFn('recordLogin', asStudent(gid, pid, {}))
const moveSeat   = (gid, pid, target) => callFn('moveSeat', asDev(gid, { participant_id: pid, target_group_id: target }))
const topUp      = (gid, g) => callFn('topUpGroupWithBots', asDev(gid, { group_id: g }))

// Presence, straight to RTDB — what useStudentSession does (no callable exists for it).
async function beOnThePage(gid, pid) {
  const results = await Promise.all([`${PROJECT}-default-rtdb`, PROJECT].map((ns) =>
    fetch(`http://localhost:9002/presence/${gid}/${pid}.json?ns=${ns}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' }, body: 'true',
    }).then((r) => r.ok).catch(() => false)))
  return results.some(Boolean)
}

// Read a group doc straight from Firestore (the student's HandoffRedirect subscribes to
// exactly this — gameCode + seats_locked_at — so we assert the doc the client will read).
async function groupDoc(gid, groupId) {
  const url = `http://localhost:8082/v1/projects/${PROJECT}/databases/(default)/documents/game_instances/${gid}/groups/${groupId}`
  const r = await fetch(url, { headers: { Authorization: 'Bearer owner' } })
  if (!r.ok) return null
  const j = await r.json()
  const f = j.fields ?? {}
  return {
    gameCode: f.gameCode?.stringValue ?? null,
    locked: f.seats_locked_at != null,
    player_participants: (f.player_participants?.arrayValue?.values ?? []).map((v) => v.stringValue),
    bot_participants: (f.bot_participants?.arrayValue?.values ?? []).map((v) => v.stringValue),
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
async function classroomFlow() {
  banner('CLASSROOM MODE — attendance code → Match Now → Start (hand off) → redirect')
  const gid = `e2e-class-${Date.now()}`

  const m = await setMode(gid, 'on');           check(m.ok, `1. mode=on — ${m.ok ? 'ok' : m.error}`)
  const s = await syncRoster(gid);              check(s.ok && s.result.synced === 6, `2. syncRoster — synced ${s.result?.synced ?? s.error}`)
  const gc = await genCode(gid);                const code = gc.ok ? gc.result.code : null
  check(!!code, `3. generateAttendanceCode — ${code ?? gc.error}`)

  // Custom Beer Game demand settings — assert they flow through the hand-off as a
  // customerDemand array (initial for weeks < step, final after) + nWeeks.
  const cfg = await callFn('updateGameConfig', asDev(gid, { demand_initial: 5, demand_final: 12, demand_step_week: 3, num_weeks: 10 }))
  check(cfg.ok, `3a. set demand config — ${cfg.ok ? 'ok' : cfg.error}`)

  // Only 4 of the 6 attend + are present — the other two stay in the No-Group pool.
  const present = ['stu1', 'stu2', 'stu3', 'stu4']
  let joinOk = true
  for (const pid of present) {
    const ar = await assignRole(gid, pid);      if (!ar.ok) { joinOk = false; console.log(`     assignRole(${pid}): ${ar.error}`) }
    const cr = await confirmReady(gid, pid);    if (!cr.ok) { joinOk = false; console.log(`     confirmReady(${pid}): ${cr.error}`) }
    const va = await verifyAttend(gid, pid, code); if (!va.ok) { joinOk = false; console.log(`     verifyAttend(${pid}): ${va.error}`) }
    const pr = await beOnThePage(gid, pid);     if (!pr) { joinOk = false; console.log(`     presence(${pid}) failed`) }
  }
  check(joinOk, `4. four students joined + present`)

  const mm = await matchNow(gid);               check(mm.ok, `5. triggerMatching — ${mm.ok ? `${mm.result.groups.length} group(s)` : mm.error}`)
  const before = provisionRequests.length
  const st = await startAll(gid);               check(st.ok && st.result.started === 1, `6. startAllGroups — started ${st.result?.started ?? st.error}`)

  // The hand-off reached the mock Beer Game exactly once, with the four HUMAN members.
  const handoff = provisionRequests[before]
  check(!!handoff, `7. mock Beer Game received a hand-off`)
  const members = handoff?.groups?.[0]?.members ?? []
  check(members.length === 4, `8. hand-off carried 4 human members — got ${members.length}`)
  check(members.every((x) => x.studentId && x.displayName), `9. members carry studentId + displayName`)
  // Names must be the ROSTER names, not the raw pid (the "dNkRCO…" bug).
  const nameById = Object.fromEntries(ROSTER.map((r) => [r.participant_id, r.name]))
  const namesOk = members.every((x) => x.displayName === nameById[x.studentId] && x.displayName !== x.studentId)
  check(namesOk, `9a. member displayNames are real names, not pids — ${members.map((x) => x.displayName).join(', ')}`)
  // Demand config translated correctly: 10 weeks, 5 for weeks 0-2, 12 from week 3.
  const cfgOut = handoff?.config ?? {}
  const expectedDemand = [5, 5, 5, 12, 12, 12, 12, 12, 12, 12]
  check(cfgOut.nWeeks === 10 && JSON.stringify(cfgOut.customerDemand) === JSON.stringify(expectedDemand),
    `9b. hand-off config = ${cfgOut.nWeeks} weeks, demand ${JSON.stringify(cfgOut.customerDemand)}`)

  // The group doc the student's HandoffRedirect reads now has the gameCode + lock.
  const roster = await getRoster(gid)
  const grp = roster.result?.groups?.find((g) => (g.participants_by_role?.player ?? []).length > 0)
  const gdoc = grp ? await groupDoc(gid, grp.group_id) : null
  check(!!gdoc?.gameCode, `10. group doc carries a gameCode (student redirect fires) — ${gdoc?.gameCode ?? 'none'}`)
  check(gdoc?.locked === true, `11. group is locked at hand-off (seats_locked_at set)`)

  // Re-press Start: idempotent, hands off nothing new (the group already carries a code).
  const st2 = await startAll(gid);              check(st2.ok && st2.result.started === 0, `12. re-press Start is idempotent — started ${st2.result?.started ?? st2.error}`)
  check(provisionRequests.length === before + 1, `13. no duplicate hand-off on re-press`)
  return gid
}

// ═══════════════════════════════════════════════════════════════════════════════
async function shortGroupFlow() {
  banner('SHORT GROUP — 2 leftover students → new group → top up → hand off HUMANS only')
  const gid = `e2e-short-${Date.now()}`
  await setMode(gid, 'on')
  await syncRoster(gid)
  const code = (await genCode(gid)).result.code

  // Two students only — a group smaller than the four-seat Beer Game group.
  for (const pid of ['stu1', 'stu2']) {
    await assignRole(gid, pid); await confirmReady(gid, pid); await verifyAttend(gid, pid, code); await beOnThePage(gid, pid)
  }
  // triggerMatching forms only FULL groups, so two students form none — it declines
  // (either ok with 0 groups, or the "not enough participants" precondition). Either way
  // the two students stay in the No-Group pool for the instructor to place by hand.
  const mm = await matchNow(gid);   check(!mm.ok || (mm.result.groups?.length ?? 0) === 0, `1. no full group from 2 students — ${mm.ok ? (mm.result.groups?.length ?? '?') + ' groups' : mm.error}`)

  // Instructor: place the first into a NEW group, the second into it.
  const mv1 = await moveSeat(gid, 'stu1', 'new'); check(mv1.ok && mv1.result.moved, `2. stu1 → new group — ${mv1.ok ? 'ok' : mv1.error}`)
  const newGroup = mv1.result.created_group ?? mv1.result.target_group
  const mv2 = await moveSeat(gid, 'stu2', newGroup); check(mv2.ok && mv2.result.moved, `3. stu2 → same group — ${mv2.ok ? 'ok' : mv2.error}`)

  // Still short (2 of 4) → startAllGroups skips it.
  const stSkip = await startAll(gid); check(stSkip.result.started === 0 && (stSkip.result.skipped_short ?? 0) >= 1, `4. short group skipped by Start — started ${stSkip.result.started}, skipped_short ${stSkip.result.skipped_short}`)

  // Top up to four with placeholder seats, then Start hands it off.
  const tu = await topUp(gid, newGroup); check(tu.ok && tu.result.added === 2, `5. top up adds 2 placeholder seats — added ${tu.result?.added ?? tu.error}`)
  const before = provisionRequests.length
  const st = await startAll(gid); check(st.ok && st.result.started === 1, `6. topped-up group now hands off — started ${st.result?.started ?? st.error}`)
  const handoff = provisionRequests[before]
  const members = handoff?.groups?.[0]?.members ?? []
  check(members.length === 2, `7. hand-off carried 2 HUMANS only (placeholders excluded) — got ${members.length}`)
  const ids = members.map((x) => x.studentId).sort()
  check(ids[0] === 'stu1' && ids[1] === 'stu2', `8. the two humans are the real students — ${ids.join(',')}`)
  const gdoc = await groupDoc(gid, newGroup)
  check(gdoc?.bot_participants.length === 2, `9. group still shows 2 placeholder seats locally — ${gdoc?.bot_participants.length}`)
  check(!!gdoc?.gameCode && gdoc.locked, `10. topped-up group locked + coded`)
}

// ═══════════════════════════════════════════════════════════════════════════════
async function onlineFlow() {
  banner('ONLINE MODE — pre-group → arrive → move a seat → Start (hand off)')
  const gid = `e2e-online-${Date.now()}`
  const m = await setMode(gid, 'off'); check(m.ok, `1. mode=off — ${m.ok ? 'ok' : m.error}`)
  await syncRoster(gid)

  const gp = await groupOnline(gid); check(gp.ok && gp.result.total_humans === 6, `2. groupParticipantsOnline — ${gp.result?.total_humans ?? gp.error} humans, ${gp.result?.groups} group(s)`)

  // Students arrive (recordLogin returns the online mode so the client routes correctly).
  let modeOk = true
  for (const pid of ROSTER.map((r) => r.participant_id)) {
    const rl = await recordLogin(gid, pid); if (!(rl.ok && rl.result.clock_mode === 'off')) modeOk = false
  }
  check(modeOk, `3. every recordLogin reports clock_mode=off`)

  const og = await getOnline(gid); check(og.ok && og.result.groups.length >= 1, `4. getOnlineGroups — ${og.result?.groups?.length ?? og.error} group(s)`)
  const g0 = og.result.groups[0]
  check(g0.occupants.some((o) => o.display_name && o.display_name !== o.participant_id), `5. occupants carry real display names`)

  // Move a student from a group with a free seat is not guaranteed; move within a full
  // group to a NEW group to prove seat management works pre-hand-off.
  const someone = g0.occupants.find((o) => !o.is_bot)?.participant_id
  const mv = await moveSeat(gid, someone, 'new'); check(mv.ok && mv.result.moved, `6. moveSeat (pre-hand-off) works — ${mv.ok ? 'ok' : mv.error}`)

  // Top up every short group so Start can hand them all off (the Beer Game bot-fills its own).
  const seats = (await getOnline(gid)).result.groups
  for (const g of seats) if (g.free_seats > 0) await topUp(gid, g.group_id)

  const before = provisionRequests.length
  const st = await startAll(gid); check(st.ok && st.result.started >= 1, `7. startAllGroups hands off — started ${st.result?.started ?? st.error}`)
  const handed = provisionRequests.slice(before)
  const allHumansOnly = handed.every((req) => req.groups.every((g) => g.members.every((m2) => !String(m2.studentId).startsWith('bot_'))))
  check(handed.length >= 1 && allHumansOnly, `8. every online hand-off carried humans only`)

  // Regroup is now locked (a group has been handed off → seats_locked_at set).
  const regroup = await groupOnline(gid)
  check(!regroup.ok && /re-formed|already started|failed-precondition/i.test(regroup.error ?? ''), `9. regroup locked after hand-off — ${regroup.ok ? 'NOT LOCKED' : regroup.error}`)
}

// ═══════════════════════════════════════════════════════════════════════════════
async function main() {
  try {
    await bringUp()
    await classroomFlow()
    await shortGroupFlow()
    await onlineFlow()
  } catch (e) {
    FAIL++; console.error('HARNESS ERROR', e)
  } finally {
    banner(`RESULT — ${PASS} passed, ${FAIL} failed   (roster pulls: ${rosterRequests}, hand-offs: ${provisionRequests.length})`)
    console.log(`  Full log: ${LOG_FILE}`)
    tearDown()
    process.exit(FAIL === 0 ? 0 : 1)
  }
}
main()
