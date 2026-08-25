// mygames-matcher / functions / online.ts
//
// The online + seat machinery, wired ENTIRELY from the shared @mygames/game-server
// factories (modeled on games/infoshare/functions/src/online.ts). The ONE thing this
// matcher injects differently from a normal game: `openGroup` — what "start a group"
// means — is the HAND-OFF to the guest game, not opening a local round. There is no
// round loop here.

import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { onCall, type CallableRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import {
  makeStageGroupAdapter,
  makeGroupParticipantsOnline,
  makeRecordLogin,
  makeMoveSeat,
  makeTopUpGroupWithBots,
  makeGetOnlineGroups,
  makeFlagGroup,
  makeGetOnlineReport,
  extractInstructorGameId,
  type OnlineContext,
  type OnlineDefinition,
  type GroupProgress,
} from "@mygames/game-server";
import { matcherGameDef } from "./gameDefinition";
import { ACTIVE_TENANT } from "./tenants";
import {
  provisionGroupToTenant,
  finalizeGuestSession,
  getGuestResults,
  PROVISION_SECRET,
  type GuestResultPlayer,
} from "./handoff";

const db = () => admin.firestore();

// The gradebook callback secret (shared with the classroom; also used to read the roster).
// The matcher is the grader now, so scoreAndRecord Bearer-auths its grade push with this.
const CALLBACK_SECRET = defineSecret(ACTIVE_TENANT.rosterSecretName);
/**
 * The callback secret value, with the emulator override — same pattern as handoff.guestSecret.
 * In the functions emulator a defineSecret is not provisioned, so `.value()` is empty; the parent
 * process env IS propagated, so read the plain env var there. Production uses the real secret.
 */
function callbackSecretValue(): string {
  return process.env.FUNCTIONS_EMULATOR === "true"
    ? (process.env[ACTIVE_TENANT.rosterSecretName] ?? "emulator-secret")
    : (CALLBACK_SECRET.value() ?? "");
}

const onlineDef: OnlineDefinition = {
  seatCount: ACTIVE_TENANT.groupSize,

  // A matcher-side bot seat. Only ever used if an instructor explicitly fills a seat on
  // the edit-membership screen; matcher-bots are NOT handed off (the guest game fills its
  // own empty seats), so they exist mainly to satisfy the shared seat contract.
  makeBotSeat: ({ gameInstanceId, groupId, index }) => {
    const participantId = `bot_${groupId}_${index}`;
    return {
      participantId,
      doc: {
        participant_id: participantId,
        game_instance_id: gameInstanceId,
        display_name: `Placeholder ${index}`,
        role: "player",
        is_bot: true,
        status: "active",
      },
    };
  },

  flagMailSubject: "I cannot reach my group",
};

const ctx: OnlineContext = {
  def: matcherGameDef,
  online: onlineDef,
  adapter: makeStageGroupAdapter(),
};

/** Progress for the assignment-status report: handed-off = in_progress, else absent. */
async function progressOf(iid: string): Promise<Map<string, GroupProgress>> {
  const snap = await db().collection("game_instances").doc(iid).collection("groups").get();
  const out = new Map<string, GroupProgress>();
  for (const d of snap.docs) {
    if ((d.data() as Record<string, unknown>)["gameCode"]) {
      out.set(d.id, { category: "in_progress", rounds: 0 });
    }
  }
  return out;
}

export const groupParticipantsOnline = makeGroupParticipantsOnline(ctx, { assignRole: "player" });
export const recordLogin = makeRecordLogin(ctx);
export const getOnlineGroups = makeGetOnlineGroups(ctx);
export const moveSeat = makeMoveSeat(ctx);
export const topUpGroupWithBots = makeTopUpGroupWithBots(ctx);
export const flagGroup = makeFlagGroup(ctx);

/**
 * The ONE "Start the game" control — idempotent, re-pressable — but PRESENCE-AWARE, which
 * is why this is matcher-local rather than the shared makeStartAllGroups (that one hands off
 * every FULL group regardless of who has actually shown up).
 *
 * A group is handed off only when it is (a) full and (b) COMPLETED — every human member is
 * actually present:
 *   • ONLINE (clock_mode 'off'): the roster is pre-grouped before anyone logs in, so a full
 *     group can still be all no-shows. Hand off only once every human member has LOGGED IN
 *     (participant `last_login_at` set by recordLogin). A group with a no-show waits — top it
 *     up with placeholders (its present students + bots) to hand it off, or it stays put.
 *   • CLASSROOM (clock_mode 'on'): matching (triggerMatching) already forms groups only from
 *     students who confirmed attendance AND are present, so a full matched group IS complete;
 *     no extra login gate is applied.
 * Groups that aren't ready are SKIPPED, not locked, so pressing Start again as more students
 * arrive hands off the newly-completed ones.
 */
export const startAllGroups = onCall(
  // ⚠ `secrets: [PROVISION_SECRET]` — NOT `[]`. A per-function secrets array REPLACES the
  // global one (setGlobalOptions in index.ts), so an empty array would strip the provisioning
  // secret this function needs (provisionGroupToTenant → PROVISION_SECRET.value()) and every
  // hand-off would send an empty Bearer and 403.
  { cors: matcherGameDef.corsOrigins, secrets: [PROVISION_SECRET] },
  async (request: CallableRequest) => {
    const data = request.data as Record<string, unknown>;
    const iid = await extractInstructorGameId(
      data,
      process.env.FUNCTIONS_EMULATOR === "true",
      request.rawRequest.headers.authorization as string | undefined,
    );
    const instRef = db().collection("game_instances").doc(iid);

    const [cfgSnap, groupsSnap, partsSnap] = await Promise.all([
      instRef.collection("config").doc("main").get(),
      instRef.collection("groups").get(),
      instRef.collection("participants").get(),
    ]);

    const online = String((cfgSnap.data() as Record<string, unknown>)?.["clock_mode"] ?? "on") === "off";
    // The set of participants who have actually logged in (recordLogin stamps last_login_at).
    const loggedIn = new Set(
      partsSnap.docs.filter((d) => (d.data() as Record<string, unknown>)["last_login_at"] != null).map((d) => d.id),
    );

    let started = 0, skippedShort = 0, skippedWaiting = 0, alreadyRunning = 0;
    // Deterministic order (matches the dashboard's group numbering: group ids sorted).
    const docs = groupsSnap.docs.slice().sort((a, b) => a.id.localeCompare(b.id));
    for (const d of docs) {
      const g = d.data() as Record<string, unknown>;
      if (g["gameCode"]) { alreadyRunning++; continue; } // already handed off
      const seats = Array.isArray(g["player_participants"]) ? (g["player_participants"] as string[]) : [];
      const bots = new Set(Array.isArray(g["bot_participants"]) ? (g["bot_participants"] as string[]) : []);
      const humans = seats.filter((pid) => !bots.has(pid));
      if (seats.length !== ACTIVE_TENANT.groupSize) { skippedShort++; continue; } // not full → top up first
      if (online && !humans.every((pid) => loggedIn.has(pid))) { skippedWaiting++; continue; } // a member is a no-show
      await provisionGroupToTenant(iid, d.id);
      started++;
    }
    return { ok: true as const, started, skipped_short: skippedShort, skipped_waiting: skippedWaiting, already_running: alreadyRunning };
  },
);

export const getOnlineReport = makeGetOnlineReport(ctx, {
  progressOf,
  absenceLabel: "Not yet arrived",
});

/**
 * "Finalize & record" — the dashboard's always-available, re-runnable Finalize button.
 *
 * The matcher never grades; the guest game does, pushing participation grades when its session
 * ENDS. So finalizing here = ending every handed-off guest session (finalizeGuestSession),
 * which triggers each one's grade push. ⚠ IT DOES NOT WAIT FOR EVERYONE TO FINISH — that is
 * the whole point: a team whose member left never ends on its own, so without this the
 * students who DID take part are never graded. Ending a still-running session grades everyone
 * present (the guest scores absentees/bots out). Idempotent: an already-ended session returns
 * ok and is not re-pushed, so the button is safe to click repeatedly as more groups finish.
 */
/** One grade row pushed to the classroom's receiveGameResult callback. */
interface GradeRow {
  game_instance_id: string;
  participant_id: string;
  status: "completed" | "no_show";
  role: string | null;
  raw_score: number | null; // Outcome column = the student's INDIVIDUAL cost
  normalized_score: number | null; // z-score of the student's TEAM cost (higher = lower cost = better)
  knowledge_check_score: number | null;
  details: Record<string, unknown>;
}

async function pushGrade(row: GradeRow, url: string, secret: string): Promise<void> {
  const retryDelays = [300, 800];
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, retryDelays[attempt - 1]));
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify(row),
    });
    if (res.status >= 200 && res.status < 300) return;
    if (res.status < 500) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
  }
  throw new Error("HTTP 5xx after retries");
}

/**
 * scoreAndRecord — the instructor's "Finalize & record" button. The matcher is the GRADER for
 * its guest game (the guest can only see one team; the z-score needs every team). Steps:
 *   1. End every handed-off guest session (freeze costs) — idempotent, safe on already-ended.
 *   2. Read every team's + player's costs (getGuestResults / Beer Game getClassResults).
 *   3. Pool the TEAM costs across all groups → mean/std → each team's z-score
 *      (z = (mean − teamCost)/std, so a LOWER cost is a HIGHER, better z; std 0 → all z 0).
 *   4. Per human player: write raw_score = their INDIVIDUAL cost + finalized_at on the matcher
 *      participant doc (drives the dashboard Outcome column), and push a gradebook row
 *      (raw_score = individual cost, normalized_score = team z) to the classroom.
 * Re-runnable: every call recomputes from current guest state and re-pushes (upsert).
 */
export const scoreAndRecord = onCall(
  { cors: matcherGameDef.corsOrigins, secrets: [PROVISION_SECRET, CALLBACK_SECRET] },
  async (request: CallableRequest) => {
    const data = request.data as Record<string, unknown>;
    const iid = await extractInstructorGameId(
      data,
      process.env.FUNCTIONS_EMULATOR === "true",
      request.rawRequest.headers.authorization as string | undefined,
    );
    const instRef = db().collection("game_instances").doc(iid);
    const groupsSnap = await instRef.collection("groups").get();
    const codes = groupsSnap.docs
      .map((d) => (d.data() as Record<string, unknown>)["gameCode"])
      .filter((c): c is string => typeof c === "string" && c.length > 0);

    // 1. End every guest session so its costs are final. Non-fatal per code — a session we
    //    cannot end still has readable (interim) costs, and grading is re-runnable.
    let finalized = 0;
    const finalizeFailed: Array<{ code: string; reason: string }> = [];
    for (const code of codes) {
      try { await finalizeGuestSession(code); finalized += 1; }
      catch (e) { finalizeFailed.push({ code, reason: e instanceof Error ? e.message : String(e) }); }
    }

    // 2. Read costs for every session.
    const results: Array<{ code: string; players: GuestResultPlayer[] }> = [];
    const resultsFailed: Array<{ code: string; reason: string }> = [];
    for (const code of codes) {
      try { const r = await getGuestResults(code); results.push({ code, players: r.players }); }
      catch (e) { resultsFailed.push({ code, reason: e instanceof Error ? e.message : String(e) }); }
    }

    // 3. Pool the distinct TEAM costs (one data point per team that has a human) → mean/std.
    const teamCostByKey = new Map<string, number>();
    for (const { code, players } of results) {
      for (const p of players) {
        if (p.teamId != null && typeof p.teamCost === "number") {
          teamCostByKey.set(`${code}:${p.teamId}`, p.teamCost);
        }
      }
    }
    const teamCosts = [...teamCostByKey.values()];
    const mean = teamCosts.length ? teamCosts.reduce((a, b) => a + b, 0) / teamCosts.length : 0;
    const variance = teamCosts.length
      ? teamCosts.reduce((a, b) => a + (b - mean) ** 2, 0) / teamCosts.length
      : 0;
    const std = Math.sqrt(variance);
    // Lower cost is better → positive z. std 0 (all teams equal) → every z is 0.
    const zFor = (cost: number): number => (std > 0 ? Number(((mean - cost) / std).toFixed(4)) : 0);

    // 4. Grade each human player: Outcome = individual cost, gradebook z = team z.
    // ⚠ EMULATOR ONLY: the e2e harness points the grade push at its mock classroom. Gated on
    // FUNCTIONS_EMULATOR (like PROVISION_URL_OVERRIDE) so a deployed matcher can never be
    // redirected away from the real classroom — and because functions/.env pins
    // CLASSROOM_CALLBACK_URL to the production URL, which the emulator loads too.
    const url =
      process.env.FUNCTIONS_EMULATOR === "true" && process.env.CALLBACK_URL_OVERRIDE
        ? process.env.CALLBACK_URL_OVERRIDE
        : (process.env.CLASSROOM_CALLBACK_URL ?? "");
    const secret = callbackSecretValue();
    const canPush = Boolean(url && secret);

    const partCol = instRef.collection("participants");
    let graded = 0;
    let pushed = 0;
    const pushFailed: Array<{ participant_id: string; reason: string }> = [];

    for (const { players } of results) {
      for (const p of players) {
        const participated = p.participated;
        const individualCost = typeof p.individualCost === "number" ? p.individualCost : null;
        const teamZ = typeof p.teamCost === "number" ? zFor(p.teamCost) : null;

        // Dashboard Outcome column + finalized tick (matcher participant doc).
        await partCol.doc(p.studentId).set(
          {
            raw_score: participated ? individualCost : null,
            finalized_at: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
        graded += 1;

        if (!canPush) continue;
        const row: GradeRow = {
          game_instance_id: iid,
          participant_id: p.studentId,
          status: participated ? "completed" : "no_show",
          role: p.role,
          raw_score: participated ? individualCost : null,
          normalized_score: participated ? teamZ : null,
          knowledge_check_score: null,
          details: {
            team_name: p.teamName,
            team_cost: p.teamCost,
            individual_cost: individualCost,
            team_z: teamZ,
          },
        };
        try { await pushGrade(row, url, secret); pushed += 1; }
        catch (e) { pushFailed.push({ participant_id: p.studentId, reason: e instanceof Error ? e.message : String(e) }); }
      }
    }

    // Shape stays compatible with the shared finalize contract ({ ok, scored, push }).
    return {
      ok: true as const,
      scored: graded,
      push: { total: graded, succeeded: pushed, failed: pushFailed },
      finalize: { total: codes.length, succeeded: finalized, failed: finalizeFailed },
      results: { failed: resultsFailed },
      cohort: { teams: teamCosts.length, meanTeamCost: Number(mean.toFixed(2)), stdTeamCost: Number(std.toFixed(2)) },
    };
  },
);
