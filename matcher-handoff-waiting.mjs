// ═══════════════════════════════════════════════════════════════════════════════
// "START" MUST SAY WHAT IT IS WAITING FOR — browser check of the instructor strip.
//
// ⚠ WHY THIS EXISTS. Production, 2026-09-10 (matcher-mygames-live): group 2 read "full —
// ready to hand off 4/4", the dialog said "Start the Beer Game for all 1 ready group?", OK
// did nothing and the console showed no error, and the strip said "0 handed off".
// startAllGroups had skipped the group — correctly — because its 4th member had not logged
// in, then returned success with the reason nowhere on screen.
//
//   S  SERVER — getOnlineGroups carries the plan startAllGroups decides with.
//   A  ONE MEMBER NOT LOGGED IN — the row, the live note by the button, the dialog and the
//      post-call report all NAME the student; the dialog counts only what will start.
//   B  A FULLY LOGGED-IN GROUP IS UNAFFECTED — it reads ready and the same press hands it off.
//   C  THE SKIP ITSELF IS UNCHANGED — the waiting group is NOT provisioned.
//   D  RECOVERY — the student logs in; the row turns ready by itself; Start hands it off.
//
// ⚠ NEGATIVE CONTROL: against the pre-fix strip + startAllGroups, S and A must FAIL while
// the behaviour checks in B and C still pass. The fix changes what is SAID, not what is DONE.
//
//   node matcher-handoff-waiting.mjs   (HEADED=1 to watch, KEEP=1 to leave the stack up,
//                                       SHOTS=<dir> for screenshots, default e2e-logs/)
//
// ⚠ Like matcher-e2e.mjs, a run leaves $TMPDIR/hub-matcher-mygames-live.json behind, and
// that breaks the next deploy from this directory. After a run:
//     rm -f "$TMPDIR"/hub-matcher-mygames-live.json
// ═══════════════════════════════════════════════════════════════════════════════

import { openSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { spawn, execSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT    = 'matcher-mygames-live'
const ROOT       = path.dirname(fileURLToPath(import.meta.url))
const FUNCTIONS  = `http://localhost:5005/${PROJECT}/us-central1`
const FIRESTORE  = `http://localhost:8082/v1/projects/${PROJECT}/databases/(default)/documents`
const FE         = 'http://localhost:5173'
const GUEST_PORT = 5597
const GUEST      = `http://localhost:${GUEST_PORT}`
const PORTS      = [9101, 5005, 8082, 9002, 5173, GUEST_PORT]
const SHOTS      = process.env.SHOTS ?? path.join(ROOT, 'e2e-logs')
mkdirSync(SHOTS, { recursive: true })

// playwright is a devDependency of infoshare; a repo without it resolves infoshare's copy.
let chromium
try { ({ chromium } = await import('playwright')) }
catch { ({ chromium } = createRequire(path.join(ROOT, '..', 'infoshare', 'package.json'))('playwright')) }

let PASS = 0, FAIL = 0
const banner = (m) => console.log('\n' + '─'.repeat(72) + '\n' + m + '\n' + '─'.repeat(72))
const check = (c, n) => { if (c) { PASS++; console.log(`  ✓ ${n}`) } else { FAIL++; console.log(`  ✗ FAIL: ${n}`) } }
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ── callable + Firestore REST (emulator; 'Bearer owner' bypasses rules for SEEDING only) ──
async function callFn(name, data) {
  const res = await fetch(`${FUNCTIONS}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) })
  let b = null; try { b = await res.json() } catch { /* */ }
  if (res.ok && b && 'result' in b) return { ok: true, result: b.result }
  return { ok: false, error: b?.error?.message ?? `http ${res.status}` }
}
const dev = (gid) => ({ _dev: { game_instance_id: gid } })
const recordLogin = (gid, pid) => callFn('recordLogin', { _test: { participant_id: pid, game_instance_id: gid } })
function enc(v) {
  if (typeof v === 'string')  return { stringValue: v }
  if (typeof v === 'boolean') return { booleanValue: v }
  if (typeof v === 'number')  return { integerValue: String(v) }
  throw new Error(`enc: unsupported ${typeof v}`)
}
async function fsSet(gid, suffix, obj) {
  const fields = {}; for (const [k, v] of Object.entries(obj)) fields[k] = enc(v)
  const r = await fetch(`${FIRESTORE}/game_instances/${gid}/${suffix}`, {
    method: 'PATCH', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }),
  })
  if (!r.ok) throw new Error(`fsSet ${suffix}: http ${r.status} ${await r.text()}`)
}

// ── a v1 mock guest: answers the hand-off exactly as the matcher's D6 verification requires ──
const provisioned = []
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
function startGuest() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, r) => {
      let b = ''
      req.on('data', (c) => (b += c))
      req.on('end', () => {
        let p = null; try { p = JSON.parse(b) } catch { /* */ }
        r.writeHead(200, { 'Content-Type': 'application/json' })
        if ((req.url || '').endsWith('/provision')) {
          const i = provisioned.length
          provisioned.push(p)
          const g = p?.groups?.[0] ?? {}
          const seats = (g.members ?? []).map((m, k) => ({ studentId: m.studentId, role: 'player', teamId: 'team1', playerId: `p${i}-${k}`, groupId: g.groupId }))
          r.end(JSON.stringify({
            contract_version: 1, gameCode: `WAIT${ALPHA[i % 32]}${ALPHA[Math.floor(i / 32) % 32]}`, seatCount: p?.seatCount, seats,
            groups: [{ groupId: g.groupId, humanSeats: seats.length, botSeats: (p?.seatCount ?? 0) - seats.length }],
          }))
          return
        }
        r.end(JSON.stringify({ contract_version: 1, ok: true })) // /finalize (best-effort cleanup path)
      })
    })
    srv.listen(GUEST_PORT, '127.0.0.1', () => resolve(srv))
  })
}

// ── stack lifecycle ────────────────────────────────────────────────────────────────
const children = []
let guest = null
const freePorts = () => { for (const p of PORTS) { try { execSync(`lsof -ti tcp:${p} -sTCP:LISTEN | xargs kill -9`, { stdio: 'ignore' }) } catch { /* */ } } }
async function waitHttp(url, label, maxMs = 150_000) {
  const start = Date.now()
  for (;;) { try { const r = await fetch(url); if (r.status > 0) return } catch { /* */ } if (Date.now() - start > maxMs) throw new Error(`${label} never ready`); await sleep(700) }
}
async function bringUp() {
  banner('BOOT — build functions, boot emulators + vite dev server + a v1 mock guest')
  freePorts(); await sleep(1000)
  execSync('npm run build', { cwd: path.join(ROOT, 'functions'), stdio: 'inherit' })
  const emuLog = openSync(path.join(ROOT, 'handoff-emu.log'), 'a')
  children.push(spawn('firebase', ['emulators:start', '--only', 'auth,functions,firestore,database', '--project', PROJECT], {
    cwd: ROOT, detached: true, stdio: ['ignore', emuLog, emuLog],
    env: { ...process.env,
      PROVISION_SECRET_BEERGAME: 'test-provision-secret', CALLBACK_SECRET_BEERGAME: 'test-callback-secret',
      PROVISION_URL_OVERRIDE: `${GUEST}/provision`, FINALIZE_URL_OVERRIDE: `${GUEST}/finalize` },
  }))
  const viteLog = openSync(path.join(ROOT, 'handoff-vite.log'), 'a')
  children.push(spawn('npm', ['run', 'dev'], { cwd: path.join(ROOT, 'frontend'), detached: true, stdio: ['ignore', viteLog, viteLog], env: { ...process.env } }))
  guest = await startGuest()
  await waitHttp('http://localhost:8082/', 'firestore')
  const start = Date.now()
  for (;;) { try { const r = await fetch(`${FUNCTIONS}/health`); if (r.ok) break } catch { /* */ } if (Date.now() - start > 150_000) throw new Error('functions never loaded'); await sleep(800) }
  await waitHttp(FE, 'vite')
  await sleep(1500)
  console.log('  Stack ready ✅')
}
const tearDown = () => {
  if (guest) { try { guest.close() } catch { /* */ } }
  if (process.env.KEEP === '1') return
  for (const c of children) { try { process.kill(-c.pid, 'SIGKILL') } catch { /* */ } }
  freePorts()
}

const NAMES = ['Honeydew Austin', 'Ada Lovelace', 'Alan Turing', 'Grace Hopper',
  'Edsger Dijkstra', 'Katherine Johnson', 'Barbara Liskov', 'Donald Knuth']

async function main() {
  await bringUp()

  const gid = `wait-${Date.now()}`
  await fsSet(gid, 'config/main', { clock_mode: 'off' })
  const pids = NAMES.map((_, i) => `w${i}`)
  for (const [i, pid] of pids.entries()) {
    await fsSet(gid, `participants/${pid}`, { participant_id: pid, game_instance_id: gid, role: 'player', is_bot: false, name: NAMES[i], email: `${pid}@example.edu` })
  }
  const gp = await callFn('groupParticipantsOnline', dev(gid))
  check(gp.ok && gp.result.full_groups === 2, `0. two full groups of 4 formed — ${gp.ok ? `${gp.result.full_groups} full` : gp.error}`)
  const og = await callFn('getOnlineGroups', dev(gid))
  const [g1, g2] = og.result.groups
  // One of group 2's members never logs in — Honeydew Austin when the random grouping put
  // them there (the production case), otherwise group 2's first member.
  const humans2 = g2.occupants.filter((o) => !o.is_bot)
  const absent = humans2.find((o) => o.display_name === 'Honeydew Austin') ?? humans2[0]
  for (const pid of pids) if (pid !== absent.participant_id) await recordLogin(gid, pid)
  const expectWait = `waiting on ${absent.display_name} to log in`
  console.log(`  group 1 = ${g1.group_id}, group 2 = ${g2.group_id}; not logged in: ${absent.display_name}`)

  banner('S  SERVER — getOnlineGroups carries the plan startAllGroups decides with')
  {
    const s = (await callFn('getOnlineGroups', dev(gid))).result?.groups ?? []
    check(s[0]?.handoff?.status === 'ready', `S1. fully logged-in group 1 → ready — ${JSON.stringify(s[0]?.handoff ?? null)}`)
    const w = s[1]?.handoff
    check(w?.status === 'waiting' && w.waiting.length === 1 && w.waiting[0].display_name === absent.display_name,
      `S2. group 2 → waiting on exactly ${absent.display_name}, by name — ${JSON.stringify(w ?? null)}`)
  }

  const browser = await chromium.launch({ headless: !process.env.HEADED })
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
  const errors = []; page.on('pageerror', (e) => errors.push(String(e)))
  const row = (n) => `[data-testid="game-control-strip-row-${n}"]`
  const textOf = (sel) => page.locator(sel).first().innerText().catch(() => '')
  const waitFor = async (sel, re, ms) => {
    const start = Date.now()
    for (;;) { if (re.test(await textOf(sel))) return true; if (Date.now() - start > ms) return false; await sleep(400) }
  }

  banner('A  ONE MEMBER NOT LOGGED IN — every place the instructor looks names the student')
  await page.goto(`${FE}/dashboard?_dev_game_instance_id=${gid}`)
  check(await waitFor(row(2), /full/, 60_000), 'A0. the strip shows group 2 as full')
  check(await waitFor(row(2), new RegExp(escapeRe(expectWait)), 12_000), `A1. group 2's row names the student — "${expectWait}"`)
  check(!/ready to hand off/.test(await textOf(row(2))), 'A2. …and does NOT say "ready to hand off"')
  check(/ready to hand off/.test(await textOf(row(1))), 'B1. fully logged-in group 1 still reads "ready to hand off"')
  const note = await textOf('[data-testid="start-class-waiting"]')
  check(note.includes(`Group 2 is ${expectWait}`), `A3. the live note beside Start names the blocker — "${note}"`)
  await page.screenshot({ path: path.join(SHOTS, 'handoff-1-row-waiting.png') })

  let dialog1 = ''
  page.once('dialog', async (d) => { dialog1 = d.message(); await d.accept() })
  await page.click('[data-testid="start-class"]')
  const reported = await waitFor('[data-testid="start-class-summary"]', /handed off/, 30_000)
  check(/^Start the Beer Game for 1 ready group\?/.test(dialog1), `A4. the dialog counts only what will start — "${dialog1.split('\n')[0]}"`)
  check(dialog1.includes(`Group 2 is ${expectWait}`), 'A5. the dialog names the group it will skip, and why')
  const summary1 = await textOf('[data-testid="start-class-summary"]')
  check(reported && /^1 handed off — group 1$/m.test(summary1), `A6. the report names what was handed off — "${summary1.split('\n')[0]}"`)
  check(summary1.includes(`Group 2 not started — ${expectWait}`), 'A7. the report names the skipped group and the student it is waiting on')
  console.log(`     dialog:\n       ${dialog1.split('\n').join('\n       ')}\n     report:\n       ${summary1.split('\n').join('\n       ')}`)

  banner('B/C  the fully logged-in group is handed off; the skip itself is unchanged')
  check(await waitFor(row(1), /handed off/, 15_000), 'B2. group 1 (fully logged in) is handed off by the same press')
  check(provisioned.length === 1 && provisioned[0]?.groups?.[0]?.groupId === g1.group_id,
    `C1. exactly one hand-off reached the guest, and it was group 1 — ${provisioned.length}`)
  check(!provisioned.some((p) => p?.groups?.[0]?.groupId === g2.group_id), 'C2. the waiting group was NOT provisioned')
  check(/full/.test(await textOf(row(2))) && !/handed off/.test(await textOf(row(2))), 'C3. group 2 is still waiting, not handed off')
  await page.screenshot({ path: path.join(SHOTS, 'handoff-2-report.png') })

  banner('D  RECOVERY — the student logs in; the row turns ready by itself; Start hands it off')
  await recordLogin(gid, absent.participant_id)
  check(await waitFor(row(2), /ready to hand off/, 20_000), 'D1. group 2 turns "ready to hand off" by itself (the strip polls), no reload')
  check((await page.locator('[data-testid="start-class-waiting"]').count()) === 0, 'D2. the waiting note is gone')
  let dialog2 = ''
  page.once('dialog', async (d) => { dialog2 = d.message(); await d.accept() })
  await page.click('[data-testid="start-class"]')
  const reported2 = await waitFor('[data-testid="start-class-summary"]', /^1 handed off — group 2$/m, 30_000)
  check(dialog2 === 'Start the Beer Game for 1 ready group?', `D3. the dialog: 1 ready group, nothing skipped — "${dialog2}"`)
  check(reported2, `D4. the report: "${(await textOf('[data-testid="start-class-summary"]')).split('\n')[0]}"`)
  check(provisioned.length === 2 && provisioned[1]?.groups?.[0]?.groupId === g2.group_id, 'D5. Start now hands group 2 off')
  check(await waitFor(row(2), /handed off/, 15_000), 'D6. group 2 reads handed off')
  await page.screenshot({ path: path.join(SHOTS, 'handoff-3-recovered.png') })
  check(errors.length === 0, `E1. no uncaught page errors${errors.length ? ' — ' + errors[0] : ''}`)

  await browser.close()
  console.log(`\n${'═'.repeat(72)}\n  ${PASS} passed, ${FAIL} failed\n${'═'.repeat(72)}`)
  return FAIL === 0
}

main()
  .then((ok) => { tearDown(); process.exit(ok ? 0 : 1) })
  .catch((e) => { console.error(e); tearDown(); process.exit(1) })
