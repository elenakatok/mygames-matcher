// selftest-stub.mjs — the DELIBERATELY BROKEN guest, shipped on purpose.
//
// ⚠ THIS IS NOT A TEST DOUBLE FOR THE GUEST GAME. Do not point the harness at it to
// "check the contract" — that is precisely the mistake matcher-e2e.mjs makes, and this
// stub is deliberately, visibly wrong so it can never be mistaken for the real thing.
//
// Hardening spec §5.2: "Its instrument proved by a deliberate failure. Point it at a wrong
// secret, a malformed game code, and a missing member, and watch each one go red. A
// conformance harness that has never failed is not known to be reading anything."
// §5.4: "It must ship with the deliberate failing mode from (2) so he can prove his copy
// bites before trusting it."
//
// So this file SHIPS, unlike a scratchpad mock. `guest-conformance.mjs --self-test` boots
// it, runs the full suite against it, and passes only if the three named assertions came
// back FAIL. Kyle runs the same flag against his own checkout before trusting a green run.
//
// The three planted defects, one per §5.2 probe:
//
//   1. WRONG SECRET ACCEPTED — any Bearer is honoured, so the harness's
//      "wrong secret → 401" assertion must fail.
//   2. MALFORMED GAME CODE — issues `BEER001`, the exact shape matcher-e2e's mock
//      issues and the real parseGameCode regex rejects, so
//      "gameCode matches the real /^[A-Z2-9]{4,8}$/" must fail.
//   3. A MISSING MEMBER — silently drops the last posted member, so
//      "every posted member received a seat" must fail.
//
// Everything else answers in-contract, so the failures are isolated rather than a cascade
// of consequential errors that would prove nothing about the assertions we care about.

import http from "node:http";

const ROLES = ["retailer", "wholesaler", "distributor", "factory"];
const sessions = new Map();
let codeCounter = 0;

/** DEFECT 2: the mock's own out-of-spec code shape (contains 0 and 1). */
const malformedCode = () => `BEER${String(++codeCounter).padStart(3, "0")}`;

export function startSelfTestStub() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const send = (status, obj) => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(typeof obj === "string" ? obj : JSON.stringify(obj));
        };
        const url = (req.url || "").split("?")[0];

        if (req.method !== "POST") return send(405, { error: "method-not-allowed" });

        // DEFECT 1: any Authorization header is accepted, including a wrong secret.
        // (The real guest compares with crypto.timingSafeEqual and 401s.)

        let parsed = null;
        try { parsed = JSON.parse(body); } catch { /* */ }

        if (url.endsWith("/provisionClassSession")) {
          const groups = Array.isArray(parsed?.groups) ? parsed.groups : null;
          if (!groups || groups.length === 0) return send(400, { error: "groups[] is required" });
          const g = groups[0];
          const posted = Array.isArray(g.members) ? g.members : [];
          // DEFECT 3: drop the last posted member, silently — a hand-off that placed
          // fewer students than it was given, with nothing in the response saying so.
          //
          // ⚠ Applied ONLY to a group of exactly ROLES.length, i.e. the happy-path arc.
          // The negative suite's under-full and over-full probes are left to behave
          // in-contract, so this defect shows up in exactly one assertion instead of
          // spraying unrelated reds across the report and muddying the proof.
          const full = posted.length === ROLES.length;
          const placed = full
            ? posted.slice(0, ROLES.length - 1)
            : posted.slice(0, ROLES.length);
          const code = malformedCode();
          const seats = placed.map((m, i) => ({
            studentId: m.studentId,
            role: ROLES[i],
            teamId: "team1",
            playerId: `p${i + 1}`,
            groupId: g.groupId ?? "group-1",
          }));
          sessions.set(code, { seats, ended: false });
          return send(200, { gameCode: code, seats });
        }

        // finalize / results deliberately do NOT re-validate the code shape, so the
        // malformed code above does not cascade into 500s and mask the other assertions.
        if (url.endsWith("/finalizeClassSession")) {
          const code = String(parsed?.gameCode ?? "").trim().toUpperCase();
          const s = sessions.get(code);
          if (!s) return send(404, { error: "not-found" });
          if (s.ended) return send(200, { ok: true, alreadyEnded: true });
          s.ended = true;
          return send(200, { ok: true });
        }

        if (url.endsWith("/getClassResults")) {
          const code = String(parsed?.gameCode ?? "").trim().toUpperCase();
          const s = sessions.get(code);
          if (!s) return send(404, { error: "not-found" });
          const teams = [{
            teamId: "team1", teamName: "Selftest Team", teamCost: 1234,
            costByRole: { retailer: 300, wholesaler: 300, distributor: 300, factory: 334 },
          }];
          const players = s.seats.map((seat) => ({
            studentId: seat.studentId,
            role: seat.role,
            teamId: "team1",
            teamName: "Selftest Team",
            teamCost: 1234,
            individualCost: 300,
            participated: true,
          }));
          return send(200, { ok: true, gameCode: code, teams, players });
        }

        return send(404, { error: "not-found" });
      });
    });
    // Port 0 = let the OS pick a free one, so a self-test never collides with anything.
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

/**
 * The assertions that MUST come back FAIL when the harness is pointed at this stub.
 * Named exactly as guest-conformance.mjs records them. If the harness stops producing
 * one of these names, --self-test reports it as MISSING rather than quietly passing —
 * a renamed assertion is how an instrument proof rots into a rubber stamp.
 */
export const EXPECTED_FAILURES = [
  "wrong secret → 401",
  "gameCode matches the real /^[A-Z2-9]{4,8}$/",
  "every posted member received a seat",
];
