// mygames-matcher / functions / index.ts
//
// The deployed functions — the standard classroom matching FRONT-OF-HOUSE, wired from
// the shared @mygames/game-server factories, plus the online/seat machinery in ./online
// (whose `startAllGroups` hands groups off to the guest game). There is NO play, scoring,
// KC, or reports here — the guest game owns all of that.
//
// ⚠ Deploy BY NAME (never blanket --only functions) and add a run.invoker binding for
// allUsers to each new callable after its first deploy (gen-2 service names are lowercase).

import { onRequest } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import {
  makeGetInstructorSession,
  makeAssignRole,
  makeCompletePrep,
  makeConfirmReady,
  makeGenerateAttendanceCode,
  makeVerifyAttendanceCode,
  makeGetRoster,
  makeSyncRoster,
  makeTriggerMatching,
  makeGetGameConfig,
  makeUpdateGameConfig,
  makeGetInfoUrls,
} from "@mygames/game-server";
import { matcherGameDef } from "./gameDefinition";
import { ACTIVE_TENANT } from "./tenants";

admin.initializeApp();

// ── session, roster, matching, config ──────────────────────────────────────────
export const getInstructorSession = makeGetInstructorSession(matcherGameDef);
export const assignRole = makeAssignRole(matcherGameDef);
export const completePrep = makeCompletePrep(matcherGameDef);
export const confirmReady = makeConfirmReady(matcherGameDef);
export const generateAttendanceCode = makeGenerateAttendanceCode(matcherGameDef);
export const verifyAttendanceCode = makeVerifyAttendanceCode(matcherGameDef);
export const getRoster = makeGetRoster(matcherGameDef);
export const syncRoster = makeSyncRoster(matcherGameDef);
export const triggerMatching = makeTriggerMatching(matcherGameDef);
export const getGameConfig = makeGetGameConfig(matcherGameDef);
export const updateGameConfig = makeUpdateGameConfig(matcherGameDef);
export const getInfoUrls = makeGetInfoUrls(matcherGameDef);

// ── online mode + seat management (start = hand-off; see ./online + ./handoff) ──
export {
  groupParticipantsOnline,
  recordLogin,
  getOnlineGroups,
  moveSeat,
  topUpGroupWithBots,
  flagGroup,
  startAllGroups,
  getOnlineReport,
} from "./online";

// ── health ─────────────────────────────────────────────────────────────────────
const CORS_ORIGINS = new Set(ACTIVE_TENANT.corsOrigins);
export const health = onRequest((req, res) => {
  const origin = req.headers.origin ?? "";
  if (CORS_ORIGINS.has(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Vary", "Origin");
  }
  if (req.method === "OPTIONS") { res.status(204).send(""); return; }
  res.json({ ok: true, matcher: matcherGameDef.game_id, tenant: ACTIVE_TENANT.title });
});
