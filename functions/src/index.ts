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
import { setGlobalOptions } from "firebase-functions/v2";
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
import { PROVISION_SECRET } from "./handoff";

admin.initializeApp();

// ⚠ BIND THE PROVISIONING SECRET TO EVERY FUNCTION.
//
// The hand-off (startAllGroups → provisionGroupToTenant) calls PROVISION_SECRET.value() at
// runtime, but it is built from a SHARED factory (makeStartAllGroups) whose onCall options
// carry no secrets — so without this the secret is never bound to startAllGroups and
// .value() comes back empty in production, sending `Authorization: Bearer ` and getting the
// hand-off rejected. A per-function `secrets:[...]` isn't reachable through the shared
// factory, so it is set GLOBALLY here. Functions that declare their own secrets (syncRoster,
// getRoster → the roster callback secret) override this for themselves and are unaffected.
setGlobalOptions({ secrets: [PROVISION_SECRET] });

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
