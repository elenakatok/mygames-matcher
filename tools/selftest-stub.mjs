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
// THREE SCENARIOS, because the defects are mutually exclusive — a guest cannot both omit
// contract_version and report v1 in the same run:
//
//   classic    v1-correct EXCEPT the three §5.2 defects:
//                1. any Bearer accepted        → "wrong secret → 401" must go red
//                2. issues `BEER001`           → the game-code regex must go red
//                3. drops the last member      → the seat-coverage check must go red
//   no-version otherwise correct, but never emits contract_version
//                                              → "guest reports contract_version 1" red
//   lying-v1   reports contract_version 1 but still answers a bad game code with an
//              unstructured 500 — the exact pre-D8 behaviour production had on 2026-09-09
//                                              → the v1 bad-code checks must go red
//
// That last one is the whole point of version-keying the expectations: under a hardcoded
// baseline a 500 was "known-current" forever and nobody had to notice. Under v1 the guest
// has DECLARED it implements D8, so the same 500 is a violation and fails on its own.

import http from "node:http";

const ROLES = ["retailer", "wholesaler", "distributor", "factory"];
const CONTRACT_VERSION = 1;

/** The secret the self-test presents. Not a credential — these stubs are local and fake. */
export const SELFTEST_SECRET = "selftest-secret-not-a-credential";

function makeServer(variant) {
  const sessions = new Map();
  let codeCounter = 0;
  const emitsVersion = variant !== "no-version";

  const body = (obj) => (emitsVersion ? { contract_version: CONTRACT_VERSION, ...obj } : obj);
  const errBody = (code, message) => body({ error: { code, message } });

  return http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const send = (status, obj) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(typeof obj === "string" ? obj : JSON.stringify(obj));
      };
      const sendErr = (status, code, message) => send(status, errBody(code, message));
      const url = (req.url || "").split("?")[0];

      if (req.method !== "POST") return sendErr(405, "METHOD_NOT_ALLOWED", "POST only.");

      // DEFECT 1 (classic): any Authorization header is accepted, including a wrong secret.
      // The real guest compares with crypto.timingSafeEqual and 401s.
      if (variant !== "classic") {
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
        const groups = Array.isArray(parsed?.groups) ? parsed.groups : null;
        if (!groups || groups.length === 0) {
          return sendErr(400, "GROUPS_REQUIRED", "groups[] is required and must be non-empty.");
        }
        const g = groups[0];
        const posted = Array.isArray(g.members) ? g.members : [];
        // DEFECT 3 (classic): drop the last posted member, silently.
        // ⚠ Applied ONLY to a group of exactly ROLES.length — the happy-path arc. The
        // negative suite's under/over-full probes stay in-contract so this defect shows up
        // in one assertion instead of spraying unrelated reds and muddying the proof.
        const full = posted.length === ROLES.length;
        const placed = variant === "classic" && full
          ? posted.slice(0, ROLES.length - 1)
          : posted.slice(0, ROLES.length);
        // DEFECT 2 (classic): the mock's own out-of-spec code shape (contains 0 and 1).
        const code = variant === "classic"
          ? `BEER${String(++codeCounter).padStart(3, "0")}`
          : Array.from({ length: 6 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");
        const seats = placed.map((m, i) => ({
          studentId: m.studentId, role: ROLES[i], teamId: "team1",
          playerId: `p${i + 1}`, groupId: g.groupId ?? "group-1",
        }));
        sessions.set(code, { seats, ended: false });
        return send(200, body({ gameCode: code, seats }));
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
          studentId: seat.studentId, role: seat.role, teamId: "team1",
          teamName: "Selftest Team", teamCost: 1234, individualCost: 300, participated: true,
        }));
        return send(200, body({ ok: true, gameCode: code, teams, players }));
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
 * Names match guest-conformance.mjs exactly. If the harness stops producing one, --self-test
 * reports it MISSING rather than quietly passing — a renamed assertion is how an instrument
 * proof rots into a rubber stamp.
 */
export const SELFTEST_SCENARIOS = [
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
    variant: "lying-v1",
    what: "D7+D8: a guest claiming v1 while still emitting an unstructured 500",
    expectedFailures: [
      "game code containing 0/1 ('BEER01') → 400",
      "…and its body is structured JSON with a stable code",
    ],
  },
];
