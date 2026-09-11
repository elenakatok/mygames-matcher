// selftest-stub.mjs — the DELIBERATELY BROKEN guests that `guest-conformance.mjs --self-test`
// runs against. Keep this file in the same folder as guest-conformance.mjs; it imports only
// Node built-ins.
//
// ⚠ THESE ARE NOT TEST DOUBLES FOR YOUR GAME. Do not point the harness at them to "check the
// contract": a stub that agrees with the harness proves nothing about a real game. They are
// deliberately, visibly wrong so they can never be mistaken for the real thing.
//
// Why they exist (contract document §7, step 1): a conformance harness that has never been
// seen to fail is not known to be reading anything. So the harness ships with guests that
// break the contract on purpose — a wrong secret accepted, a malformed game code, a missing
// member, and the rest listed below — and --self-test passes only if each defect goes red,
// and each correct guest stays entirely green. Run it first, and watch it bite before you
// trust a green run against your own game.
//
// Labels such as D5 or G1 are the project's internal decision numbers; the header of
// guest-conformance.mjs maps each one to the contract document.
//
// ONE SCENARIO PER DEFECT, because the defects are mutually exclusive — a guest cannot both
// omit contract_version and report v1 in the same run. Outside its own defect, every variant
// implements the FROZEN v1, so each defect shows up in its own assertions instead of
// spraying unrelated reds.
//
//   conformant           NO defect, names declared — must draw zero failures
//   conformant-declined  NO defect, names declined — must draw zero failures
//   conformant-single-role  NO defect, NOT the Beer Game's shape: one 'player' role on every
//                        seat (a game whose players are undifferentiated), no team name on
//                        the claim, no costByRole — must draw zero failures
//   conformant-roleless  NO defect, no role on any seat at all, names declined — zero failures
//   classic     v1-correct EXCEPT three classic defects:
//                 1. any Bearer accepted        → "wrong secret → 401" must go red
//                 2. issues `BEER001`           → the game-code regex must go red
//                 3. drops the last member      → the seat-coverage check must go red
//   no-version  never emits contract_version    → "guest reports contract_version 1" red
//   accepts-unsigned  grants a seat with no token at all
//   accepts-expired   verifies the signature but ignores `exp`
//   lying-v1    reports v1 but answers a bad game code with an unstructured 500 — the exact
//               pre-D8 behaviour production had on 2026-09-09
//   ── seat count and group shape (D5) ──
//   undeclared-seat-count  no seat-count field at all — an earlier draft's shape, still
//                          claiming v1
//   ignores-seat-count     declares a seat count, then accepts any other
//   truncates-overfull     slices an over-full group to its seats, silently (2026-09-09)
//   skips-missing-id       skips a member with no studentId, silently (2026-09-09)
//   silent-botfill         bot-fills an under-full group without saying so (a real finding
//                          on the Beer Game, 2026-09-09, since fixed)
//   ── display names (D4) ──
//   drops-declared-name    names declared, but the claim does not return the name it was
//                          sent (a real regression in an earlier draft, since fixed)
//   names-despite-decline  names declined, yet the claim hands back a name anyway
//   ── consistency, not the Beer Game's shape (2026-09-10) ──
//   inconsistent-shape     the claim's role and teamId contradict provisioning, and
//                          costByRole is present but not an object
//   fails-matcher-validation  results the matcher's grading refuses: no players[].teamName
//                          and a string teamCost — which the harness used to pass
//   ── grading (G1/G2 — contract §6) ──
//   malformed-grade-row    getClassGrades returns a non-finite value and no label
//   grades-include-unlisted  getClassGrades grades every session carrying the instance id,
//                          a refused hand-off's orphan included (contract §6.2)
//
// That lying-v1 case is the whole point of version-keying the expectations: under a
// hardcoded baseline a 500 was "known-current" forever and nobody had to notice. Under v1
// the guest has DECLARED it implements D8, so the same 500 is a violation.

import http from "node:http";
import * as crypto from "node:crypto";

const ROLES = ["retailer", "wholesaler", "distributor", "factory"];
const CONTRACT_VERSION = 1;

/** The secret the self-test presents. Not a credential — these stubs are local and fake. */
export const SELFTEST_SECRET = "selftest-secret-not-a-credential";

function makeServer(variant) {
  const sessions = new Map();
  let codeCounter = 0;
  const emitsVersion = variant !== "no-version";
  // The pre-pass-C shape: no seatCount in, none echoed, no per-group report out.
  const declaresSeats = variant !== "undeclared-seat-count";
  // Shapes a CORRECT guest may take that are not the Beer Game's. The harness asserts
  // consistency where a guest declares a shape; it must not require the Beer Game's.
  const singleRole = variant === "conformant-single-role";
  const roleless = variant === "conformant-roleless";
  const beerShaped = !singleRole && !roleless; // four roles, teamName on the claim, costByRole

  const body = (obj) => (emitsVersion ? { contract_version: CONTRACT_VERSION, ...obj } : obj);
  const errBody = (code, message, extra = {}) => body({ error: { code, message, ...extra } });

  return http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const send = (status, obj) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(typeof obj === "string" ? obj : JSON.stringify(obj));
      };
      const sendErr = (status, code, message, extra) => send(status, errBody(code, message, extra));
      const url = (req.url || "").split("?")[0];

      if (req.method !== "POST") return sendErr(405, "METHOD_NOT_ALLOWED", "POST only.");

      // DEFECT 1 (classic): any Authorization header is accepted, including a wrong secret.
      // The real guest compares with crypto.timingSafeEqual and 401s.
      // ⚠ resumeClassPlayer has NO Authorization header — D3 made the signed seat token the
      // whole credential, so the student never carries the shared secret. Gating it on a
      // bearer would 401 the very endpoint these scenarios exist to probe.
      const isSeatClaim = url.endsWith("/resumeClassPlayer");
      if (variant !== "classic" && !isSeatClaim) {
        // ⚠ Accept the self-test's own secret and reject ONLY the harness's deliberate
        // wrong one. Rejecting everything would 401 the whole suite, and each scenario's
        // expected failure would then fire for the wrong reason — a vacuous proof, which
        // is the exact trap this file exists to avoid.
        if (req.headers.authorization !== `Bearer ${SELFTEST_SECRET}`) {
          return sendErr(401, "UNAUTHORIZED", "A valid provisioning secret is required.");
        }
      }

      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { /* */ }

      // D7 gate — enforced by every variant that claims to speak v1.
      if (emitsVersion) {
        const v = parsed?.contract_version;
        if (v === undefined || v === null) {
          return sendErr(400, "CONTRACT_VERSION_REQUIRED", "contract_version is required.");
        }
        if (Number(v) !== CONTRACT_VERSION) {
          return sendErr(400, "UNSUPPORTED_CONTRACT_VERSION", `Unsupported: ${String(v)}.`);
        }
      }

      const validCode = (c) => /^[A-Z2-9]{4,8}$/.test(String(c ?? "").trim().toUpperCase());

      if (url.endsWith("/provisionClassSession")) {
        // D5 — the seat count, checked BEFORE groups[] exactly as the real guest does, so the
        // harness's discovery probe (empty groups[], no seatCount) learns it without a write.
        if (declaresSeats) {
          const sc = parsed?.seatCount;
          if (sc === undefined || sc === null) {
            return sendErr(400, "SEAT_COUNT_REQUIRED", "seatCount is required.",
              { expectedSeatCount: ROLES.length });
          }
          // DEFECT (ignores-seat-count): declares its count, never compares the one it got.
          if (variant !== "ignores-seat-count" && sc !== ROLES.length) {
            return sendErr(400, "SEAT_COUNT_MISMATCH", `seatCount ${String(sc)} is not ${ROLES.length}.`,
              { expectedSeatCount: ROLES.length });
          }
        }

        const groups = Array.isArray(parsed?.groups) ? parsed.groups : null;
        if (!groups || groups.length === 0) {
          return sendErr(400, "GROUPS_REQUIRED", "groups[] is required and must be non-empty.");
        }

        // Validate the whole request before creating anything — in-contract unless the
        // variant's own defect says otherwise.
        const seen = new Set();
        const plans = [];
        for (let gi = 0; gi < groups.length; gi += 1) {
          const g = groups[gi] ?? {};
          const groupId = typeof g.groupId === "string" && g.groupId ? g.groupId : `group-${gi + 1}`;
          let posted = Array.isArray(g.members) ? g.members : [];
          if (posted.length === 0) return sendErr(400, "GROUP_EMPTY", `groups[${gi}] has no members.`);
          if (posted.length > ROLES.length) {
            // DEFECT (truncates-overfull): the 2026-09-09 behaviour — slice to the seat count,
            // say nothing, and leave the dropped student holding a link that dead-ends.
            if (variant !== "truncates-overfull") {
              return sendErr(400, "GROUP_OVERFULL", `groups[${gi}] has ${posted.length} members.`,
                { expectedSeatCount: ROLES.length });
            }
            posted = posted.slice(0, ROLES.length);
          }
          const people = [];
          for (let mi = 0; mi < posted.length; mi += 1) {
            const sid = typeof posted[mi]?.studentId === "string" ? posted[mi].studentId.trim() : "";
            if (!sid) {
              // DEFECT (skips-missing-id): skip the nameless member silently, as the
              // pre-pass-C guest did.
              if (variant === "skips-missing-id") continue;
              return sendErr(400, "MEMBER_STUDENT_ID_REQUIRED", `groups[${gi}].members[${mi}] has no studentId.`);
            }
            if (seen.has(sid)) return sendErr(400, "DUPLICATE_STUDENT_ID", `${sid} appears twice.`);
            seen.add(sid);
            people.push({ sid, displayName: posted[mi]?.displayName });
          }
          plans.push({ groupId, people });
        }

        // DEFECT 2 (classic): the mock's own out-of-spec code shape (contains 0 and 1).
        const code = variant === "classic"
          ? `BEER${String(++codeCounter).padStart(3, "0")}`
          : Array.from({ length: 6 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");

        const seats = [];
        const reports = [];
        plans.forEach((p, gi) => {
          const teamId = `team${gi + 1}`;
          // DEFECT 3 (classic): drop the last member of a FULL group, silently. Only a full
          // group — the happy-path arc — so the defect lands in one assertion instead of
          // spraying the negative suite's under/over-full probes.
          const placed = variant === "classic" && p.people.length === ROLES.length
            ? p.people.slice(0, ROLES.length - 1)
            : p.people;
          placed.forEach((m, i) => seats.push({
            studentId: m.sid,
            // The Beer Game's four distinct roles; or ONE undifferentiated role for every seat
            // (single-role); or no role at all (roleless).
            ...(roleless ? {} : { role: singleRole ? "player" : ROLES[i] }),
            teamId, playerId: `p${gi + 1}-${i + 1}`, groupId: p.groupId,
            // Correct: keep the display name when one was SUPPLIED (a names-declared tenant).
            // DEFECT (drops-declared-name): throws it away — pass C's guest.
            _name: variant !== "drops-declared-name" && typeof m.displayName === "string" && m.displayName.trim()
              ? m.displayName : null,
          }));
          reports.push({
            groupId: p.groupId, humanSeats: placed.length, botSeats: ROLES.length - placed.length,
            // teamId/botRoles are informational — the matcher reads neither — so the non-Beer
            // shapes omit them, to prove a guest may.
            ...(beerShaped ? { teamId, botRoles: ROLES.slice(placed.length) } : {}),
          });
        });
        sessions.set(code, { seats, ended: false,
          instanceId: typeof parsed?.instanceId === "string" ? parsed.instanceId : null });

        return send(200, body({
          gameCode: code,
          ...(declaresSeats ? { seatCount: ROLES.length } : {}),
          seats: seats.map(({ _name, ...s }) => s),
          // DEFECT (silent-botfill): nothing in the reply says a seat went to a bot — the
          // production finding of 2026-09-09.
          ...(declaresSeats && variant !== "silent-botfill" ? { groups: reports } : {}),
        }));
      }

      // getClassGrades — keyed on the instance; grades exactly the listed sessions (G1/G2).
      if (url.endsWith("/getClassGrades")) {
        const instanceId = typeof parsed?.instanceId === "string" ? parsed.instanceId.trim() : "";
        if (!instanceId) return sendErr(400, "INSTANCE_ID_REQUIRED", "instanceId is required.");
        const listed = Array.isArray(parsed?.gameCodes) ? parsed.gameCodes.map((c) => String(c).trim().toUpperCase()) : [];
        if (listed.length === 0) return sendErr(400, "GAME_CODES_REQUIRED", "gameCodes[] is required.");
        for (const c of listed) {
          const s = sessions.get(c);
          if (!s) return sendErr(404, "NOT_FOUND", `No session ${c}.`);
          if (s.instanceId !== instanceId) return sendErr(409, "SESSION_NOT_IN_INSTANCE", `${c} is not in ${instanceId}.`);
        }
        // Correct: grade exactly the listed sessions. DEFECT (grades-include-unlisted): grade every
        // session carrying the instance id — a refused hand-off's orphan included.
        const codes = variant === "grades-include-unlisted"
          ? [...sessions.entries()].filter(([, s]) => s.instanceId === instanceId).map(([c]) => c)
          : listed;
        const rows = codes.flatMap((c) => sessions.get(c).seats.map((seat) => ({
          studentId: seat.studentId, value: 0, label: "Selftest team-cost z-score" })));
        // DEFECT (malformed-grade-row): a non-finite value and no label on the first row.
        const grades = variant === "malformed-grade-row"
          ? rows.map((r, i) => (i === 0 ? { studentId: r.studentId, value: "0" } : r))
          : rows;
        return send(200, body({ ok: true, instanceId, grades }));
      }

      if (url.endsWith("/finalizeClassSession") || url.endsWith("/getClassResults")) {
        const code = String(parsed?.gameCode ?? "").trim().toUpperCase();

        // DEFECT 4 (lying-v1): claims v1, then answers a malformed code exactly the way
        // production did before D8 — HTTP 500, body "Internal Server Error", not JSON.
        if (variant === "lying-v1" && !validCode(code)) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          return res.end("Internal Server Error");
        }
        // classic does not re-validate the code, so DEFECT 2 does not cascade into 500s
        // and mask the assertions this scenario is actually proving.
        if (variant !== "classic" && !validCode(code)) {
          return sendErr(400, "INVALID_GAME_CODE", "Invalid game code.");
        }

        const s = sessions.get(code);
        if (!s) return sendErr(404, "NOT_FOUND", "No session with that game code.");

        if (url.endsWith("/finalizeClassSession")) {
          if (s.ended) return send(200, body({ ok: true, alreadyEnded: true }));
          s.ended = true;
          return send(200, body({ ok: true }));
        }
        // A no-teams guest has nothing to call its team, so "" — a string is all the matcher
        // requires. costByRole is the Beer Game's; the non-Beer shapes omit it.
        // DEFECT (inconsistent-shape): costByRole present, but not an object.
        const teams = [{
          teamId: "team1", teamName: beerShaped ? "Selftest Team" : "", teamCost: 1234,
          ...(beerShaped ? {
            costByRole: variant === "inconsistent-shape" ? "n/a"
              : { retailer: 300, wholesaler: 300, distributor: 300, factory: 334 },
          } : {}),
        }];
        // DEFECT (fails-matcher-validation): a reply the matcher's grading refuses (handoff.ts
        // parseGuestResults) — no player row carries teamName (the matcher requires the key,
        // string or null) and the team's teamCost is a string. Before 2026-09-10 the harness
        // passed this, and the class's whole grading run would have been refused.
        const badForMatcher = variant === "fails-matcher-validation";
        if (badForMatcher) teams[0].teamCost = "1234";
        const players = s.seats.map((seat) => ({
          studentId: seat.studentId, role: seat.role ?? null, teamId: seat.teamId,
          ...(badForMatcher ? {} : { teamName: beerShaped ? "Selftest Team" : null }),
          teamCost: 1234, individualCost: 300, participated: true,
        }));
        return send(200, body({ ok: true, gameCode: code, teams, players }));
      }

      if (url.endsWith("/resumeClassPlayer")) {
        const code = String(parsed?.gameCode ?? "").trim().toUpperCase();
        const studentId = String(parsed?.studentId ?? "").trim();
        const seatToken = parsed?.seatToken;
        if (!studentId) return sendErr(400, "STUDENT_ID_REQUIRED", "studentId is required.");

        // DEFECT 5 (accepts-unsigned): grants a seat with NO token at all — the exact
        // production behaviour of 2026-09-09, where a stranger took a live seat with
        // nothing but gameCode+sid.
        // DEFECT 6 (accepts-expired): checks the signature but ignores `exp`, so a token
        // scraped from browser history keeps working indefinitely.
        if (variant !== "accepts-unsigned") {
          if (typeof seatToken !== "string" || !seatToken) {
            return sendErr(400, "SEAT_TOKEN_REQUIRED", "A signed seat token is required.");
          }
          const dot = seatToken.indexOf(".");
          const exp = Number(seatToken.slice(0, dot));
          const mac = seatToken.slice(dot + 1);
          const want = crypto.createHmac("sha256", SELFTEST_SECRET)
            .update(`seat.v1|${code}|${studentId}|${exp}`).digest("hex");
          if (mac !== want) return sendErr(401, "SEAT_TOKEN_INVALID", "Signature does not match.");
          if (variant !== "accepts-expired" && exp <= Math.floor(Date.now() / 1000)) {
            return sendErr(401, "SEAT_TOKEN_EXPIRED", "Seat token has expired.");
          }
        }

        const s2 = sessions.get(code);
        const seat = s2?.seats.find((x) => x.studentId === studentId);
        if (!seat) return sendErr(404, "SEAT_NOT_FOUND", "No seat for this student.");
        // The claim echoes what provisioning declared: role only when the seat had one, teamId
        // always; teamName only in the Beer Game's shape (provisioning never declares one).
        // DEFECT (inconsistent-shape): the claim's role and teamId contradict provisioning's.
        const drift = variant === "inconsistent-shape";
        return send(200, body({
          playerId: seat.playerId,
          ...(seat.role != null ? { role: drift ? `${seat.role}-other` : seat.role } : {}),
          teamId: drift ? `${seat.teamId}-other` : seat.teamId,
          ...(beerShaped ? { teamName: "Selftest Team" } : {}),
          // Correct: `name` only when a display name was supplied at provision.
          // DEFECT (names-despite-decline): hands back its studentId fallback as a name even
          // though none was supplied — a tenant that declined names is still handed one.
          ...(seat._name ? { name: seat._name }
            : variant === "names-despite-decline" ? { name: studentId } : {}),
          sessionToken: crypto.randomBytes(12).toString("hex"),
        }));
      }

      return sendErr(404, "NOT_FOUND", "Unknown endpoint.");
    });
  });
}

/** Start one scenario's stub on an OS-assigned free port. */
export function startSelfTestStub(variant = "classic") {
  return new Promise((resolve) => {
    const server = makeServer(variant);
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

/**
 * The scenarios --self-test runs, and the assertions that MUST come back FAIL in each.
 * ⚠ THIS LIST IS THE EXPECTED-FAILURES CONTRACT. Names match guest-conformance.mjs EXACTLY.
 * If the harness stops producing one, --self-test reports it MISSING and exits non-zero
 * rather than quietly passing — a renamed assertion is how an instrument proof rots into a
 * rubber stamp. That is why no name below contains a number the harness computes (a seat
 * count, a stamp): a name that varies per run could never be matched.
 */
export const SELFTEST_SCENARIOS = [
  {
    // NO DEFECT. The frozen v1, implemented correctly. The harness must report ZERO failures
    // here — this is the half of the proof the defect scenarios cannot give: that a green
    // run means something because the harness does not cry wolf at a correct guest.
    variant: "conformant",
    what: "no defect, names DECLARED — the harness must stay entirely green",
    displayNames: "declared",
    expectedFailures: [],
    expectClean: true,
  },
  {
    variant: "conformant-declined",
    what: "no defect, names DECLINED — the harness must stay entirely green",
    displayNames: "declined",
    expectedFailures: [],
    expectClean: true,
  },
  {
    // NO DEFECT, and NOT the Beer Game's shape: the stage family's ONE undifferentiated
    // 'player' role on every seat (infoshare's shape, and the shape of in-class games), no
    // team name on the claim, no costByRole, no teamId/botRoles in the group report. Until
    // 2026-09-10 the harness went red on this correct guest ("seat roles are distinct", plus
    // the Beer Game's claim and teams fields). It must now draw ZERO failures.
    variant: "conformant-single-role",
    what: "no defect, ONE role on every seat, no teams — the harness must stay entirely green",
    displayNames: "declared",
    expectedFailures: [],
    expectClean: true,
  },
  {
    // NO DEFECT: provisioning declares no role at all, so the harness asserts nothing about
    // the claim's role — the "if it returned none, assert nothing" half of the rule.
    variant: "conformant-roleless",
    what: "no defect, NO role on any seat, no teams, names DECLINED — must stay entirely green",
    displayNames: "declined",
    expectedFailures: [],
    expectClean: true,
  },
  {
    variant: "classic",
    what: "§5.2's three probes: wrong secret, malformed game code, missing member",
    expectedFailures: [
      "wrong secret → 401",
      "gameCode matches the real /^[A-Z2-9]{4,8}$/",
      "every posted member received a seat",
    ],
  },
  {
    variant: "no-version",
    what: "D7: a guest that never reports contract_version",
    expectedFailures: [
      "guest reports contract_version 1",
    ],
  },
  {
    variant: "accepts-unsigned",
    what: "D2: a guest that grants a seat with NO signed token (the 2026-09-09 defect)",
    expectedFailures: [
      // A guest that grants unsigned claims correctly DETECTS as "not enforced", so the
      // refusal assertions never run. What must go red is the enforcement guard itself —
      // exactly as --expect-version catches a guest that stopped reporting a version.
      "guest enforces signed seat claims",
    ],
  },
  {
    variant: "accepts-expired",
    what: "D2: a guest that verifies the signature but ignores the expiry",
    expectedFailures: [
      "EXPIRED token is REFUSED",
    ],
  },
  {
    variant: "lying-v1",
    what: "D7+D8: a guest claiming v1 while still emitting an unstructured 500",
    expectedFailures: [
      "game code containing 0/1 ('BEER01') → 400",
      "…and its body is structured JSON with a stable code",
    ],
  },
  // ── seat count and group shape (D5) ─────────────────────────────────────────────
  {
    variant: "undeclared-seat-count",
    what: "D5: a guest with no seat-count field at all — v1 in number, pre-pass-C in shape",
    expectedFailures: [
      // Same shape as accepts-unsigned: an undeclared count skips the D5 probes, so what
      // must go red is the guard that names the missing declaration.
      "guest declares its seat count (D5)",
    ],
  },
  {
    variant: "ignores-seat-count",
    what: "D5: a guest that declares its seat count but accepts any other",
    expectedFailures: [
      "seatCount mismatch → 400 SEAT_COUNT_MISMATCH",
      "seatCount mismatch — nothing was provisioned",
    ],
  },
  {
    variant: "truncates-overfull",
    what: "D5: a guest that silently truncates an over-full group (2026-09-09)",
    expectedFailures: [
      "over-full group → 400 GROUP_OVERFULL",
      "over-full group — nothing was provisioned",
    ],
  },
  {
    variant: "skips-missing-id",
    what: "D5: a guest that silently skips a member with no studentId (2026-09-09)",
    expectedFailures: [
      "member with no studentId → 400 MEMBER_STUDENT_ID_REQUIRED",
    ],
  },
  {
    variant: "silent-botfill",
    what: "D5: a guest that bot-fills without saying so (found on production 2026-09-09)",
    expectedFailures: [
      "provision reports each group's human and bot seats",
      "under-full group reports its bot-filled seats (botSeats = seatCount − members)",
    ],
  },
  // ── display names, per tenant ────────────────────────────────────────────────────
  {
    variant: "drops-declared-name",
    what: "names DECLARED, but the claim does not return the name it was sent (pass C's guest)",
    displayNames: "declared",
    expectedFailures: [
      "seat claim returns the display name the matcher sent (names declared)",
    ],
  },
  {
    variant: "names-despite-decline",
    what: "names DECLINED, yet the claim hands back a name anyway",
    displayNames: "declined",
    expectedFailures: [
      "seat claim carries no name (names declined)",
    ],
  },
  // ── consistency, not the Beer Game's shape (2026-09-10) ──────────────────────────
  {
    variant: "inconsistent-shape",
    what: "the claim contradicts provisioning (role, teamId); costByRole is not an object",
    expectedFailures: [
      "role matches the seat provisioning assigned",
      "teamId matches the seat provisioning assigned",
      "teams[].costByRole, when present, is an object",
    ],
  },
  {
    variant: "fails-matcher-validation",
    what: "results the matcher's grading refuses (no players[].teamName, a string teamCost)",
    expectedFailures: [
      "results pass the matcher's grading validation (D10)",
    ],
  },
  // ── grading (G1/G2 — contract §6) ────────────────────────────────────────────────
  {
    variant: "malformed-grade-row",
    what: "getClassGrades returns a grade row with a non-finite value and no label",
    expectedFailures: [
      "grade rows pass the matcher's grade validation (G5)",
    ],
  },
  {
    variant: "grades-include-unlisted",
    what: "getClassGrades grades every session carrying the instance id — a refused hand-off's orphan too",
    expectedFailures: [
      "sessions not listed are excluded (a refused hand-off's orphan)",
      "grade rows pass the matcher's grade validation (G5)",
    ],
  },
];
