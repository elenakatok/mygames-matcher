#!/usr/bin/env node
//
// guest-conformance.mjs — drive the REAL guest-game endpoints and assert the wire
// contract documented in ThirdParty_Game_Wire_Contract_EXTRACT_2026_09_09.md.
//
// ⚠ WHY THIS EXISTS. matcher-e2e.mjs tests the matcher against a MOCK Beer Game that it
// also owns. That mock issues game codes like `BEER001` — containing 0 and 1, which the
// REAL parseGameCode (/^[A-Z2-9]{4,8}$/) rejects outright — and the suite is green anyway.
// A mock that is out of spec with the thing it stands in for cannot catch a contract
// break. This harness speaks HTTP to the real deployment instead.
//
// ⚠ IT IMPORTS NO BEERGAME SOURCE, ON PURPOSE. Its whole job is to test an implementation
// we do not control. Importing the guest's own code would make it agree with itself, which
// is exactly the failure mode above. Everything below is HTTP + JSON.
//
// ⚠ WRITTEN BEFORE THE HARDENING PASS, ON PURPOSE. Written afterwards it could only
// confirm that the code does whatever the code then does. Today's wrong behaviours (the
// unstructured 500s) are recorded as KNOWN-CURRENT baselines, not as passes and not as
// failures. When hardening lands and a baseline moves, this prints BASELINE MOVED — that
// is the harness watching the change happen, which is the point.
//
// ── WHAT IT DRIVES ────────────────────────────────────────────────────────────────────
//   provision → build deep link → claim seat → finalize → finalize again → read results
//
// ── AUTH: TWO DIFFERENT MODELS, DELIBERATELY NOT UNIFIED ──────────────────────────────
//   provisionClassSession / finalizeClassSession / getClassResults
//       Authorization: Bearer <matcher's PROVISION_SECRET_BEERGAME>   (server-to-server)
//   resumeClassPlayer
//       an onCall — Firebase ANONYMOUS auth, envelope {"data":{...}}, NOT the shared
//       secret. Forcing it into the bearer scheme would test a contract that doesn't exist.
//
// ── SECRETS ───────────────────────────────────────────────────────────────────────────
// The harness acts as the MATCHER, so it needs the matcher's copy of the provision secret:
//   project matcher-mygames-live, secret PROVISION_SECRET_BEERGAME
// NOT beergame's differently-named copy (beergame-mygames-live/CLASSROOM_PROVISION_SECRET).
// It is obtained through the mechanism scripts/set-matcher-secrets.sh already established
// (see SECRETS.md). No value is ever typed, printed, logged, or written to a repo file.
//
// Usage:
//   node tools/guest-conformance.mjs                 # happy-path arc
//   node tools/guest-conformance.mjs --negative      # deliberate failures + baselines
//   node tools/guest-conformance.mjs --negative --base-url https://...  # another deploy
//
// Requires Node 18+ (global fetch).

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createHash, createHmac } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MATCHER_ROOT = join(HERE, "..");

// ── configuration ─────────────────────────────────────────────────────────────────────

const MATCHER_PROJECT = "matcher-mygames-live";
const SECRET_NAME = "PROVISION_SECRET_BEERGAME";

// ── CONTRACT VERSION + VERSION-KEYED EXPECTATIONS (spec D7/D8) ────────────────────────
//
// ⚠ WHY THIS REPLACED HARDCODED BASELINES. Until D7 there was nothing to ask the guest
// about itself, so today's wrong behaviours were pinned as literals (`500`) that a human
// had to remember to edit when hardening landed. A structural fix beats a discipline fix:
// the harness now READS the guest's contract_version and selects the matching expectation
// set. The payoff is the case a hardcoded baseline cannot catch —
//
//     a guest reporting v1 while still returning unstructured 500s FAILS ON ITS OWN,
//
// because under the v1 set that 500 is a violation, not a baseline. Nobody has to notice.
const CONTRACT_VERSION = 1;

// ── SEAT TOKENS (spec D2) ─────────────────────────────────────────────────────
// The harness acts as the MATCHER, so it MINTS. Canonicalisation is duplicated from
// matcher functions/src/seatToken.ts and beergame functions/src/seatToken.ts on purpose —
// a third party reimplements this from the contract document, and a harness that imported
// one side's copy could not catch the two sides drifting apart.
//   wire:        "<exp>.<hex hmac-sha256>"
//   signed over: "seat.v1|<gameCode>|<studentId>|<exp>"
const SEAT_TOKEN_TTL_SECONDS = 120;
function mintSeatToken(gameCode, studentId, secret, ttl = SEAT_TOKEN_TTL_SECONDS, now = Math.floor(Date.now() / 1000)) {
  const exp = now + ttl;
  const mac = createHmac("sha256", secret)
    .update(`seat.v1|${gameCode}|${studentId}|${exp}`)
    .digest("hex");
  return `${exp}.${mac}`;
}

const EXPECTATIONS = {
  // v0 — the pre-hardening contract, recorded from what production ACTUALLY returned on
  // 2026-09-09 (arc 26 PASS / 0 FAIL, --negative 39 PASS / 0 FAIL, 7 KNOWN-CURRENT).
  // These are baselines: wrong, known, and not this harness's business to fail on.
  0: {
    label: "v0 (pre-D7/D8, as production returned on 2026-09-09)",
    versionEchoed: false,
    versionEnforced: false,
    errorShape: "string",          // { error: "unauthorized" }
    badCode: { status: 500, structured: false, code: null, baseline: true },
    seatTokenEnforced: false,      // overwritten by detectSeatTokenEnforced()
  },
  // v1 — what D7/D8 make true. Nothing here is a baseline; a v1 guest that misses any of
  // it is failing its own declared contract.
  1: {
    label: "v1 (D7 contract_version + D8 structured errors)",
    versionEchoed: true,
    versionEnforced: true,
    errorShape: "object",          // { contract_version, error: { code, message } }
    badCode: { status: 400, structured: true, code: "INVALID_GAME_CODE", baseline: false },
    // ⚠ NOT implied by v1. Pass B stays at contract_version 1, so this is feature-detected
    // per run and written over this default — see detectSeatTokenEnforced().
    seatTokenEnforced: false,
  },
};

/** v0 error string → v1 stable code, so one assertion covers both shapes. */
const ERROR_CODE_FOR = {
  "unauthorized": "UNAUTHORIZED",
  "method-not-allowed": "METHOD_NOT_ALLOWED",
  "groups[] is required": "GROUPS_REQUIRED",
  "not-found": "NOT_FOUND",
  "not-a-classroom-session": "NOT_A_CLASSROOM_SESSION",
};

const DEFAULTS = {
  baseUrl: "https://us-central1-beergame-mygames-live.cloudfunctions.net",
  playUrl: "https://beergame-mygames-live.web.app",
  // The guest's seat count. The matcher declares groupSize: 4 (tenants.ts) and the guest
  // has ROLES.length seats (engine.ts) — two independently-declared constants that nothing
  // validates against each other. The negative suite probes that seam directly.
  seats: 4,
};

function parseArgs(argv) {
  const out = { ...DEFAULTS, negative: false, selfTest: false, secretEnv: SECRET_NAME,
    expectVersion: CONTRACT_VERSION, expectSeatTokens: true, apiKey: null, apiKeyFile: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[(i += 1)];
    if (a === "--negative") out.negative = true;
    else if (a === "--self-test") out.selfTest = true;
    else if (a === "--secret-env") out.secretEnv = next();
    else if (a === "--expect-version") out.expectVersion = Number(next());
    else if (a === "--no-expect-seat-tokens") out.expectSeatTokens = false;
    else if (a === "--json") out.json = true;
    else if (a === "--base-url") out.baseUrl = next().replace(/\/$/, "");
    else if (a === "--play-url") out.playUrl = next().replace(/\/$/, "");
    else if (a === "--seats") out.seats = Number(next());
    else if (a === "--api-key") out.apiKey = next();
    else if (a === "--api-key-file") out.apiKeyFile = next();
    else if (a === "--help" || a === "-h") { usage(); process.exit(0); }
    else { console.error(`unknown argument: ${a}`); usage(); process.exit(2); }
  }
  return out;
}

function usage() {
  console.log(`
guest-conformance.mjs — conformance harness against the REAL guest endpoints

  --negative            run the deliberate-failure suite (the part that matters)
  --self-test           PROVE THE INSTRUMENT. Runs the whole suite against a shipped,
                        deliberately broken guest (tools/selftest-stub.mjs) and passes
                        only if the expected assertions come back RED. Run this before
                        trusting a green run. Needs no secret and no network.
  --secret-env <NAME>   env var holding the shared secret (default ${SECRET_NAME}).
                        The contract specifies the HEADER, not the storage — a third
                        party names his own variable (spec D13).
  --expect-version <n>  contract_version the guest must report (default ${CONTRACT_VERSION}).
                        Pass 0 to run against a pre-D7 guest without failing on it.
  --no-expect-seat-tokens
                        allow a guest that does NOT enforce signed seat claims (D2/D3).
                        Use only to record a pre-pass-B guest; by default that FAILS.
  --base-url <url>      guest functions origin   (default ${DEFAULTS.baseUrl})
  --play-url <url>      guest play origin        (default ${DEFAULTS.playUrl})
  --seats <n>           expected guest seat count (default ${DEFAULTS.seats})
  --api-key <key>       Firebase Web API key for the guest project (public, in-bundle
                        value; needed ONLY to mint the anonymous token resumeClassPlayer
                        requires). Or set BEERGAME_WEB_API_KEY.
  --api-key-file <path> read VITE_FIREBASE_API_KEY from a .env file instead of typing it
  --json                emit machine-readable results as well as the report
`);
}

// ── secret resolution — the Step-1 mechanism, no new one invented ──────────────────────
//
// handoff.ts resolves this secret two ways and we mirror both, plus the operator path:
//
//   production  PROVISION_SECRET.value()            — a defineSecret bound at deploy,
//                                                     readable only inside Functions
//   emulator    process.env[secretName]             — from functions/.secret.local
//
// This harness runs on a laptop, not inside Functions, so defineSecret is unavailable to
// it. It uses the same two sources a developer already has, in the order that touches the
// least: the emulator mirror that set-matcher-secrets.sh writes, then Secret Manager via
// the exact gcloud call that script's read_src() uses.
//
// ⚠ The value is held in a local, never printed, never written anywhere, and never passed
// as a command-line argument. Only an 8-char SHA-256 fingerprint is displayed, which is
// enough to tell "the two projects hold different values" from "the endpoint is broken"
// without disclosing anything.

function resolveSecret(envName = SECRET_NAME) {
  if (process.env[envName]) {
    return { value: process.env[envName], source: `env ${envName}` };
  }

  const local = join(MATCHER_ROOT, "functions", ".secret.local");
  if (existsSync(local)) {
    for (const line of readFileSync(local, "utf8").split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0 && line.slice(0, eq).trim() === SECRET_NAME) {
        const v = line.slice(eq + 1);
        if (v) return { value: v, source: "functions/.secret.local (emulator mirror)" };
      }
    }
  }

  try {
    const v = execFileSync(
      "gcloud",
      ["secrets", "versions", "access", "latest", "--secret", SECRET_NAME, "--project", MATCHER_PROJECT],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    if (v) return { value: v, source: `Secret Manager ${MATCHER_PROJECT}/${SECRET_NAME}` };
  } catch {
    /* fall through to the fatal below */
  }

  console.error(`
[FATAL] Could not obtain the shared secret (looked for env ${envName}).

  IF YOU ARE RUNNING THIS INSIDE mygames-matcher:
    The harness acts as the MATCHER, so it needs the matcher's copy of the provision
    secret — not beergame's CLASSROOM_PROVISION_SECRET. Obtain it through the existing
    mechanism (no value is ever typed):
      ./scripts/set-matcher-secrets.sh        # writes functions/.secret.local
    or authenticate gcloud with access to ${MATCHER_PROJECT}:
      gcloud auth login
    ⚠ Do NOT run 'firebase functions:secrets:set' to fix this — it prompts for a NEW
      value and creates a mismatched second version. See SECRETS.md.

  IF YOU ARE A THIRD-PARTY DEVELOPER testing your own guest game:
    You do not need any of the above. The contract specifies the HEADER, not the
    storage (spec D13) — name your own variable and point the harness at it:
      SHARED_SECRET=... node tools/guest-conformance.mjs --secret-env SHARED_SECRET \\
        --base-url https://your-endpoints.example.com
    And prove the harness bites first, which needs no secret at all:
      node tools/guest-conformance.mjs --self-test
`);
  process.exit(3);
}

const fingerprint = (s) => createHash("sha256").update(s).digest("hex").slice(0, 8);

// ── result recording ──────────────────────────────────────────────────────────────────
//
// Four outcomes, not two. KNOWN-CURRENT is the important one: behaviour that is wrong
// today, recorded as a baseline so the hardening pass can be seen to change it.

const results = [];
const PASS = "PASS", FAIL = "FAIL", BASELINE = "KNOWN-CURRENT", MOVED = "BASELINE MOVED", SKIP = "SKIP";

function record(status, name, detail = "") {
  results.push({ status, name, detail });
  const tag = { [PASS]: "  ✓", [FAIL]: "  ✗", [BASELINE]: "  ◆", [MOVED]: "  ⚠", [SKIP]: "  –" }[status];
  console.log(`${tag} ${status.padEnd(14)} ${name}${detail ? `\n        ${detail}` : ""}`);
}

const check = (name, cond, detail = "") => record(cond ? PASS : FAIL, name, cond ? "" : detail);

/** Behaviour that is WRONG today. Records a baseline; shouts if it has moved. */
// ⚠ Baselines describe the REAL guest's current behaviour. Against the deliberately broken
// self-test stub they are meaningless — it does not validate game codes or filter members,
// so it "moves" baselines it was never measured against. Evaluating them there produced two
// spurious BASELINE MOVED lines, which is worse than useless: BASELINE MOVED is the signal
// that has to stay trustworthy when hardening lands, and a check that cries wolf during the
// instrument proof teaches the reader to scroll past exactly the line that will matter.
let baselinesApply = true;
const setBaselinesApply = (v) => { baselinesApply = v; };

function baseline(name, observed, knownCurrent, wanted) {
  if (!baselinesApply) {
    record(SKIP, name, `baseline not evaluated against the self-test stub (observed ${observed}); ` +
      `baselines describe the real guest only.`);
  } else if (observed === knownCurrent) {
    record(BASELINE, name, `observed ${observed} (known-current). Hardening should make this ${wanted}.`);
  } else {
    record(MOVED, name, `observed ${observed}, baseline was ${knownCurrent}, target is ${wanted}. ` +
      `If hardening landed, update the baseline in this file.`);
  }
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────────────

/**
 * D7: every matcher→guest request carries contract_version. Pass `version: null` to OMIT it
 * (the negative suite needs to send an unversioned request) or a number to send a wrong one.
 */
async function callGuest(baseUrl, fn, body, secret, { method = "POST", version = CONTRACT_VERSION } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (secret !== null) headers.Authorization = `Bearer ${secret}`;
  const payload = version === null ? { ...(body ?? {}) } : { contract_version: version, ...(body ?? {}) };
  const res = await fetch(`${baseUrl}/${fn}`, {
    method,
    headers,
    body: method === "GET" ? undefined : JSON.stringify(payload),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON is itself a finding */ }
  return { status: res.status, json, text, isJson: json !== null };
}

/**
 * Ask the guest which contract it speaks, WITHOUT creating anything.
 *
 * The probe is a deliberately-wrong-secret call: it is rejected at the auth gate, so no
 * session is provisioned and no document is written — but a v1 guest still echoes
 * contract_version in that 401 body, because D8 requires the version on every response
 * including errors. A guest that echoes nothing is treated as v0.
 */
async function detectContractVersion(baseUrl) {
  const probe = await callGuest(baseUrl, "provisionClassSession", { groups: [] },
    "version-probe-not-a-real-secret");
  const v = probe.json?.contract_version;
  return Number.isInteger(v) ? Number(v) : 0;
}

/**
 * Is the guest enforcing signed seat claims (D2/D3)?
 *
 * ⚠ WHY THIS IS NOT KEYED ON contract_version. Pass B deliberately stays at
 * contract_version 1 — nothing outside this project has ever spoken the contract, so a bump
 * now would manufacture version history for revisions nobody used. That means the version
 * CANNOT select this expectation, and the harness has to feature-detect instead.
 *
 * The probe: claim a seat that does not exist, with NO seat token.
 *   • seat tokens enforced → 400 SEAT_TOKEN_REQUIRED, because verification is pure and runs
 *     BEFORE any Firestore read;
 *   • not enforced (pre-pass-B, an onCall) → anything else — 401 from the callable's
 *     anonymous-auth gate, or a not-found once it reaches the seat lookup.
 * Using a NONEXISTENT studentId is what makes this safe against a pre-pass-B guest: there,
 * an unsigned claim still works, and probing a real seat would evict its holder.
 */
async function detectSeatTokenEnforced(baseUrl) {
  const probe = await callGuest(baseUrl, "resumeClassPlayer",
    { gameCode: "ZZZZZZ", studentId: `seat-token-probe-${Date.now()}` }, null);
  return probe.status === 400 && probe.json?.error?.code === "SEAT_TOKEN_REQUIRED";
}

/**
 * Assert an error body in whichever shape the detected version calls for:
 *   v0  { error: "not-found" }
 *   v1  { contract_version: 1, error: { code: "NOT_FOUND", message } }
 * One call site, two contracts, so the negative suite reads the same either way.
 */
function checkErrorBody(name, res, v0String, expect) {
  const wantCode = ERROR_CODE_FOR[v0String] ?? v0String;
  if (expect.errorShape === "string") {
    check(`${name} (v0 shape {error:'${v0String}'})`, res.json?.error === v0String,
      `got ${JSON.stringify(res.json).slice(0, 160)}`);
    return;
  }
  check(`${name} (v1 shape {error:{code:'${wantCode}'}})`,
    res.json?.error?.code === wantCode && typeof res.json?.error?.message === "string",
    `got ${JSON.stringify(res.json).slice(0, 160)}`);
  check(`${name} — error body echoes contract_version`,
    res.json?.contract_version === CONTRACT_VERSION,
    `got contract_version=${JSON.stringify(res.json?.contract_version)}`);
}

/**
 * resumeClassPlayer is an onCall, NOT a bearer-secret endpoint. Two steps:
 *   1. mint an ANONYMOUS Firebase id token via the Identity Toolkit REST API — this is
 *      what the browser's ensurePlayerAuth() does before every callable;
 *   2. POST the callable envelope {"data":{...}} with that token.
 * Callable replies are {"result":...} on success and {"error":{status,message}} on
 * failure, with the HTTP status carrying the mapped code.
 */
async function anonIdToken(apiKey) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(apiKey)}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ returnSecureToken: true }) },
  );
  if (!res.ok) throw new Error(`anonymous sign-in failed: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
  const j = await res.json();
  if (!j.idToken) throw new Error("anonymous sign-in returned no idToken");
  return j.idToken;
}

async function callCallable(baseUrl, fn, data, idToken) {
  const res = await fetch(`${baseUrl}/${fn}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ data }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* */ }
  return { status: res.status, json, text, result: json?.result ?? null, error: json?.error ?? null };
}

function resolveApiKey(opts) {
  if (opts.apiKey) return opts.apiKey;
  if (process.env.BEERGAME_WEB_API_KEY) return process.env.BEERGAME_WEB_API_KEY;
  if (opts.apiKeyFile && existsSync(opts.apiKeyFile)) {
    for (const line of readFileSync(opts.apiKeyFile, "utf8").split("\n")) {
      const m = /^\s*VITE_FIREBASE_API_KEY\s*=\s*(.+?)\s*$/.exec(line);
      if (m) return m[1].replace(/^["']|["']$/g, "");
    }
  }
  return null;
}

// ── the happy-path arc ────────────────────────────────────────────────────────────────

async function runArc(opts, secret, expect) {
  const stamp = Date.now();
  const instanceId = `conformance-${stamp}`;
  const groupId = `cgroup-${stamp}`;
  // ⚠ A unique canary as the display name. The extract says a student NAME crosses into
  // the guest at provisioning and must NOT come back out through getClassResults. A
  // distinctive string makes that assertion strong: we scan the entire results payload
  // for it rather than checking a field we already expect to be absent.
  const canary = `ZZCanary${stamp}`;
  const members = Array.from({ length: opts.seats }, (_, i) => ({
    studentId: `${instanceId}-s${i + 1}`,
    displayName: `${canary}-${i + 1}`,
  }));

  console.log(`\n── ARC ── instance ${instanceId}, ${members.length} members\n`);

  // 1. provision ──────────────────────────────────────────────────────────────────────
  const prov = await callGuest(opts.baseUrl, "provisionClassSession",
    { instanceId, groups: [{ groupId, members }], config: { nWeeks: 12, customerDemand: Array.from({ length: 12 }, (_, i) => (i < 4 ? 4 : 8)) } },
    secret);

  check("provision returns 2xx", prov.status >= 200 && prov.status < 300, `got HTTP ${prov.status}: ${prov.text.slice(0, 200)}`);
  if (!prov.json?.gameCode) {
    record(FAIL, "provision returns a gameCode", `body: ${prov.text.slice(0, 200)}`);
    return { fatal: true };
  }
  const gameCode = prov.json.gameCode;

  // ⚠ The real regex, from the contract — NOT the mock's BEER001 shape, which this
  // pattern rejects. If matcher-e2e's mock were driving this, the next line would fail.
  check("gameCode matches the real /^[A-Z2-9]{4,8}$/", /^[A-Z2-9]{4,8}$/.test(gameCode), `got '${gameCode}'`);

  // D7: "Echoed in every response." Success bodies too, not only errors.
  if (expect.versionEchoed) {
    check("provision response echoes contract_version", prov.json?.contract_version === CONTRACT_VERSION,
      `got contract_version=${JSON.stringify(prov.json?.contract_version)}`);
  }

  const seats = Array.isArray(prov.json.seats) ? prov.json.seats : [];
  check("seats[] returned, one per member", seats.length === members.length, `got ${seats.length}, sent ${members.length}`);
  check("every seat carries studentId/role/teamId/playerId/groupId",
    seats.every((s) => s.studentId && s.role && s.teamId && s.playerId && s.groupId),
    JSON.stringify(seats.slice(0, 2)));
  check("seat roles are distinct", new Set(seats.map((s) => s.role)).size === seats.length,
    `roles: ${seats.map((s) => s.role).join(", ")}`);
  check("our groupId is echoed back, not replaced", seats.every((s) => s.groupId === groupId),
    `got ${JSON.stringify([...new Set(seats.map((s) => s.groupId))])}`);

  // ⚠ Spec D6: "The matcher verifies the seats array the guest returns. The guest already
  // returns it; the matcher currently discards it. It is the natural place to catch a
  // hand-off that silently placed fewer students than it was given." handoff.ts reads only
  // out.gameCode, so nothing in production makes this check — the harness does it here.
  // This is also §5.2's "missing member" probe: --self-test drops one and this goes red.
  const seatedIds = new Set(seats.map((s) => s.studentId));
  const unseated = members.filter((m) => !seatedIds.has(m.studentId));
  check("every posted member received a seat", unseated.length === 0,
    `${unseated.length} posted member(s) got no seat: ${unseated.map((m) => m.studentId).join(", ")}`);

  // 2. deep link ──────────────────────────────────────────────────────────────────────
  const target = seats[0];
  const deepLink = `${opts.playUrl}/?class=${encodeURIComponent(gameCode)}&sid=${encodeURIComponent(target.studentId)}`;
  check("deep link matches the documented format",
    new RegExp(`^${opts.playUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\?class=[A-Z2-9]{4,8}&sid=.+$`).test(deepLink),
    deepLink);
  console.log(`        ${deepLink}`);

  // 3. claim the seat — PLAIN HTTP + SIGNED TOKEN (D2/D3) ────────────────────────────
  //
  // ⚠ No Firebase API key any more. D3 removed the onCall wrapper and its anonymous login,
  // so this endpoint is ordinary HTTP and the harness can exercise it unconditionally. It
  // used to SKIP whenever no key was supplied — the seat claim, the half of the contract
  // with the live security defect, was the one part routinely going untested.
  let claimed = null;
  const seatEnforced = expect.seatTokenEnforced;

  const goodToken = mintSeatToken(gameCode, target.studentId, secret);
  const deepLinkSigned = `${opts.playUrl}/?class=${encodeURIComponent(gameCode)}` +
    `&sid=${encodeURIComponent(target.studentId)}&t=${encodeURIComponent(goodToken)}`;
  check("deep link carries a signed seat token (t=)", /[?&]t=[0-9]+\.[0-9a-f]{64}/.test(deepLinkSigned),
    deepLinkSigned.slice(0, 160));

  const claim = await callGuest(opts.baseUrl, "resumeClassPlayer",
    { gameCode, studentId: target.studentId, seatToken: goodToken }, null);
  check("resumeClassPlayer accepts a validly signed claim", claim.status >= 200 && claim.status < 300,
    `HTTP ${claim.status}: ${claim.text.slice(0, 200)}`);
  claimed = claim.json;
  check("seat payload carries playerId/role/teamId/teamName/sessionToken",
    Boolean(claimed?.playerId && claimed?.role && claimed?.teamId && claimed?.teamName && claimed?.sessionToken),
    JSON.stringify(claimed ?? {}).slice(0, 200));
  check("role matches the seat provisioning assigned", claimed?.role === target.role,
    `provision said '${target.role}', claim said '${claimed?.role}'`);
  if (expect.versionEchoed) {
    check("seat claim echoes contract_version", claimed?.contract_version === CONTRACT_VERSION,
      `got ${JSON.stringify(claimed?.contract_version)}`);
  }
  check("the display name we sent is returned by the seat claim (documents the PII crossing)",
    typeof claimed?.name === "string" && claimed.name.includes(canary),
    `got name='${claimed?.name}'`);

  // ── THE HIJACK PROBE, NOW INVERTED ──────────────────────────────────────────────────
  //
  // ⚠ THESE ASSERTIONS USED TO PASS *BECAUSE THE DEFECT EXISTED*. On production on
  // 2026-09-09 a stranger claimed a live seat with nothing but gameCode+sid, and a second
  // assertion confirmed the hijack minted a DIFFERENT session token — i.e. that it had
  // evicted the real holder. Both were evidence of the hole. Inverting them is the point of
  // this pass: the same three attacks must now be REFUSED, and nothing may be minted.
  if (!seatEnforced) {
    baseline("unrelated party can claim the same seat (unsigned sid)", "granted", "granted",
      "refused (claim proven by a signed seat token)");
    record(SKIP, "signed-claim refusals (unsigned / expired / wrong-seat)",
      "guest does not enforce seat tokens yet — pass B not deployed here.");
  } else {
    const unsigned = await callGuest(opts.baseUrl, "resumeClassPlayer",
      { gameCode, studentId: target.studentId }, null);
    check("UNSIGNED claim on a live seat is REFUSED", unsigned.status === 400 &&
      unsigned.json?.error?.code === "SEAT_TOKEN_REQUIRED",
      `HTTP ${unsigned.status}: ${unsigned.text.slice(0, 200)}`);

    const expired = mintSeatToken(gameCode, target.studentId, secret, -60);
    const expiredRes = await callGuest(opts.baseUrl, "resumeClassPlayer",
      { gameCode, studentId: target.studentId, seatToken: expired }, null);
    check("EXPIRED token is REFUSED", expiredRes.status === 401 &&
      expiredRes.json?.error?.code === "SEAT_TOKEN_EXPIRED",
      `HTTP ${expiredRes.status}: ${expiredRes.text.slice(0, 200)}`);

    // A token minted for a DIFFERENT seat in the same session — the closest thing to a
    // realistic forgery, and it must not transfer.
    const other = seats[1] ?? seats[0];
    const wrongSeat = mintSeatToken(gameCode, other.studentId, secret);
    const wrongRes = await callGuest(opts.baseUrl, "resumeClassPlayer",
      { gameCode, studentId: target.studentId, seatToken: wrongSeat }, null);
    check("token minted for ANOTHER seat is REFUSED", wrongRes.status === 401 &&
      wrongRes.json?.error?.code === "SEAT_TOKEN_INVALID",
      `HTTP ${wrongRes.status}: ${wrongRes.text.slice(0, 200)}`);

    // The inversion of "the hijack minted a DIFFERENT session token". No claim was granted,
    // so no token may have been minted — that is what "the real holder was not evicted"
    // looks like from outside.
    check("no refusal minted a session token (the real holder is not evicted)",
      !unsigned.json?.sessionToken && !expiredRes.json?.sessionToken && !wrongRes.json?.sessionToken,
      "a refusal returned a sessionToken — the seat was granted after all");
  }

  // 4. finalize, twice — idempotency ──────────────────────────────────────────────────
  const fin1 = await callGuest(opts.baseUrl, "finalizeClassSession", { gameCode }, secret);
  check("finalize #1 returns 2xx", fin1.status >= 200 && fin1.status < 300, `HTTP ${fin1.status}: ${fin1.text.slice(0, 200)}`);
  check("finalize #1 returns ok:true", fin1.json?.ok === true, JSON.stringify(fin1.json));
  check("finalize #1 does NOT claim alreadyEnded", fin1.json?.alreadyEnded === undefined,
    `got alreadyEnded=${fin1.json?.alreadyEnded}`);

  const fin2 = await callGuest(opts.baseUrl, "finalizeClassSession", { gameCode }, secret);
  check("finalize #2 returns 2xx (idempotent)", fin2.status >= 200 && fin2.status < 300, `HTTP ${fin2.status}`);
  check("finalize #2 returns ok:true, alreadyEnded:true",
    fin2.json?.ok === true && fin2.json?.alreadyEnded === true, JSON.stringify(fin2.json));
  if (expect.versionEchoed) {
    check("finalize responses echo contract_version",
      fin1.json?.contract_version === CONTRACT_VERSION && fin2.json?.contract_version === CONTRACT_VERSION,
      `#1=${JSON.stringify(fin1.json?.contract_version)} #2=${JSON.stringify(fin2.json?.contract_version)}`);
  }

  // ⚠ HONEST LIMIT. "Does not re-fire grading" is NOT observable over HTTP — the grade
  // push is a Firestore onDocumentWritten trigger inside the guest project. What is
  // observable is the alreadyEnded short-circuit above, which returns BEFORE the status
  // update that would fire the trigger. The non-re-fire is therefore INFERRED from that
  // response, not proven here. (It is doubly moot today: onGameEndedPushResults returns
  // early unless BEERGAME_SELF_GRADE=true.) Proving it needs a log/Firestore probe with
  // guest-project credentials, which is outside this harness's HTTP-only remit.
  record(SKIP, "finalize #2 does not re-fire grading",
    "not observable over HTTP — inferred from the alreadyEnded short-circuit, not proven. " +
    "See comment in this file.");

  // 5. results ────────────────────────────────────────────────────────────────────────
  const rr = await callGuest(opts.baseUrl, "getClassResults", { gameCode }, secret);
  check("getClassResults returns 2xx", rr.status >= 200 && rr.status < 300, `HTTP ${rr.status}: ${rr.text.slice(0, 200)}`);
  if (expect.versionEchoed) {
    check("results response echoes contract_version", rr.json?.contract_version === CONTRACT_VERSION,
      `got contract_version=${JSON.stringify(rr.json?.contract_version)}`);
  }
  check("results carry ok/gameCode/teams[]/players[]",
    rr.json?.ok === true && rr.json?.gameCode === gameCode && Array.isArray(rr.json?.teams) && Array.isArray(rr.json?.players),
    JSON.stringify(rr.json).slice(0, 200));

  const players = rr.json?.players ?? [];
  const teams = rr.json?.teams ?? [];
  check("one player row per HUMAN member (bots filtered out)", players.length === members.length,
    `got ${players.length}, provisioned ${members.length} humans`);
  check("no player row is a bot", players.every((p) => p.studentId && !/beer gpt/i.test(JSON.stringify(p))),
    JSON.stringify(players.slice(0, 2)));
  check("every player row has studentId/role/teamId/teamCost/individualCost/participated",
    players.every((p) => "studentId" in p && "role" in p && "teamId" in p && "teamCost" in p && "individualCost" in p && "participated" in p),
    JSON.stringify(players[0] ?? {}));
  check("teams[] carry teamId/teamName/teamCost/costByRole",
    teams.every((t) => t.teamId && typeof t.teamName === "string" && "teamCost" in t && t.costByRole),
    JSON.stringify(teams[0] ?? {}));

  // The canary assertion: the student NAME must not cross back out.
  check("results contain NO student name (canary absent from the whole payload)",
    !JSON.stringify(rr.json).includes(canary),
    `canary '${canary}' leaked into getClassResults`);

  if (claimed) {
    const row = players.find((p) => p.studentId === target.studentId);
    check("the student who claimed a seat is marked participated", row?.participated === true,
      `participated=${row?.participated}`);
  }

  return { gameCode, instanceId, members, teams: teams.length, fatal: false };
}

// ── the negative suite — this matters more than the happy path ────────────────────────

async function runNegative(opts, secret, expect) {
  console.log(`\n── NEGATIVE ── deliberate failures; each must be DETECTED\n`);

  // 1. wrong secret → 401
  const wrong = await callGuest(opts.baseUrl, "provisionClassSession",
    { groups: [{ members: [{ studentId: "x" }] }] }, "definitely-not-the-secret");
  check("wrong secret → 401", wrong.status === 401, `got HTTP ${wrong.status}: ${wrong.text.slice(0, 160)}`);
  checkErrorBody("401 body", wrong, "unauthorized", expect);

  // 2. non-POST → 405
  const get = await callGuest(opts.baseUrl, "provisionClassSession", null, secret, { method: "GET" });
  check("non-POST → 405", get.status === 405, `got HTTP ${get.status}: ${get.text.slice(0, 160)}`);
  checkErrorBody("405 body", get, "method-not-allowed", expect);

  // 3. empty groups[] → 400
  const empty = await callGuest(opts.baseUrl, "provisionClassSession", { groups: [] }, secret);
  check("empty groups[] → 400", empty.status === 400, `got HTTP ${empty.status}: ${empty.text.slice(0, 160)}`);
  checkErrorBody("400 body", empty, "groups[] is required", expect);

  // 4. game code containing 0/1 → KNOWN-CURRENT 500 (parseGameCode throws HttpsError
  //    inside an onRequest, so it escapes as an unstructured 500 rather than a 400).
  //    We record what we OBSERVE, not the status we wish for.
  const bad = await callGuest(opts.baseUrl, "finalizeClassSession", { gameCode: "BEER01" }, secret);
  if (expect.badCode.baseline) {
    // v0: an HttpsError escaping an onRequest. Wrong, known, and not ours to fail on yet.
    baseline("game code containing 0/1 ('BEER01')", bad.status, expect.badCode.status, 400);
    record(BASELINE, "…and its body is unstructured",
      `isJson=${bad.isJson} body='${bad.text.slice(0, 120).replace(/\n/g, " ")}'`);
  } else {
    // v1: the guest SAYS it implements D8, so this is a violation, not a baseline. This is
    // the case a hardcoded baseline could never catch — no human has to remember anything.
    check(`game code containing 0/1 ('BEER01') → ${expect.badCode.status}`,
      bad.status === expect.badCode.status,
      `guest reports contract_version ${CONTRACT_VERSION} but returned HTTP ${bad.status}: ` +
      `${bad.text.slice(0, 160)}`);
    check("…and its body is structured JSON with a stable code",
      bad.isJson && bad.json?.error?.code === expect.badCode.code,
      `isJson=${bad.isJson} body='${bad.text.slice(0, 160).replace(/\n/g, " ")}' ` +
      `(expected error.code='${expect.badCode.code}')`);
  }

  // D7 enforcement — only meaningful against a guest that claims to implement it.
  if (expect.versionEnforced) {
    const noVer = await callGuest(opts.baseUrl, "finalizeClassSession", { gameCode: "ZZZZZZ" },
      secret, { version: null });
    check("request with NO contract_version → 400", noVer.status === 400,
      `got HTTP ${noVer.status}: ${noVer.text.slice(0, 160)}`);
    check("…with code CONTRACT_VERSION_REQUIRED",
      noVer.json?.error?.code === "CONTRACT_VERSION_REQUIRED",
      `got ${JSON.stringify(noVer.json).slice(0, 160)}`);

    const badVer = await callGuest(opts.baseUrl, "finalizeClassSession", { gameCode: "ZZZZZZ" },
      secret, { version: 999 });
    check("request with an unknown major (999) → 400", badVer.status === 400,
      `got HTTP ${badVer.status}: ${badVer.text.slice(0, 160)}`);
    check("…with code UNSUPPORTED_CONTRACT_VERSION",
      badVer.json?.error?.code === "UNSUPPORTED_CONTRACT_VERSION",
      `got ${JSON.stringify(badVer.json).slice(0, 160)}`);
  } else {
    record(SKIP, "contract_version enforcement",
      "guest does not report a contract_version, so D7 is not implemented there yet.");
  }

  // 5. unknown but WELL-FORMED game code → 404
  const unknown = "ZZZZZZ"; // legal charset, vanishingly unlikely to exist
  const nf = await callGuest(opts.baseUrl, "finalizeClassSession", { gameCode: unknown }, secret);
  check("unknown well-formed game code → 404", nf.status === 404, `got HTTP ${nf.status}: ${nf.text.slice(0, 160)}`);
  checkErrorBody("404 body", nf, "not-found", expect);

  // 6. finalize on a code never provisioned → 404 (same shape; asserted separately
  //    because the brief calls it out as its own case, and a future implementation
  //    could plausibly distinguish "never existed" from "expired").
  const never = await callGuest(opts.baseUrl, "finalizeClassSession", { gameCode: "ZZZZZY" }, secret);
  check("finalize on a never-provisioned code → 404", never.status === 404,
    `got HTTP ${never.status}: ${never.text.slice(0, 160)}`);

  // 7. A MISSING MEMBER — §5.2 names this probe explicitly, and D5 is the change that
  //    makes it an error. Two flavours, both silent today:
  //      (a) an UNDER-FULL group: the guest bot-fills the gap and says nothing;
  //      (b) a member object with no studentId: skipped outright at classroom.ts:198.
  //    Recorded as baselines, not failures — today's behaviour is wrong but known, and
  //    D5 ("expected seat count is sent explicitly, and a mismatch is an error") is what
  //    changes it. When it does, these lines move and the harness says so.
  const shortStamp = Date.now();
  const shortId = `conformance-short-${shortStamp}`;
  const shortMembers = Array.from({ length: Math.max(1, opts.seats - 1) }, (_, i) => ({
    studentId: `${shortId}-s${i + 1}`,
    displayName: `Short-${i + 1}`,
  }));
  const sh = await callGuest(opts.baseUrl, "provisionClassSession",
    { instanceId: shortId, groups: [{ groupId: `sg-${shortStamp}`, members: shortMembers }] }, secret);
  const shSeats = Array.isArray(sh.json?.seats) ? sh.json.seats : [];
  baseline(`under-full group (${shortMembers.length} of ${opts.seats} seats) is accepted`,
    sh.status >= 200 && sh.status < 300 ? "accepted" : `rejected ${sh.status}`,
    "accepted", "rejected, or the seat count agreed explicitly (D5)");
  check("under-full group seats exactly the members posted (rest bot-filled server-side)",
    shSeats.length === shortMembers.length, `sent ${shortMembers.length}, seated ${shSeats.length}`);
  record(BASELINE, "nothing in the response says a seat was bot-filled",
    `body keys = ${Object.keys(sh.json ?? {}).join(",")}. The matcher cannot tell a fully ` +
    `human group from one carrying a bot.`);

  const noIdStamp = Date.now();
  const noIdInstance = `conformance-noid-${noIdStamp}`;
  const noId = await callGuest(opts.baseUrl, "provisionClassSession",
    { instanceId: noIdInstance, groups: [{ groupId: `ng-${noIdStamp}`, members: [
      { studentId: `${noIdInstance}-ok`, displayName: "Present" },
      { displayName: "NoStudentId" },
    ] }] }, secret);
  const noIdSeats = Array.isArray(noId.json?.seats) ? noId.json.seats : [];
  baseline("member object with NO studentId is silently skipped",
    noIdSeats.length === 1 ? "skipped-silently" : `seated ${noIdSeats.length}`,
    "skipped-silently", "named in a structured error (D5/D8)");
  for (const c of [sh.json?.gameCode, noId.json?.gameCode]) {
    if (c) await callGuest(opts.baseUrl, "finalizeClassSession", { gameCode: c }, secret);
  }

  // 8. one more member than the guest has seats → SILENT TRUNCATION.
  //    The contract has no seat-count field at all: the matcher's groupSize and the
  //    guest's ROLES.length are independent constants. The guest slices to its own
  //    seat count with no error and no log, so the extra student gets a working deep
  //    link and only discovers the problem at resumeClassPlayer.
  const stamp = Date.now();
  const overId = `conformance-over-${stamp}`;
  const over = Array.from({ length: opts.seats + 1 }, (_, i) => ({
    studentId: `${overId}-s${i + 1}`,
    displayName: `Overflow-${i + 1}`,
  }));
  const ov = await callGuest(opts.baseUrl, "provisionClassSession",
    { instanceId: overId, groups: [{ groupId: `og-${stamp}`, members: over }] }, secret);
  check("over-full group is ACCEPTED, not rejected (documents the absent seat-count field)",
    ov.status >= 200 && ov.status < 300, `got HTTP ${ov.status}: ${ov.text.slice(0, 160)}`);
  const ovSeats = Array.isArray(ov.json?.seats) ? ov.json.seats : [];
  check(`over-full group is silently truncated to ${opts.seats} seats`,
    ovSeats.length === opts.seats, `sent ${over.length}, seated ${ovSeats.length}`);
  const seated = new Set(ovSeats.map((s) => s.studentId));
  const dropped = over.filter((m) => !seated.has(m.studentId));
  check("exactly one member was dropped, with no error in the response",
    dropped.length === 1 && !ov.json?.error && !ov.json?.warning,
    `dropped=${dropped.length}, body keys=${Object.keys(ov.json ?? {}).join(",")}`);
  record(BASELINE, "the dropped member is reported nowhere in the response",
    `student '${dropped[0]?.studentId ?? "?"}' was silently discarded. Hardening should ` +
    `either reject the group or name the dropped members.`);

  if (ov.json?.gameCode) {
    // Close the over-full session so it does not sit in_progress for 30 days.
    await callGuest(opts.baseUrl, "finalizeClassSession", { gameCode: ov.json.gameCode }, secret);
    return { overCode: ov.json.gameCode, overInstance: overId, dropped: dropped[0]?.studentId };
  }
  return {};
}

// ── main ──────────────────────────────────────────────────────────────────────────────

/**
 * --self-test — spec §5.2/§5.4. Point the harness at a shipped, deliberately broken guest
 * and require the named assertions to come back RED. A conformance harness that has never
 * failed is not known to be reading anything, so this runs BEFORE trusting a green run.
 *
 * Inverted reporting: a FAIL from the suite is the desired outcome here. An expected
 * failure that PASSES means the harness stopped checking; an expected failure whose
 * assertion NAME has vanished means it was renamed and the proof has rotted into a rubber
 * stamp — both are reported as a broken instrument, and both exit non-zero.
 */
async function runSelfTest(opts) {
  const { startSelfTestStub, SELFTEST_SCENARIOS, SELFTEST_SECRET } = await import("./selftest-stub.mjs");

  console.log("guest-conformance --self-test — PROVING THE INSTRUMENT");
  console.log(`  ⚠ this proves the HARNESS bites. It says nothing about any real guest.`);
  console.log(`  ${SELFTEST_SCENARIOS.length} scenarios; the defects are mutually exclusive, so each`);
  console.log(`  gets its own run. Judge this by the INSTRUMENT PROOF block at the end.`);

  setBaselinesApply(false); // see baseline(): the stub is not the guest they were measured on
  let broken = 0;
  const verdicts = [];

  for (const sc of SELFTEST_SCENARIOS) {
    const { server, baseUrl } = await startSelfTestStub(sc.variant);
    console.log(`\n══ SCENARIO '${sc.variant}' — ${sc.what}`);
    console.log(`   expecting RED: ${sc.expectedFailures.join(" | ")}\n`);

    results.length = 0; // each scenario is judged on its own run
    const detected = await detectContractVersion(baseUrl);
    const seatEnforced = await detectSeatTokenEnforced(baseUrl);
    const expect = { ...(EXPECTATIONS[detected] ?? EXPECTATIONS[0]), seatTokenEnforced: seatEnforced };
    console.log(`   stub speaks contract_version ${detected} → ${expect.label}; ` +
      `seat tokens ${seatEnforced ? "enforced" : "not enforced"}`);
    check("guest enforces signed seat claims", seatEnforced === opts.expectSeatTokens,
      `enforced=${seatEnforced}, expected=${opts.expectSeatTokens}.`);
    check(`guest reports contract_version ${opts.expectVersion}`, detected === opts.expectVersion,
      `detected ${detected}.`);

    const stubOpts = { ...opts, baseUrl, playUrl: "http://127.0.0.1:0", negative: true,
      apiKey: null, apiKeyFile: null };
    await runArc(stubOpts, SELFTEST_SECRET, expect);
    await runNegative(stubOpts, SELFTEST_SECRET, expect);
    server.close();

    for (const name of sc.expectedFailures) {
      const hit = results.find((r) => r.name === name);
      if (!hit) { verdicts.push([sc.variant, name, "MISSING", "assertion renamed or removed; proof is void"]); broken += 1; }
      else if (hit.status === FAIL) verdicts.push([sc.variant, name, "BIT", "went red as required"]);
      else { verdicts.push([sc.variant, name, "BLIND", `returned ${hit.status}; the harness is not reading this`]); broken += 1; }
    }
  }

  console.log(`\n── INSTRUMENT PROOF ──`);
  for (const [variant, name, verdict, why] of verdicts) {
    const mark = verdict === "BIT" ? "✓" : "✗";
    console.log(`  ${mark} ${verdict.padEnd(8)} [${variant}] '${name}' — ${why}`);
  }
  const total = verdicts.length;
  console.log(broken === 0
    ? `\n  ✅ Instrument proved: ${total}/${total} planted defects detected across ${SELFTEST_SCENARIOS.length} scenarios.`
    : `\n  ❌ Instrument NOT proved: ${broken} problem(s) above. Do not trust a green run.`);
  process.exit(broken === 0 ? 0 : 1);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.selfTest) return runSelfTest(opts);

  const { value: secret, source } = resolveSecret(opts.secretEnv);

  console.log("guest-conformance — REAL guest endpoints, HTTP only, no beergame imports");
  console.log(`  base url    ${opts.baseUrl}`);
  console.log(`  play url    ${opts.playUrl}`);
  console.log(`  secret      ${opts.secretEnv} from ${source}`);
  console.log(`  fingerprint sha256:${fingerprint(secret)}  (value never printed)`);
  console.log(`  mode        ${opts.negative ? "arc + negative" : "arc only (add --negative)"}`);

  // D7: ask the guest which contract it speaks BEFORE asserting anything about it.
  const detected = await detectContractVersion(opts.baseUrl);
  let expect = EXPECTATIONS[detected] ?? EXPECTATIONS[0];
  // ⚠ Seat-token enforcement is NOT derivable from contract_version — pass B keeps v1 on
  // purpose. Feature-detect it and fold it into the expectation set.
  const seatTokenEnforced = await detectSeatTokenEnforced(opts.baseUrl);
  expect = { ...expect, seatTokenEnforced };
  console.log(`  guest speaks contract_version ${detected} → ${expect.label}`);
  console.log(`  signed seat claims (D2/D3): ${seatTokenEnforced ? "ENFORCED" : "NOT enforced"}` +
    `${seatTokenEnforced ? "" : "  ⚠ the unsigned-sid defect is still open on this guest"}`);
  console.log();

  // ⚠ Detection selects the expectation set; it does not excuse a regression. After this
  // pass the guest IS v1, so a guest that has stopped reporting a version is broken, not
  // "legitimately old". --expect-version 0 is how you deliberately run against a pre-D7
  // deploy to record the before-state.
  // ⚠ Detection selects the expectation set; it must not EXCUSE a regression. A guest that
  // has stopped enforcing signed claims is broken, not "legitimately old" — the same trap
  // --expect-version closes for the version, closed here for the seat token. Since pass B
  // keeps contract_version 1, this guard is the only thing standing between a silent
  // reversion and a green run.
  check("guest enforces signed seat claims", seatTokenEnforced === opts.expectSeatTokens,
    `enforced=${seatTokenEnforced}, expected=${opts.expectSeatTokens}. ` +
    `If you meant to test a pre-pass-B guest, pass --no-expect-seat-tokens.`);

  check(`guest reports contract_version ${opts.expectVersion}`, detected === opts.expectVersion,
    `detected ${detected}. If you meant to test a pre-D7 guest, pass --expect-version ${detected}.`);

  const arc = await runArc(opts, secret, expect);
  const neg = opts.negative ? await runNegative(opts, secret, expect) : {};

  // ── summary ─────────────────────────────────────────────────────────────────────────
  const count = (s) => results.filter((r) => r.status === s).length;
  console.log(`\n── SUMMARY ──`);
  console.log(`  ${PASS}: ${count(PASS)}   ${FAIL}: ${count(FAIL)}   ${BASELINE}: ${count(BASELINE)}   ${MOVED}: ${count(MOVED)}   ${SKIP}: ${count(SKIP)}`);

  if (count(MOVED) > 0) {
    console.log(`\n  ⚠ A KNOWN-CURRENT baseline MOVED. Either the hardening pass landed (update the`);
    console.log(`    baselines in this file) or the guest changed under us. Do not ignore this.`);
  }

  // ⚠ Name the PROJECT, never the collection alone — collection names repeat across games
  // and carry no project in them. Against a stub there is no project at all, and saying
  // "beergame-mygames-live" there would be a lie that could get real data deleted.
  const isRealGuest = opts.baseUrl.includes("beergame-mygames-live");
  const where = isRealGuest
    ? "the Firebase project beergame-mygames-live"
    : `${opts.baseUrl} (NOT a real Firebase project — nothing was written to beergame-mygames-live)`;
  console.log(`\n── TEST DATA LEFT BEHIND in ${where} ──`);
  if (arc.gameCode) {
    console.log(`  games/${arc.gameCode}                       status=ended`);
    console.log(`    + players/*, teams/*, classroomPlayers/*  (instanceId ${arc.instanceId})`);
  }
  if (neg.overCode) {
    console.log(`  games/${neg.overCode}                       status=ended  (over-full probe)`);
  }
  if (isRealGuest) {
    console.log(`  ⚠ NOT self-cleaning. There is no delete endpoint in the contract, and this`);
    console.log(`    harness is HTTP-only by design. Each doc carries expiresAt = +30 days.`);
    console.log(`    To remove sooner, delete those game docs in the Firebase console for the`);
    console.log(`    project beergame-mygames-live — and never in any other project, because`);
    console.log(`    'games'/'players'/'teams' are collection names that repeat across games.`);
  }

  if (opts.json) console.log(`\n${JSON.stringify({ results, arc, neg }, null, 2)}`);

  process.exit(count(FAIL) > 0 || arc.fatal ? 1 : 0);
}

main().catch((e) => {
  console.error(`\n[FATAL] ${e?.stack ?? e}`);
  process.exit(1);
});
