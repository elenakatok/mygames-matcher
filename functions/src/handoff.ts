// mygames-matcher / functions / handoff.ts
//
// THE HAND-OFF — the one genuinely new piece. When a matched group "starts", instead of
// opening a local round (what a normal game does), the matcher POSTs the group's HUMAN
// members to the guest game's provisioning endpoint (Beer Game: provisionClassSession),
// which assigns seat roles + bot-fills short groups, and returns a game code. The matcher
// stores that code on the group so each student can deep-link into the guest game's play.

import * as admin from "firebase-admin";
// ⚠ FieldValue from the MODULAR subpath, NOT `admin.firestore.FieldValue`. Under
// firebase-admin ^12 the latter is `undefined` at runtime, so every hand-off write threw
// `Cannot read properties of undefined (reading 'serverTimestamp')` — the group never got
// its gameCode and no student was ever redirected. This is the same gotcha the Beer Game
// hit; the rest of the matcher (online.ts, the shared seat factories) already imports it
// this way.
import { FieldValue } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";
import { ACTIVE_TENANT } from "./tenants";

// Single-tenant deploy: the provisioning secret name is fixed per deployment.
export const PROVISION_SECRET = defineSecret(ACTIVE_TENANT.handoff.secretName);

const db = () => admin.firestore();

/**
 * Provision one matched group into the guest game (idempotent). Reads the group's human
 * seats (bots excluded — the guest game bot-fills its own empty seats), POSTs them, and
 * writes the returned game code back onto the group doc.
 */
export async function provisionGroupToTenant(iid: string, groupId: string): Promise<void> {
  const t = ACTIVE_TENANT;
  const groupRef = db().collection("game_instances").doc(iid).collection("groups").doc(groupId);
  const snap = await groupRef.get();
  if (!snap.exists) return;
  const g = snap.data() as Record<string, unknown>;
  if (g["gameCode"]) return; // already handed off

  const seats = Array.isArray(g["player_participants"]) ? (g["player_participants"] as string[]) : [];
  const bots = new Set(Array.isArray(g["bot_participants"]) ? (g["bot_participants"] as string[]) : []);

  const partCol = db().collection("game_instances").doc(iid).collection("participants");
  const members: Array<{ studentId: string; displayName: string }> = [];
  for (const pid of seats) {
    if (bots.has(pid)) continue; // matcher-bot → guest game bot-fills instead
    const p = (await partCol.doc(pid).get()).data() ?? {};
    members.push({
      studentId: pid,
      displayName: typeof p["display_name"] === "string" ? (p["display_name"] as string) : pid,
    });
  }
  if (members.length === 0) return;

  // ⚠ EMULATOR ONLY: let the e2e harness point the hand-off at a mock provisioning
  // endpoint. Gated on FUNCTIONS_EMULATOR so a deployed matcher can NEVER be redirected
  // away from the real guest game by a stray env var — production always uses the tenant's
  // baked provisionUrl.
  const provisionUrl =
    process.env.FUNCTIONS_EMULATOR === "true" && process.env.PROVISION_URL_OVERRIDE
      ? process.env.PROVISION_URL_OVERRIDE
      : t.handoff.provisionUrl;
  const secret =
    process.env.FUNCTIONS_EMULATOR === "true"
      ? (process.env[t.handoff.secretName] ?? "emulator-secret")
      : PROVISION_SECRET.value();

  const res = await fetch(provisionUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({ instanceId: iid, groups: [{ groupId, members }] }),
  });
  if (!(res.status >= 200 && res.status < 300)) {
    throw new Error(`hand-off failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const out = (await res.json()) as { gameCode?: string };
  if (!out.gameCode) throw new Error("hand-off returned no gameCode");

  // ⚠ `seats_locked_at` is what the STAGE ADAPTER reads for "this group has started"
  // (groupDocAdapter.hasStarted → seats_locked_at != null). Setting it at hand-off is the
  // matcher's equivalent of a stage game opening round 1: once a group is in the guest game
  // its membership must freeze — re-group (instance-wide lock) and move/ungroup (per-group
  // lock) both gate on this flag, so without it an instructor could re-form a group whose
  // students are already playing the Beer Game, orphaning them. `gameCode` drives the
  // student redirect and the "running" set; `seats_locked_at` drives the seat lock.
  await groupRef.set(
    {
      gameCode: out.gameCode,
      handed_off_at: FieldValue.serverTimestamp(),
      seats_locked_at: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

/** The student's deep link into the guest game's play, once their group is handed off. */
export function playLinkFor(gameCode: string, participantId: string): string {
  const base = ACTIVE_TENANT.handoff.playUrl.replace(/\/$/, "");
  return `${base}/?class=${encodeURIComponent(gameCode)}&sid=${encodeURIComponent(participantId)}`;
}
