// mygames-matcher / functions / online.ts
//
// The online + seat machinery, wired ENTIRELY from the shared @mygames/game-server
// factories (modeled on games/infoshare/functions/src/online.ts). The ONE thing this
// matcher injects differently from a normal game: `openGroup` — what "start a group"
// means — is the HAND-OFF to the guest game, not opening a local round. There is no
// round loop here.

import * as admin from "firebase-admin";
import {
  makeStageGroupAdapter,
  makeGroupParticipantsOnline,
  makeRecordLogin,
  makeStartAllGroups,
  makeMoveSeat,
  makeTopUpGroupWithBots,
  makeGetOnlineGroups,
  makeFlagGroup,
  makeGetOnlineReport,
  type OnlineContext,
  type OnlineDefinition,
  type GroupProgress,
} from "@mygames/game-server";
import { matcherGameDef } from "./gameDefinition";
import { ACTIVE_TENANT } from "./tenants";
import { provisionGroupToTenant } from "./handoff";

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

/** A group is "running" once it has been handed off (carries a guest-game code). */
async function runningGroupIds(iid: string): Promise<Set<string>> {
  const snap = await db().collection("game_instances").doc(iid).collection("groups").get();
  const out = new Set<string>();
  for (const d of snap.docs) if ((d.data() as Record<string, unknown>)["gameCode"]) out.add(d.id);
  return out;
}

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
 * The ONE "start" control (shared, idempotent, re-pressable). For the matcher, starting
 * a group = HANDING IT OFF to the guest game. Online mode auto-opens on arrival via the
 * same hook.
 */
export const startAllGroups = makeStartAllGroups(ctx, {
  openGroup: async (iid, groupId) => {
    await provisionGroupToTenant(iid, groupId);
  },
  runningGroupIds,
});

export const getOnlineReport = makeGetOnlineReport(ctx, {
  progressOf,
  absenceLabel: "Not yet arrived",
});
