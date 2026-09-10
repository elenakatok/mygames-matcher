// selftest-stub.mjs — the DELIBERATELY BROKEN guests, shipped on purpose.
//
// ⚠ THESE ARE NOT TEST DOUBLES FOR THE GUEST GAME. Do not point the harness at them to
// "check the contract" — that is precisely the mistake matcher-e2e.mjs makes, and these
// stubs are deliberately, visibly wrong so they can never be mistaken for the real thing.
//
// Hardening spec §5.2: "Its instrument proved by a deliberate failure. Point it at a wrong
// secret, a malformed game code, and a missing member, and watch each one go red. A
// conformance harness that has never failed is not known to be reading anything."
// §5.4: "It must ship with the deliberate failing mode from (2) so he can prove his copy
// bites before trusting it."
//
// ONE SCENARIO PER DEFECT, because the defects are mutually exclusive — a guest cannot both
// omit contract_version and report v1 in the same run. Outside its own defect, every variant
// implements the FROZEN v1 (pass C included), so each defect shows up in its own assertions
// instead of spraying unrelated reds.
//
//   conformant           NO defect, names declared — must draw zero failures
//   conformant-declined  NO defect, names declined — must draw zero failures
//   classic     v1-correct EXCEPT the three §5.2 defects:
//                 1. any Bearer accepted        → "wrong secret → 401" must go red
//                 2. issues `BEER001`           → the game-code regex must go red
//                 3. drops the last member      → the seat-coverage check must go red
//   no-version  never emits contract_version    → "guest reports contract_version 1" red
//   accepts-unsigned  grants a seat with no token at all
//   accepts-expired   verifies the signature but ignores `exp`
//   lying-v1    reports v1 but answers a bad game code with an unstructured 500 — the exact
//               pre-D8 behaviour production had on 2026-09-09
//   ── pass C (D4, D5) ──
//   undeclared-seat-count  no seat-count field at all — the PRE-PASS-C shape, still v1
//   ignores-seat-count     declares a seat count, then accepts any other
//   truncates-overfull     slices an over-full group to its seats, silently (2026-09-09)
//   skips-missing-id       skips a member with no studentId, silently (2026-09-09)
//   silent-botfill         bot-fills an under-full group without saying so (found on
//                          production 2026-09-09, missed by the extract)
//   ── display names (per tenant) ──
//   drops-declared-name    names declared, but the claim does not return the name it was
//                          sent — pass C's guest, which D4's reversal undoes
//   names-despite-decline  names declined, yet the claim hands back a name anyway
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
            studentId: m.sid, role: ROLES[i], teamId, playerId: `p${gi + 1}-${i + 1}`, groupId: p.groupId,
            // Correct: keep the display name when one was SUPPLIED (a names-declared tenant).
            // DEFECT (drops-declared-name): throws it away — pass C's guest.
            _name: variant !== "drops-declared-name" && typeof m.displayName === "string" && m.displayName.trim()
              ? m.displayName : null,
          }));
          reports.push({
            groupId: p.groupId, teamId, humanSeats: placed.length,
            botSeats: ROLES.length - placed.length, botRoles: ROLES.slice(placed.length),
          });
        });
        sessions.set(code, { seats, ended: false });

        return send(200, body({
          gameCode: code,
          ...(declaresSeats ? { seatCount: ROLES.length } : {}),
          seats: seats.map(({ _name, ...s }) => s),
          // DEFECT (silent-botfill): nothing in the reply says a seat went to a bot — the
          // production finding of 2026-09-09.
          ...(declaresSeats && variant !== "silent-botfill" ? { groups: reports } : {}),
        }));
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
        const teams = [{
          teamId: "team1", teamName: "Selftest Team", teamCost: 1234,
          costByRole: { retailer: 300, wholesaler: 300, distributor: 300, factory: 334 },
        }];
        const players = s.seats.map((seat) => ({
          studentId: seat.studentId, role: seat.role, teamId: seat.teamId,
          teamName: "Selftest Team", teamCost: 1234, individualCost: 300, participated: true,
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
        return send(200, body({
          playerId: seat.playerId, role: seat.role, teamId: seat.teamId, teamName: "Selftest Team",
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
  // ── pass C ──────────────────────────────────────────────────────────────────────
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
];
