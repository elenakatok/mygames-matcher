// mygames-matcher / functions / online.ts
//
// The online + seat machinery, wired ENTIRELY from the shared @mygames/game-server
// factories (modeled on games/infoshare/functions/src/online.ts). The ONE thing this
// matcher injects differently from a normal game: `openGroup` — what "start a group"
// means — is the HAND-OFF to the guest game, not opening a local round. There is no
// round loop here.

import * as admin from "firebase-admin";
import { onCall, type CallableRequest } from "firebase-functions/v2/https";
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
import { provisionGroupToTenant, finalizeGuestSession, PROVISION_SECRET } from "./handoff";

const db = () => admin.firestore();

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
export const scoreAndRecord = onCall(
  { cors: matcherGameDef.corsOrigins, secrets: [PROVISION_SECRET] },
  async (request: CallableRequest) => {
    const data = request.data as Record<string, unknown>;
    const iid = await extractInstructorGameId(
      data,
      process.env.FUNCTIONS_EMULATOR === "true",
      request.rawRequest.headers.authorization as string | undefined,
    );
    const groupsSnap = await db().collection("game_instances").doc(iid).collection("groups").get();
    const codes = groupsSnap.docs
      .map((d) => (d.data() as Record<string, unknown>)["gameCode"])
      .filter((c): c is string => typeof c === "string" && c.length > 0);

    let scored = 0;
    const failed: Array<{ participant_id: string; reason: string }> = [];
    for (const code of codes) {
      try { await finalizeGuestSession(code); scored++; }
      catch (e) { failed.push({ participant_id: code, reason: e instanceof Error ? e.message : String(e) }); }
    }
    // Shape mirrors the shared finalize contract ({ ok, scored, push }). The actual grade rows
    // are pushed by the guest game on end; here `scored` = guest sessions finalized.
    return { ok: true as const, scored, push: { total: codes.length, succeeded: scored, failed } };
  },
);
