#!/usr/bin/env node
//
// guest-conformance.mjs — the conformance harness for a mygames.live GUEST GAME.
//
// If you received this file to test your own game: it plays the matcher's part against YOUR
// real endpoints, and asserts the wire contract in ThirdParty_Game_Integration_Contract_v1.md
// (the "contract document"; section numbers below, such as §6, refer to it). Keep it in the
// same folder as selftest-stub.mjs. It needs Node 18 or later and nothing else: every import
// is a Node built-in.
//
//   1. node guest-conformance.mjs --self-test          # prove the harness bites (§7, step 1)
//   2. MY_SECRET=… node guest-conformance.mjs --negative --secret-env MY_SECRET \
//        --base-url https://<your functions origin> --play-url https://<your play origin> \
//        --display-names declared      # or: declined — your game's declaration (§5)
//
// `--help` lists every flag. The contract document's §7 says what a clean run looks like.
//
// ⚠ IT ASSERTS CONSISTENCY WHERE A GUEST DECLARES A SHAPE; IT DOES NOT REQUIRE THE BEER
// GAME'S. Roles, team names and costByRole are the guest's to declare or omit — where it
// declares one, the rest of the contract must agree with it. What IS required is what the
// matcher reads, plus seats' teamId/playerId. (Loosened 2026-09-10: a correct single-role
// guest used to fail. --self-test's conformant-single-role scenario holds that line.)
//
// ⚠ WHY IT TALKS TO REAL ENDPOINTS. A test that runs against a mock of a game can agree with
// the mock and still miss the real game. This project once had a mock that issued game codes
// like `BEER001` — containing 0 and 1, which the real game's /^[A-Z2-9]{4,8}$/ rejects — and
// its tests were green anyway. So this harness speaks HTTP to a real deployment.
//
// ⚠ IT IMPORTS NO GAME SOURCE, ON PURPOSE. Its whole job is to test an implementation it does
// not control. Importing that implementation's own code would make it agree with itself.
// Everything below is HTTP + JSON.
//
// ⚠ KNOWN-CURRENT and BASELINE MOVED. The harness was first run against a guest that still
// had known defects; those were recorded as KNOWN-CURRENT baselines rather than as passes or
// failures, and a baseline that changes prints BASELINE MOVED. None of that applies to a v1
// guest: it must pass every assertion, apart from the two standing SKIPs (§7).
//
// ── WHAT IT DRIVES ────────────────────────────────────────────────────────────────────
//   discover seat count → provision → build deep link → claim seat → finalize →
//   finalize again → read results → read the CLASS's grades (getClassGrades, keyed on the
//   instance, with an unlisted "orphan" session that must be excluded)
//
// ── AUTH: TWO MODELS, DELIBERATELY NOT UNIFIED ────────────────────────────────────────
//   provisionClassSession / finalizeClassSession / getClassResults / getClassGrades
//       Authorization: Bearer <the shared secret>      (server-to-server; --secret-env)
//   resumeClassPlayer
//       plain HTTP with NO Authorization header — the signed seat token the matcher mints
//       is the whole credential (D2/D3). The student never carries the shared secret.
//
// ── LABELS IN THIS FILE ───────────────────────────────────────────────────────────────
// Comments and assertion names carry the project's internal decision numbers. What each
// means, and where the contract document covers it:
//   D1      no compatibility shims: an older shape is refused, not tolerated        §1
//   D2/D3   the seat claim needs a signed token, and is plain HTTP                  §3, §2.2
//   D4      display names cross only when your game declares it receives them      §5
//   D5      the seat count is sent explicitly; over-full refused, under-full reported  §4.3
//   D6      the matcher verifies the seats your provision reply returns             §2.1
//   D7/D8   contract_version on every request and reply; every error structured    §1, §4
//   D9      results are refused for a session the classroom did not create          §2.4
//   D10     a malformed results reply refuses the whole grading run                §2.4
//   D12     one play origin builds both the student link and the report link       §2.5
//   D13     each side names its copy of the shared secret as it likes              §1
//   G1/G2   your game grades its whole class, once, keyed on the instance           §6
//   G5      the matcher checks the grades' shape, never whether they make sense     §6.4
//   (D11, score direction as matcher configuration, no longer exists: your game grades.)
//   "pass C" — the last hardening round before v1 froze. A "pre-pass-C guest" is one built
//   against an earlier draft of the contract.
//   "tenant" — the matcher's configuration for one guest game (for you, your game).
//
// ── v1 AND ITS VERSION NUMBER ─────────────────────────────────────────────────────────
// Several revisions before the freeze changed payload shapes WITHOUT bumping
// contract_version: nothing outside the project had spoken the contract yet, so a bump would
// have invented version history for revisions nobody used. v1 is now frozen (see the
// contract document's header). So the version cannot select these expectations, and this
// file does not try: v1's expectations ARE the frozen v1. A guest built against an earlier
// draft fails them, and detectSeatCount() makes that failure name itself in one line instead
// of a dozen unexplained reds.
//
// ── DISPLAY NAMES: DECLARED PER GAME ──────────────────────────────────────────────────
// Whether your game receives students' display names is declared once for your game (§5), not
// carried in the contract version and not a default. Neither the version nor your game can
// tell the harness which to expect, so the harness is TOLD:
//   --display-names declared   members carry displayName; the seat claim must return it
//   --display-names declined   no names are sent;          the seat claim must carry none
// ⚠ Always pass it. Against any guest except the Beer Game's own deployment, a missing flag
// is fatal: guessing would pass a guest that leaks names, or fail one that correctly withholds
// them. (Against the Beer Game, inside the mygames project, the harness can instead read the
// declaration from the matcher's code. That path does not exist on your machine.)
//
// ── SECRETS ───────────────────────────────────────────────────────────────────────────
// The harness plays the matcher, so it needs the shared secret your server-to-server
// endpoints check (§1). Put it in an environment variable and name that variable with
// --secret-env. The value is never printed, logged, passed on a command line, or written to
// a file; only an 8-character fingerprint is shown. (Without --secret-env, the harness looks
// for the matcher's own copy of the Beer Game's secret, which only exists inside the mygames
// project. If it finds nothing, it stops and tells you what to pass.)
//
// Requires Node 18+ (global fetch).

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createHash, createHmac } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const MATCHER_ROOT = join(HERE, "..");

// ── configuration ─────────────────────────────────────────────────────────────────────

const MATCHER_PROJECT = "matcher-mygames-live";
const SECRET_NAME = "PROVISION_SECRET_BEERGAME";

// ── CONTRACT VERSION + VERSION-KEYED EXPECTATIONS (D7/D8 — contract §1, §4) ───────────
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

// ── SEAT TOKENS (D2 — contract §3) ────────────────────────────────────────────
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

/**
 * The matcher's getClassResults validation — functions/src/handoff.ts parseGuestResults —
 * DUPLICATED on purpose, like the seat-token mint above: this harness imports no source.
 * Returns null when the matcher would accept the reply, otherwise the reason it would refuse
 * the whole grading run. ⚠ If parseGuestResults changes, change this with it.
 */
function matcherResultsProblem(o, gameCode) {
  if (!o || typeof o !== "object") return "the reply is not a JSON object";
  if (o.ok !== true) return `ok is ${JSON.stringify(o.ok)}, not true`;
  if (o.gameCode !== gameCode) return `it answers for ${JSON.stringify(o.gameCode)}`;
  if (!Array.isArray(o.teams)) return "teams is not an array";
  if (!Array.isArray(o.players)) return "players is not an array";
  if (o.players.length === 0) return "players is empty for a provisioned session";
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const numOrNull = (v) => v === null || isNum(v);
  const strOrNull = (v) => v === null || typeof v === "string";
  for (const [i, t] of o.teams.entries()) {
    const r = t ?? {};
    if (typeof r.teamId !== "string" || !r.teamId) return `teams[${i}].teamId is missing`;
    if (typeof r.teamName !== "string") return `teams[${i}].teamName is not a string`;
    if (!isNum(r.teamCost)) return `teams[${i}].teamCost is not a number`;
  }
  for (const [i, p] of o.players.entries()) {
    const r = p ?? {};
    if (typeof r.studentId !== "string" || !r.studentId) return `players[${i}].studentId is missing`;
    if (typeof r.participated !== "boolean") return `players[${i}].participated is not a boolean`;
    if (!strOrNull(r.role) || !strOrNull(r.teamId) || !strOrNull(r.teamName)) {
      return `players[${i}] role/teamId/teamName must be string or null`;
    }
    if (!numOrNull(r.teamCost) || !numOrNull(r.individualCost)) {
      return `players[${i}] teamCost/individualCost must be number or null`;
    }
  }
  return null;
}

/**
 * The matcher's getClassGrades validation — functions/src/handoff.ts verifyGuestGrades (G5) —
 * DUPLICATED on purpose, like matcherResultsProblem above. Shape, never sensibility: one row per
 * student sent, a finite number or null, a label. ⚠ If verifyGuestGrades changes, change this.
 */
function matcherGradesProblem(o, instanceId, sentStudentIds) {
  if (!o || typeof o !== "object") return "the reply is not a JSON object";
  if (o.ok !== true) return `ok is ${JSON.stringify(o.ok)}, not true`;
  if (o.instanceId !== instanceId) return `it answers for instance ${JSON.stringify(o.instanceId)}`;
  if (!Array.isArray(o.grades)) return "grades is not an array";
  const sent = new Set(sentStudentIds);
  const seen = new Set();
  for (const [i, g] of o.grades.entries()) {
    const r = g ?? {};
    if (typeof r.studentId !== "string" || !r.studentId) return `grades[${i}].studentId is missing`;
    if (!sent.has(r.studentId)) return `grades[${i}] is for ${r.studentId}, a student the matcher never sent`;
    if (seen.has(r.studentId)) return `${r.studentId} is graded twice`;
    seen.add(r.studentId);
    if (!(r.value === null || (typeof r.value === "number" && Number.isFinite(r.value)))) {
      return `grades[${i}].value for ${r.studentId} is ${JSON.stringify(r.value)}, not a finite number or null`;
    }
    if (typeof r.label !== "string" || !r.label.trim()) return `grades[${i}].label for ${r.studentId} is missing`;
  }
  const missing = sentStudentIds.filter((s) => !seen.has(s));
  if (missing.length) return `${missing.length} student(s) sent got no grade row: ${missing.join(", ")}`;
  return null;
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
    label: "v1 (D7/D8, D2/D3 seat tokens, pass C D5/D6/D9, display names per tenant)",
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
  // ⚠ NO SEAT COUNT HERE ANY MORE. It used to be `seats: 4` (overridable with --seats) — a
  // THIRD copy of a number the matcher (groupSize) and the guest (ROLES.length) each declare
  // independently, which meant the over-full probe could silently test the wrong boundary.
  // D5 makes the guest DECLARE its seat count (error.expectedSeatCount on
  // SEAT_COUNT_REQUIRED), so the harness reads it from the guest under test. See
  // detectSeatCount().
};

function parseArgs(argv) {
  const out = { ...DEFAULTS, negative: false, selfTest: false, secretEnv: SECRET_NAME,
    expectVersion: CONTRACT_VERSION, expectSeatTokens: true, apiKey: null, apiKeyFile: null, json: false,
    displayNames: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[(i += 1)];
    if (a === "--negative") out.negative = true;
    else if (a === "--self-test") out.selfTest = true;
    else if (a === "--secret-env") out.secretEnv = next();
    else if (a === "--expect-version") out.expectVersion = Number(next());
    else if (a === "--no-expect-seat-tokens") out.expectSeatTokens = false;
    else if (a === "--display-names") {
      const v = next();
      if (v !== "declared" && v !== "declined") {
        console.error(`--display-names takes 'declared' or 'declined', got '${v}'.`);
        process.exit(2);
      }
      out.displayNames = v;
    }
    else if (a === "--json") out.json = true;
    else if (a === "--base-url") out.baseUrl = next().replace(/\/$/, "");
    else if (a === "--play-url") out.playUrl = next().replace(/\/$/, "");
    else if (a === "--seats") {
      console.error("--seats is retired: the seat count is now read from the guest itself (D5). " +
        "Remove the flag.");
      process.exit(2);
    }
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
  --display-names declared|declined
                        the guest's tenant declaration (matcher tenants.ts
                        receivesDisplayNames). Read from the matcher's compiled tenant when
                        testing that tenant's own guest; REQUIRED against any other guest.
  --base-url <url>      guest functions origin   (default ${DEFAULTS.baseUrl})
  --play-url <url>      guest play origin        (default ${DEFAULTS.playUrl})
  --api-key <key>       Firebase Web API key for the guest project (public, in-bundle
                        value; needed ONLY to mint the anonymous token resumeClassPlayer
                        requires). Or set BEERGAME_WEB_API_KEY.
  --api-key-file <path> read VITE_FIREBASE_API_KEY from a .env file instead of typing it
  --json                emit machine-readable results as well as the report
`);
}

// ── secret resolution ─────────────────────────────────────────────────────────────────
//
// Looked for, in order:
//   1. the environment variable named by --secret-env. This is the path for your game.
//   2. only inside the mygames project, testing the Beer Game: the matcher's local copy of its
//      secret (functions/.secret.local), then Google Secret Manager through the gcloud CLI.
//      Neither exists on your machine. If step 1 finds nothing, the harness stops with
//      instructions rather than guessing.
//
// ⚠ The value is held in a local, never printed, never written anywhere, and never passed
// as a command-line argument. Only an 8-char SHA-256 fingerprint is displayed, which is
// enough to tell "the two sides hold different values" from "the endpoint is broken"
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

/**
 * Which display-name expectation applies — the TENANT's declaration, never a guess. See the
 * DISPLAY NAMES note in the header: the flag wins; otherwise the matcher's own compiled tenant,
 * but only for that tenant's own guest; otherwise fatal.
 */
function resolveDisplayNames(opts) {
  if (opts.displayNames) return { mode: opts.displayNames, source: "--display-names" };
  const lib = join(MATCHER_ROOT, "functions", "lib", "tenants.js");
  if (existsSync(lib)) {
    try {
      const t = createRequire(import.meta.url)(lib).ACTIVE_TENANT;
      const origin = t?.handoff?.provisionUrl ? new URL(t.handoff.provisionUrl).origin : null;
      if (typeof t?.receivesDisplayNames === "boolean" && origin === opts.baseUrl) {
        return { mode: t.receivesDisplayNames ? "declared" : "declined",
          source: `matcher tenant '${t.gameId}' (functions/lib/tenants.js)` };
      }
    } catch { /* fall through to the fatal below */ }
  }
  console.error(`
[FATAL] Say whether this guest's tenant receives display names:
    --display-names declared    the matcher sends displayName; the seat claim must return it
    --display-names declined    no names are sent; the seat claim must carry none
  The harness reads this from the matcher's compiled tenant only when testing that tenant's
  own guest (${opts.baseUrl} is not it, or functions/lib is not built). It will not guess.
`);
  process.exit(2);
}

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
 * D5 — "The expected seat count is sent explicitly, and a mismatch is an error." Ask the
 * guest how many seats a group has, WITHOUT creating anything.
 *
 * The probe: a correctly authenticated, correctly versioned provision with NO seatCount and
 * an EMPTY groups[]. A pass-C guest checks seatCount before groups[] and answers 400
 * SEAT_COUNT_REQUIRED carrying an integer error.expectedSeatCount. A guest that predates
 * pass C has no seat-count field and answers 400 GROUPS_REQUIRED instead — and the empty
 * groups[] is what makes the probe safe on both: it is refused before anything is written.
 *
 * ⚠ Not a version selector. An undeclared seat count is a FAIL ("guest declares its seat
 * count (D5)"); this function only lets the harness say WHY in one line.
 */
async function detectSeatCount(baseUrl, secret) {
  const probe = await callGuest(baseUrl, "provisionClassSession", { groups: [] }, secret);
  const n = probe.json?.error?.expectedSeatCount;
  const declared = probe.status === 400 && probe.json?.error?.code === "SEAT_COUNT_REQUIRED" &&
    Number.isInteger(n) && n > 0;
  return { seatCount: declared ? n : null, probe };
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
  // DISPLAY NAMES are per tenant (see the header). For a names-declared tenant the members
  // carry a distinctive canary name, so the seat claim can be held to returning EXACTLY the
  // name sent, and the results payload scanned whole for it (names flow INTO the guest; the
  // matcher-facing results never carry them). For a tenant that declined, none is sent.
  const canary = `ZZCanary${stamp}`;
  const namesDeclared = expect.displayNames === "declared";
  // ⚠ Exactly the guest's DECLARED seat count (D5): a full group, so every seat is human and
  // the bot report must say zero. With no declaration, ONE member — never over-full on any
  // guest — and the D5 guard in main() has already failed by name.
  const seatCount = expect.seatCount ?? null;
  const n = seatCount ?? 1;
  const members = Array.from({ length: n }, (_, i) => ({
    studentId: `${instanceId}-s${i + 1}`,
    ...(namesDeclared ? { displayName: `${canary}-${i + 1}` } : {}),
  }));

  console.log(`\n── ARC ── instance ${instanceId}, ${members.length} members, ` +
    `seatCount ${seatCount ?? "(undeclared)"}, display names ${expect.displayNames}\n`);

  // 1. provision ──────────────────────────────────────────────────────────────────────
  const prov = await callGuest(opts.baseUrl, "provisionClassSession",
    { instanceId, seatCount: n, groups: [{ groupId, members }], config: { nWeeks: 12, customerDemand: Array.from({ length: 12 }, (_, i) => (i < 4 ? 4 : 8)) } },
    secret);

  check("provision returns 2xx", prov.status >= 200 && prov.status < 300, `got HTTP ${prov.status}: ${prov.text.slice(0, 200)}`);
  if (!prov.json?.gameCode) {
    record(FAIL, "provision returns a gameCode", `body: ${prov.text.slice(0, 200)}`);
    return { fatal: true };
  }
  const gameCode = prov.json.gameCode;

  // ⚠ The real regex, from the contract (§1). A mock game once issued codes like BEER001,
  // which this pattern rejects; this is the line that catches a guest doing the same.
  check("gameCode matches the real /^[A-Z2-9]{4,8}$/", /^[A-Z2-9]{4,8}$/.test(gameCode), `got '${gameCode}'`);

  // D7: "Echoed in every response." Success bodies too, not only errors.
  if (expect.versionEchoed) {
    check("provision response echoes contract_version", prov.json?.contract_version === CONTRACT_VERSION,
      `got contract_version=${JSON.stringify(prov.json?.contract_version)}`);
  }

  const seats = Array.isArray(prov.json.seats) ? prov.json.seats : [];
  check("seats[] returned, one per member", seats.length === members.length, `got ${seats.length}, sent ${members.length}`);
  // ⚠ CONSISTENCY, NOT THE BEER GAME'S SHAPE (2026-09-10). This used to require a `role` on
  // every seat and the roles within a group to be DISTINCT — the Beer Game's four supply-chain
  // roles. The matcher's own stage family seats ONE undifferentiated 'player' role everywhere,
  // so a guest built like infoshare failed here while being correct (--self-test's
  // conformant-single-role scenario went FALSE-RED on exactly this). Whether a seat has a role
  // is the guest's to declare; where it declares one, the seat claim must agree (below).
  // The matcher reads only studentId and groupId; teamId and playerId stay required.
  check("every seat carries studentId/teamId/playerId/groupId",
    seats.every((s) => s.studentId && s.teamId && s.playerId && s.groupId),
    JSON.stringify(seats.slice(0, 2)));
  check("our groupId is echoed back, not replaced", seats.every((s) => s.groupId === groupId),
    `got ${JSON.stringify([...new Set(seats.map((s) => s.groupId))])}`);

  // ⚠ D6 — the matcher verifies the seats array your provision reply returns (contract §2.1):
  // every member it posted must get exactly one seat, or it refuses the hand-off. The harness
  // makes the same check here. --self-test's `classic` scenario drops a member, and this goes red.
  const seatedIds = new Set(seats.map((s) => s.studentId));
  const unseated = members.filter((m) => !seatedIds.has(m.studentId));
  check("every posted member received a seat", unseated.length === 0,
    `${unseated.length} posted member(s) got no seat: ${unseated.map((m) => m.studentId).join(", ")}`);
  check("no member was seated twice", seats.length === seatedIds.size,
    `${seats.length} seats for ${seatedIds.size} distinct students`);

  // ⚠ D5/D6 — the guest must SAY how it filled every seat, so the matcher can verify the
  // hand-off instead of inferring it. This is a full group: every seat human, zero bots.
  check("provision echoes the seatCount it was sent", prov.json?.seatCount === n,
    `sent ${n}, got ${JSON.stringify(prov.json?.seatCount)}`);
  const report = (Array.isArray(prov.json?.groups) ? prov.json.groups : [])
    .find((g) => g?.groupId === groupId);
  check("provision reports each group's human and bot seats",
    Boolean(report) && report.humanSeats === members.length && report.botSeats === 0,
    `got groups=${JSON.stringify(prov.json?.groups ?? null).slice(0, 200)}`);
  check("the provision reply does not echo student names",
    !prov.text.includes(canary), `name canary '${canary}' echoed by provisionClassSession`);

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
  check("seat payload carries playerId/sessionToken",
    Boolean(claimed?.playerId && claimed?.sessionToken),
    JSON.stringify(claimed ?? {}).slice(0, 200));
  // Assert only what PROVISIONING declared for this seat: where it gave a role / teamId /
  // teamName, the claim must return the same value; where it gave none, nothing is asserted.
  // (teamId is required on every seat above, so it is always declared and always checked.)
  for (const key of ["role", "teamId", "teamName"]) {
    if (target[key] == null) continue;
    check(`${key} matches the seat provisioning assigned`, claimed?.[key] === target[key],
      `provision said '${target[key]}', claim said '${claimed?.[key]}'`);
  }
  if (expect.versionEchoed) {
    check("seat claim echoes contract_version", claimed?.contract_version === CONTRACT_VERSION,
      `got ${JSON.stringify(claimed?.contract_version)}`);
  }
  // ⚠ DISPLAY NAMES, PER TENANT. This assertion has now changed twice: before pass C it said
  // the name came back ("documents the PII crossing"); pass C's D4 inverted it to "absent";
  // D4 is reversed, and the expectation is now the TENANT's declaration. contract_version
  // stays 1 and cannot express a per-tenant choice, so the harness is TOLD which applies
  // (--display-names, or the matcher's own compiled tenant) — it never infers it.
  // Conditioned on the claim SUCCEEDING, so an error body cannot pass either branch vacuously.
  const claimOk = claim.status >= 200 && claim.status < 300 && claimed !== null;
  if (namesDeclared) {
    const sentName = members.find((m) => m.studentId === target.studentId)?.displayName;
    check("seat claim returns the display name the matcher sent (names declared)",
      claimOk && claimed.name === sentName,
      `HTTP ${claim.status}; sent '${sentName}', claim name=${JSON.stringify(claimed?.name)}`);
  } else {
    check("seat claim carries no name (names declined)",
      claimOk && !("name" in claimed),
      `HTTP ${claim.status}; name=${JSON.stringify(claimed?.name)} — a tenant that declined names was handed one`);
  }

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
    // ⚠ Never fall back to the TARGET's own seat. With a one-seat group (a guest declaring
    // seatCount 1, or the one-member arc a pre-pass-C guest gets) `seats[1]` does not exist,
    // and the old `seats[1] ?? seats[0]` minted a token for the very seat being claimed — a
    // VALID token, so the "refusal" was granted and two lines went red for a harness bug.
    // The pass-C negative control caught it. Any other identity proves non-transfer.
    const otherId = seats.find((s) => s.studentId !== target.studentId)?.studentId ??
      `${target.studentId}-not-this-seat`;
    const wrongSeat = mintSeatToken(gameCode, otherId, secret);
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
  check("teams[] carry teamId/teamName/teamCost",
    teams.every((t) => t.teamId && typeof t.teamName === "string" && "teamCost" in t),
    JSON.stringify(teams[0] ?? {}));
  // costByRole is the Beer Game's per-role breakdown and the matcher never reads it. It used
  // to be required; now absent passes and present must be an object (2026-09-10).
  const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  check("teams[].costByRole, when present, is an object",
    teams.every((t) => !("costByRole" in t) || isPlainObject(t.costByRole)),
    JSON.stringify(teams.map((t) => t.costByRole)).slice(0, 200));
  // ⚠ THE MATCHER'S OWN VALIDATION. Until 2026-09-10 the checks above were LOOSER than what
  // the matcher enforces: a guest that omitted players[].teamName, or sent teamCost as a
  // string, went green here and then had its class's entire grading run refused (D10).
  const matcherProblem = matcherResultsProblem(rr.json, gameCode);
  check("results pass the matcher's grading validation (D10)", matcherProblem === null,
    matcherProblem ?? "");

  // The canary assertion: the student NAME must not cross back out.
  check("results contain NO student name (canary absent from the whole payload)",
    !JSON.stringify(rr.json).includes(canary),
    `canary '${canary}' leaked into getClassResults`);

  if (claimed) {
    const row = players.find((p) => p.studentId === target.studentId);
    check("the student who claimed a seat is marked participated", row?.participated === true,
      `participated=${row?.participated}`);
  }

  return { gameCode, instanceId, members, teams: teams.length, fatal: false,
    claimedStudentId: claimed?.sessionToken ? target.studentId : null };
}

// ── getClassGrades — the guest grades its own class (G1/G2 — contract §6) ──────────────
//
// Keyed on the INSTANCE. The matcher lists the sessions it recorded; the guest grades exactly
// those. ⚠ The ORPHAN below is what a refused hand-off (D6) leaves behind: a session carrying the
// SAME instance id that the matcher never recorded. It is provisioned and deliberately NOT listed,
// and none of its students may be graded.
async function runGrades(opts, secret, expect, arc) {
  console.log(`\n── GRADES ── getClassGrades for instance ${arc.instanceId}\n`);
  const orphanMember = { studentId: `${arc.instanceId}-orphan-1`,
    ...(expect.displayNames === "declared" ? { displayName: "Orphan Student" } : {}) };
  const orphan = await callGuest(opts.baseUrl, "provisionClassSession",
    { instanceId: arc.instanceId, seatCount: expect.seatCount ?? 1,
      groups: [{ groupId: `orphan-${Date.now()}`, members: [orphanMember] }] }, secret);
  const orphanCode = orphan.json?.gameCode ?? null;
  if (orphanCode) await callGuest(opts.baseUrl, "finalizeClassSession", { gameCode: orphanCode }, secret);

  const gr = await callGuest(opts.baseUrl, "getClassGrades", { instanceId: arc.instanceId, gameCodes: [arc.gameCode] }, secret);
  check("getClassGrades returns 2xx", gr.status >= 200 && gr.status < 300, `HTTP ${gr.status}: ${gr.text.slice(0, 200)}`);
  if (expect.versionEchoed) {
    check("grades response echoes contract_version", gr.json?.contract_version === CONTRACT_VERSION,
      `got contract_version=${JSON.stringify(gr.json?.contract_version)}`);
  }
  const problem = matcherGradesProblem(gr.json, arc.instanceId, arc.members.map((m) => m.studentId));
  check("grade rows pass the matcher's grade validation (G5)", problem === null, problem ?? "");
  const rows = Array.isArray(gr.json?.grades) ? gr.json.grades : [];
  // ⚠ Conditioned on a 2xx: with no rows at all (an endpoint that is missing or failing) "the
  // orphan is not in the rows" would be true of nothing, and pass vacuously.
  check("sessions not listed are excluded (a refused hand-off's orphan)",
    gr.status >= 200 && gr.status < 300 && rows.length > 0 && orphanCode !== null &&
      !rows.some((r) => r?.studentId === orphanMember.studentId),
    orphanCode === null ? `could not provision the orphan: HTTP ${orphan.status} ${orphan.text.slice(0, 120)}`
      : `the unlisted orphan's student was graded: ${JSON.stringify(rows.find((r) => r?.studentId === orphanMember.studentId))}`);
  if (arc.claimedStudentId) {
    const row = rows.find((r) => r?.studentId === arc.claimedStudentId);
    check("a student who claimed their seat has a finite grade", typeof row?.value === "number" && Number.isFinite(row.value),
      JSON.stringify(row ?? null));
  }
  if (!opts.negative) return { orphanCode };

  const expectErr = (name, res, status, code) =>
    check(name, res.status === status && res.json?.error?.code === code, `HTTP ${res.status}: ${res.text.slice(0, 160)}`);
  expectErr("grades with NO instanceId → 400 INSTANCE_ID_REQUIRED",
    await callGuest(opts.baseUrl, "getClassGrades", { gameCodes: [arc.gameCode] }, secret), 400, "INSTANCE_ID_REQUIRED");
  expectErr("grades with NO gameCodes → 400 GAME_CODES_REQUIRED",
    await callGuest(opts.baseUrl, "getClassGrades", { instanceId: arc.instanceId }, secret), 400, "GAME_CODES_REQUIRED");
  expectErr("a session from another instance → 409 SESSION_NOT_IN_INSTANCE",
    await callGuest(opts.baseUrl, "getClassGrades", { instanceId: `${arc.instanceId}-other`, gameCodes: [arc.gameCode] }, secret),
    409, "SESSION_NOT_IN_INSTANCE");
  expectErr("grades with a wrong secret → 401",
    await callGuest(opts.baseUrl, "getClassGrades", { instanceId: arc.instanceId, gameCodes: [arc.gameCode] }, "wrong-secret-on-purpose"),
    401, "UNAUTHORIZED");
  return { orphanCode };
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
  // ⚠ Carries a VALID seatCount when the guest declared one. Pass C checks seatCount BEFORE
  // groups[] (that order is what makes the discovery probe safe), so without it this probe
  // never reaches the groups check — the first pass-C emulator run got SEAT_COUNT_REQUIRED here.
  const empty = await callGuest(opts.baseUrl, "provisionClassSession",
    { ...(expect.seatCount != null ? { seatCount: expect.seatCount } : {}), groups: [] }, secret);
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

  // 7. D5 — THE SEAT COUNT, MADE EXPLICIT ─────────────────────────────────────────────
  // D5 — "The expected seat count is sent explicitly, and a mismatch is an error. Today the
  // guest infers bot-fill from which seats came up empty, and this works only because the
  // matcher's groupSize happens to equal the guest's ROLES.length. Nothing checks it."
  //
  // Until pass C these were FOUR KNOWN-CURRENT baselines, characterised on production on
  // 2026-09-09: an under-full group accepted silently; an over-full group truncated with the
  // dropped member reported nowhere; a member with no studentId skipped silently; and (found
  // on production, missed by the extract) nothing in the reply saying a seat was bot-filled.
  // Each is now an assertion. The design, stated here so it is not re-derived:
  //   OVER-FULL   → REJECTED (GROUP_OVERFULL). There is no seat for the extra student; the
  //                 old truncation handed him a working-looking link that dead-ended.
  //   UNDER-FULL  → ACCEPTED AND REPORTED. It is the designed bot-fill path — the matcher
  //                 posts humans only and the guest fills the rest — so rejecting it would
  //                 break every group carrying a matcher placeholder. What was wrong was the
  //                 SILENCE: the reply now says, per group, how many seats went to bots.
  //   NO studentId, DUPLICATE studentId, EMPTY group → REJECTED, before anything is written.
  // Every rejection is also checked for "nothing was provisioned", so a guest that errors
  // AND creates a session cannot pass.
  const N = expect.seatCount ?? null;
  const probeCodes = [];
  // ⚠ OMIT is a sentinel, NOT `undefined`. A default parameter swallows an explicit
  // undefined, so `provision(tag, groups, undefined)` used to SEND seatCount = N — and the
  // "no seatCount" probe provisioned a real session. The first pass-C emulator run caught it;
  // the self-test could not, because it only proved defects go red, never that a correct
  // guest stays green (the `conformant` scenario now proves that too).
  const OMIT = Symbol("omit seatCount");
  const provision = async (tag, groups, seatCount = N) => {
    const r = await callGuest(opts.baseUrl, "provisionClassSession",
      { instanceId: `conformance-${tag}-${Date.now()}`,
        ...(seatCount === OMIT ? {} : { seatCount }), groups }, secret);
    if (r.json?.gameCode) probeCodes.push(r.json.gameCode);
    return r;
  };
  const people = (tag, k) => Array.from({ length: k }, (_, i) => ({ studentId: `conformance-${tag}-${Date.now()}-s${i + 1}` }));
  const refused = (name, r, code) => {
    check(`${name} → 400 ${code}`, r.status === 400 && r.json?.error?.code === code,
      `got HTTP ${r.status}: ${r.text.slice(0, 200)}`);
    check(`${name} — nothing was provisioned`, !r.json?.gameCode,
      `a gameCode came back (${r.json?.gameCode}) — the request was accepted after all`);
  };

  if (N === null) {
    record(SKIP, "D5 seat-count probes",
      "the guest declared no seat count, so there is no boundary to probe. " +
      "The D5 guard has already failed by name.");
  } else {
    // (a) The declaration itself — the discovery probe, asserted as its own line.
    const noCount = await provision("noseat", [{ members: people("noseat", N) }], OMIT);
    refused("provision with NO seatCount", noCount, "SEAT_COUNT_REQUIRED");
    check("…and the error declares the guest's seat count (error.expectedSeatCount)",
      noCount.json?.error?.expectedSeatCount === N,
      `got ${JSON.stringify(noCount.json?.error ?? null).slice(0, 160)}`);

    // (b) A seat count the guest does not have — the coupling D5 makes explicit.
    refused("seatCount mismatch", await provision("mismatch", [{ members: people("mismatch", N) }], N + 1),
      "SEAT_COUNT_MISMATCH");

    // (c) Over-full — rejected, never truncated. The boundary is the GUEST's declared
    //     count + 1, so it cannot be the wrong boundary (the --seats risk, closed).
    refused("over-full group", await provision("over", [{ members: people("over", N + 1) }]),
      "GROUP_OVERFULL");

    // (d) A member with no studentId — rejected, never skipped.
    refused("member with no studentId",
      await provision("noid", [{ members: [...people("noid", 1), { displayName: "NoStudentId" }] }]),
      "MEMBER_STUDENT_ID_REQUIRED");

    // (e) The same student twice — the two seats would collide on one seat lock.
    const twice = people("dup", 1)[0];
    refused("duplicate studentId", await provision("dup", [{ members: [twice, { ...twice }] }]),
      "DUPLICATE_STUDENT_ID");

    // (f) A group with nobody in it — a team of bots is not a class.
    refused("group with no members", await provision("empty", [{ members: [] }]), "GROUP_EMPTY");

    // (g) Under-full — accepted, and the bot-fill REPORTED.
    if (N < 2) {
      record(SKIP, "under-full group probes", `the guest seats ${N}; a group cannot be under-full.`);
    } else {
      const ug = `ug-${Date.now()}`;
      const few = people("under", N - 1);
      const under = await provision("under", [{ groupId: ug, members: few }]);
      check("under-full group is ACCEPTED (the designed bot-fill path)",
        under.status >= 200 && under.status < 300, `got HTTP ${under.status}: ${under.text.slice(0, 200)}`);
      const uSeats = Array.isArray(under.json?.seats) ? under.json.seats : [];
      check("under-full group seats exactly the members posted",
        uSeats.length === few.length && few.every((m) => uSeats.some((s) => s.studentId === m.studentId)),
        `sent ${few.length}, seated ${uSeats.length}`);
      const uRep = (Array.isArray(under.json?.groups) ? under.json.groups : []).find((g) => g?.groupId === ug);
      check("under-full group reports its bot-filled seats (botSeats = seatCount − members)",
        Boolean(uRep) && uRep.humanSeats === few.length && uRep.botSeats === N - few.length,
        `got groups=${JSON.stringify(under.json?.groups ?? null).slice(0, 200)}`);
    }
  }

  // 8. D9 — getClassResults refuses a session the classroom did not provision.
  // ⚠ Honest limit, like finalize's re-fire: this harness can only CREATE classroom
  // sessions, so it cannot produce the thing D9 refuses. The Beer Game's refusal was verified
  // separately, on an emulator, against a seeded non-classroom session.
  record(SKIP, "results refuse a non-classroom session (D9)",
    "not observable over HTTP — this harness can only create classroom sessions.");

  // Close every session the probes created, so none sits in_progress for 30 days.
  for (const c of probeCodes) await callGuest(opts.baseUrl, "finalizeClassSession", { gameCode: c }, secret);
  return { probeCodes };
}

// ── main ──────────────────────────────────────────────────────────────────────────────

/**
 * --self-test (contract §7, step 1). Point the harness at a shipped, deliberately broken guest
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
    const { seatCount } = await detectSeatCount(baseUrl, SELFTEST_SECRET);
    // Each scenario states its tenant's display-name declaration — the self-test is told,
    // exactly as a real run is.
    const displayNames = sc.displayNames ?? "declared";
    const expect = { ...(EXPECTATIONS[detected] ?? EXPECTATIONS[0]), seatTokenEnforced: seatEnforced,
      seatCount, displayNames };
    console.log(`   stub speaks contract_version ${detected} → ${expect.label}; ` +
      `seat tokens ${seatEnforced ? "enforced" : "not enforced"}; seat count ${seatCount ?? "undeclared"}; ` +
      `display names ${displayNames}`);
    check("guest enforces signed seat claims", seatEnforced === opts.expectSeatTokens,
      `enforced=${seatEnforced}, expected=${opts.expectSeatTokens}.`);
    check("guest declares its seat count (D5)", seatCount !== null,
      "no integer error.expectedSeatCount on a provision without seatCount.");
    check(`guest reports contract_version ${opts.expectVersion}`, detected === opts.expectVersion,
      `detected ${detected}.`);

    const stubOpts = { ...opts, baseUrl, playUrl: "http://127.0.0.1:0", negative: true,
      apiKey: null, apiKeyFile: null };
    const stubArc = await runArc(stubOpts, SELFTEST_SECRET, expect);
    if (!stubArc.fatal) await runGrades(stubOpts, SELFTEST_SECRET, expect, stubArc);
    await runNegative(stubOpts, SELFTEST_SECRET, expect);
    server.close();

    for (const name of sc.expectedFailures) {
      const hit = results.find((r) => r.name === name);
      if (!hit) { verdicts.push([sc.variant, name, "MISSING", "assertion renamed or removed; proof is void"]); broken += 1; }
      else if (hit.status === FAIL) verdicts.push([sc.variant, name, "BIT", "went red as required"]);
      else { verdicts.push([sc.variant, name, "BLIND", `returned ${hit.status}; the harness is not reading this`]); broken += 1; }
    }
    // ⚠ THE OTHER HALF OF THE PROOF. Everything above shows the harness goes red on a defect;
    // it cannot show the harness stays GREEN on a correct guest. Two harness bugs (a probe
    // that sent the seatCount it meant to omit, a probe that never reached the check it was
    // named for) passed the whole defect proof and surfaced only against the real guest. A
    // scenario with NO defect must now produce ZERO failures, or the instrument is broken.
    if (sc.expectClean) {
      const reds = results.filter((r) => r.status === FAIL);
      for (const r of reds) {
        verdicts.push([sc.variant, r.name, "FALSE-RED", "a CORRECT guest failed this — the harness is wrong"]);
        broken += 1;
      }
      if (reds.length === 0) {
        verdicts.push([sc.variant, "(every assertion)", "CLEAN",
          `${results.filter((r) => r.status === PASS).length} passed, 0 failed against a correct guest`]);
      }
    }
  }

  console.log(`\n── INSTRUMENT PROOF ──`);
  for (const [variant, name, verdict, why] of verdicts) {
    const mark = verdict === "BIT" || verdict === "CLEAN" ? "✓" : "✗";
    console.log(`  ${mark} ${verdict.padEnd(9)} [${variant}] '${name}' — ${why}`);
  }
  const bit = verdicts.filter((v) => v[2] === "BIT").length;
  const planted = SELFTEST_SCENARIOS.reduce((n, s) => n + s.expectedFailures.length, 0);
  console.log(broken === 0
    ? `\n  ✅ Instrument proved: ${bit}/${planted} planted defects detected, and a correct guest drew ` +
      `0 false reds, across ${SELFTEST_SCENARIOS.length} scenarios.`
    : `\n  ❌ Instrument NOT proved: ${broken} problem(s) above. Do not trust a green run.`);
  process.exit(broken === 0 ? 0 : 1);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.selfTest) return runSelfTest(opts);

  // Resolved FIRST, so a run with no declaration fails before touching anything.
  const names = resolveDisplayNames(opts);
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
  // D5: the seat count comes FROM THE GUEST, never from this file (--seats is retired).
  const { seatCount } = await detectSeatCount(opts.baseUrl, secret);
  expect = { ...expect, seatTokenEnforced, seatCount, displayNames: names.mode };
  console.log(`  guest speaks contract_version ${detected} → ${expect.label}`);
  console.log(`  signed seat claims (D2/D3): ${seatTokenEnforced ? "ENFORCED" : "NOT enforced"}` +
    `${seatTokenEnforced ? "" : "  ⚠ the unsigned-sid defect is still open on this guest"}`);
  console.log(`  seat count (D5): ${seatCount !== null ? `${seatCount}, declared by the guest`
    : "NOT DECLARED  ⚠ this guest predates pass C — it speaks v1 but not the frozen v1"}`);
  console.log(`  display names: ${names.mode}  (the tenant's declaration, from ${names.source})`);
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

  // ⚠ Deliberately NO opt-out flag, unlike --no-expect-seat-tokens. Pass C is the last pass
  // before v1 freezes; there is no older v1 worth recording, and the before-state is already
  // on file (production 2026-09-09: 59 PASS / 4 KNOWN-CURRENT). A guest without a declared
  // seat count simply does not implement the frozen v1.
  check("guest declares its seat count (D5)", seatCount !== null,
    "a provision with no seatCount did not come back 400 SEAT_COUNT_REQUIRED with an integer " +
    "error.expectedSeatCount. This guest predates pass C: same contract_version, older shape. " +
    "Both sides must land together.");

  const arc = await runArc(opts, secret, expect);
  let grades = {};
  if (arc.fatal) record(FAIL, "getClassGrades returns 2xx", "the arc failed before grades could be read");
  else grades = await runGrades(opts, secret, expect, arc);
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
  // ⚠ The EMULATOR's URL also contains "beergame-mygames-live" (…/beergame-mygames-live/
  // us-central1), and calling that the Firebase project would tell someone to go deleting
  // production docs that were never written. Real means the deployed cloudfunctions host.
  const isRealGuest = /^https:\/\/[^/]*cloudfunctions\.net/.test(opts.baseUrl) &&
    opts.baseUrl.includes("beergame-mygames-live");
  const where = isRealGuest
    ? "the Firebase project beergame-mygames-live"
    : `${opts.baseUrl} (NOT a real Firebase project — nothing was written to beergame-mygames-live)`;
  console.log(`\n── TEST DATA LEFT BEHIND in ${where} ──`);
  if (arc.gameCode) {
    console.log(`  games/${arc.gameCode}                       status=ended`);
    console.log(`    + players/*, teams/*, classroomPlayers/*  (instanceId ${arc.instanceId})`);
  }
  if (grades.orphanCode) {
    console.log(`  games/${grades.orphanCode}                       status=ended  (grades probe: an UNLISTED session under the same instance id)`);
  }
  for (const c of neg.probeCodes ?? []) {
    console.log(`  games/${c}                       status=ended  (negative-suite probe)`);
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
