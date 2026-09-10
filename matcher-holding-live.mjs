// ═══════════════════════════════════════════════════════════════════════════════
// THE ONLINE HOLDING SCREEN MUST MOVE BY ITSELF — browser check.
//
// ⚠ WHY THIS EXISTS. The online holding screen used to read participants/<pid> ONCE, at
// mount. A student parked there when the instructor formed groups sat there until they
// reloaded. Every existing test missed it, because every existing test forms the group
// BEFORE the student arrives — an assertion that is equally true of the broken state. This
// file exercises the one transition that was broken: the student is ON the holding screen,
// group_id is written WHILE they sit there, and they must move with NO reload.
//
//   A  ONLINE — holding → (instructor forms groups) → the REVEAL, then Continue → the game.
//      ⚠ The reveal gate is the hazard this fix most likely introduces: WaitingRoom's
//      onMatched → setPhase('matched') pattern skips it. Landing in the game without
//      passing the reveal is a FAIL, not a pass.
//   B  CLASSROOM control — the live WaitingRoom still moves a student when group_id lands.
//   C  INSTRUMENT — a real reload IS detected by the no-reload probe. Without this, "no
//      reload" in A proves nothing.
//
// ⚠ NEGATIVE CONTROL: against the pre-fix Play.tsx, A4 must FAIL (the student stays on
// holding). A check that passes on the broken code is not a check.
//
//   node matcher-holding-live.mjs      (HEADED=1 to watch, KEEP=1 to leave the stack up)
// ═══════════════════════════════════════════════════════════════════════════════

import { openSync } from 'node:fs'
import { createRequire } from 'node:module'
import { spawn, execSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ── the only per-game block ────────────────────────────────────────────────────────
const GAME = {
  project:        'matcher-mygames-live',
  seats:          4,                  // online.seatCount — the Beer Game tenant's groupSize
  needsPrep:      false,              // the matcher has no info / KC / prep
  holding:        'online-holding',
  reveal:         'online-reveal',
  revealContinue: 'reveal-continue',
  // matched → HandoffRedirect. Its exit is gameCode; holding's exit is group_id alone.
  landed:         'handoff-redirect',
  // The secret env matcher-e2e.mjs boots with. This file never provisions, so no mock guest.
  emuEnv:         { PROVISION_SECRET_BEERGAME: 'test-provision-secret', CALLBACK_SECRET_BEERGAME: 'test-callback-secret' },
  viteEnv:        {},                 // frontend/.env.development supplies the VITE_ config
}

const ROOT      = path.dirname(fileURLToPath(import.meta.url))
const FUNCTIONS = `http://localhost:5005/${GAME.project}/us-central1`
const FIRESTORE = `http://localhost:8082/v1/projects/${GAME.project}/databases/(default)/documents`
const FE        = 'http://localhost:5173'
const PORTS     = [9101, 5005, 8082, 9002, 5173]

// playwright is a devDependency of infoshare; a repo without it resolves infoshare's copy.
let chromium
try { ({ chromium } = await import('playwright')) }
catch { ({ chromium } = createRequire(path.join(ROOT, '..', 'infoshare', 'package.json'))('playwright')) }

let PASS = 0, FAIL = 0
const banner = (m) => console.log('\n' + '─'.repeat(72) + '\n' + m + '\n' + '─'.repeat(72))
const check = (c, n) => { if (c) { PASS++; console.log(`  ✓ ${n}`) } else { FAIL++; console.log(`  ✗ FAIL: ${n}`) } }

// ── callable + Firestore REST (emulator; 'Bearer owner' bypasses rules for SEEDING only) ──
async function callFn(name, data) {
  const res = await fetch(`${FUNCTIONS}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) })
  let b = null; try { b = await res.json() } catch { /* */ }
  if (res.ok && b && 'result' in b) return { ok: true, result: b.result }
  return { ok: false, error: b?.error?.message ?? `http ${res.status}` }
}
function enc(v) {
  if (typeof v === 'string')  return { stringValue: v }
  if (typeof v === 'boolean') return { booleanValue: v }
  if (typeof v === 'number')  return { integerValue: String(v) }
  throw new Error(`enc: unsupported ${typeof v}`)
}
/** merge=true writes ONLY the given fields (updateMask); merge=false replaces the document. */
async function fsSet(gid, suffix, obj, merge = false) {
  const fields = {}; for (const [k, v] of Object.entries(obj)) fields[k] = enc(v)
  const mask = merge ? '?' + Object.keys(obj).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&') : ''
  const r = await fetch(`${FIRESTORE}/game_instances/${gid}/${suffix}${mask}`, {
    method: 'PATCH', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }),
  })
  if (!r.ok) throw new Error(`fsSet ${suffix}: http ${r.status} ${await r.text()}`)
}
const studentUrl = (gid, pid) => `${FE}/?_pid=${pid}&_gid=${gid}&_session=tab`
const has     = async (page, tid) => (await page.locator(`[data-testid="${tid}"]`).count()) > 0
const waitTid = (page, tid, ms) => page.waitForSelector(`[data-testid="${tid}"]`, { timeout: ms }).then(() => true, () => false)

// ── the no-reload probe ────────────────────────────────────────────────────────────
// A reload builds a new JS realm, so a marker set on window survives ONLY if the page was
// never reloaded. Section C proves the probe really does catch a reload.
const armProbe = (page) => page.evaluate(() => { window.__holdingProbe = 'armed' })
const probeIntact = (page) => page.evaluate(() => window.__holdingProbe === 'armed').catch(() => false)

// ── stack lifecycle ────────────────────────────────────────────────────────────────
const children = []
const freePorts = () => { for (const p of PORTS) { try { execSync(`lsof -ti tcp:${p} -sTCP:LISTEN | xargs kill -9`, { stdio: 'ignore' }) } catch { /* */ } } }
async function waitHttp(url, label, maxMs = 150_000) {
  const start = Date.now()
  for (;;) { try { const r = await fetch(url); if (r.status > 0) return } catch { /* */ } if (Date.now() - start > maxMs) throw new Error(`${label} never ready`); await sleep(700) }
}
async function bringUp() {
  banner('BOOT — build functions, boot emulators + vite dev server')
  freePorts(); await sleep(1000)
  execSync('npm run build', { cwd: path.join(ROOT, 'functions'), stdio: 'inherit' })
  const emuLog = openSync(path.join(ROOT, 'holding-emu.log'), 'a')
  children.push(spawn('firebase', ['emulators:start', '--only', 'auth,functions,firestore,database', '--project', GAME.project],
    { cwd: ROOT, detached: true, stdio: ['ignore', emuLog, emuLog], env: { ...process.env, ...GAME.emuEnv } }))
  const viteLog = openSync(path.join(ROOT, 'holding-vite.log'), 'a')
  children.push(spawn('npm', ['run', 'dev'], { cwd: path.join(ROOT, 'frontend'), detached: true, stdio: ['ignore', viteLog, viteLog], env: { ...process.env, ...GAME.viteEnv } }))
  await waitHttp('http://localhost:8082/', 'firestore')
  const start = Date.now()
  for (;;) { try { const r = await fetch(`${FUNCTIONS}/health`); if (r.ok) break } catch { /* */ } if (Date.now() - start > 150_000) throw new Error('functions never loaded'); await sleep(800) }
  await waitHttp(FE, 'vite')
  await sleep(1500)
  console.log('  Stack ready ✅')
}
const tearDown = () => { if (process.env.KEEP === '1') return; for (const c of children) { try { process.kill(-c.pid, 'SIGKILL') } catch { /* */ } } freePorts() }

const seedStudent = (gid, pid, name, extra = {}) => fsSet(gid, `participants/${pid}`, {
  participant_id: pid, game_instance_id: gid, role: 'player', is_bot: false,
  name, email: `${pid}@example.edu`, ...(GAME.needsPrep ? { prep_status: 'complete' } : {}), ...extra,
})

async function main() {
  await bringUp()
  const browser = await chromium.launch({ headless: !process.env.HEADED })
  const ctx = await browser.newContext()

  banner('A  ONLINE — student sits on holding; groups formed; moves BY ITSELF, THROUGH the reveal')
  {
    const gid = `hold-online-${Date.now()}`
    await fsSet(gid, 'config/main', { clock_mode: 'off' })
    const pids = Array.from({ length: GAME.seats }, (_, i) => `h${i}`)
    for (const [i, pid] of pids.entries()) await seedStudent(gid, pid, `Holding Student ${i}`)

    const page = await ctx.newPage()
    const errors = []; page.on('pageerror', (e) => errors.push(String(e)))
    await page.goto(studentUrl(gid, pids[0]))
    check(await waitTid(page, GAME.holding, 60_000), 'A1. ungrouped online student lands on the holding screen')
    await armProbe(page)
    await sleep(2500)
    check(await has(page, GAME.holding), 'A2. and stays there while no group exists (no spurious re-route)')

    const gp = await callFn('groupParticipantsOnline', { _dev: { game_instance_id: gid } })
    check(gp.ok, `A3. instructor forms groups WHILE the student sits on holding — ${gp.ok ? 'ok' : gp.error}`)

    // ⚠ A5/A6/A10 are conditioned on the transition having HAPPENED. "No reload" and "not in
    // the game" are both true of a student who never moved — on the pre-fix code they passed
    // vacuously in the first negative-control run, which is exactly the trap this file exists
    // to avoid.
    const moved = await waitTid(page, GAME.reveal, 20_000)
    check(moved, 'A4. the student moves off holding BY ITSELF — onto the group reveal')
    check(moved && await probeIntact(page), 'A5. with NO reload (the page that sat on holding is the one now showing the reveal)')
    check(moved && !(await has(page, GAME.landed)), 'A6. the reveal gate was NOT skipped — not dropped straight into the game')
    check(!(await has(page, GAME.holding)), 'A7. the holding screen is gone')
    const txt = moved ? await page.textContent(`[data-testid="${GAME.reveal}"]`).catch(() => '') : ''
    check(/Holding Student 0/.test(txt ?? ''), "A8. the reveal shows this student's own group")

    if (moved) await page.click(`[data-testid="${GAME.revealContinue}"]`).catch(() => {})
    const landed = await waitTid(page, GAME.landed, 20_000)
    check(landed, `A9. Continue → ${GAME.landed}`)
    check(landed && await probeIntact(page), 'A10. still the same page — the whole transition needed no reload')
    check(errors.length === 0, `A11. no uncaught page errors${errors.length ? ' — ' + errors[0] : ''}`)
    await page.close()
  }

  banner('B  CLASSROOM control — the live WaitingRoom still moves a student when group_id lands')
  {
    const gid = `hold-class-${Date.now()}`
    await fsSet(gid, 'config/main', { clock_mode: 'on' })
    await seedStudent(gid, 'c0', 'Class Student', {
      confirmed_ready_at: '2026-09-10T12:00:00Z', attendance_confirmed_at: '2026-09-10T12:00:00Z',
    })
    const page = await ctx.newPage()
    await page.goto(studentUrl(gid, 'c0'))
    const inRoom = await page.waitForSelector('text=Waiting to be matched', { timeout: 60_000 }).then(() => true, () => false)
    check(inRoom, 'B1. classroom student with attendance confirmed lands in the WaitingRoom')
    check(!(await has(page, GAME.holding)), 'B2. not the online holding screen')
    await armProbe(page)
    await fsSet(gid, 'participants/c0', { group_id: 'g-class' }, true)
    check(await waitTid(page, GAME.landed, 20_000), `B3. group_id lands → WaitingRoom moves the student to ${GAME.landed} by itself`)
    check(await probeIntact(page), 'B4. with no reload')
    check(!(await has(page, GAME.reveal)), 'B5. classroom never shows the online reveal')
    await page.close()
  }

  banner('C  INSTRUMENT — the no-reload probe really does detect a reload')
  {
    const gid = `hold-probe-${Date.now()}`
    await fsSet(gid, 'config/main', { clock_mode: 'off' })
    await seedStudent(gid, 'p0', 'Probe Student')
    const page = await ctx.newPage()
    await page.goto(studentUrl(gid, 'p0'))
    await waitTid(page, GAME.holding, 60_000)
    await armProbe(page)
    check(await probeIntact(page), 'C1. armed probe reads intact before any reload')
    await page.reload()
    await waitTid(page, GAME.holding, 60_000)
    check(!(await probeIntact(page)), 'C2. after a real reload the probe reports it — so A5/A10/B4 would have caught one')
    await page.close()
  }

  await browser.close()
  console.log(`\n${'═'.repeat(72)}\n  ${PASS} passed, ${FAIL} failed\n${'═'.repeat(72)}`)
  return FAIL === 0
}

main()
  .then((ok) => { tearDown(); process.exit(ok ? 0 : 1) })
  .catch((e) => { console.error(e); tearDown(); process.exit(1) })
