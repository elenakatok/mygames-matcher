// mygames-matcher / functions / handoff.ts
//
// THE HAND-OFF — the one genuinely new piece. When a matched group "starts", instead of
// opening a local round (what a normal game does), the matcher POSTs the group's HUMAN
// members to the guest game's provisioning endpoint (Beer Game: provisionClassSession),
// which assigns seat roles + bot-fills short groups, and returns a game code. The matcher
// stores that code on the group so each student can deep-link into the guest game's play.

import * as admin from "firebase-admin";
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

  const res = await fetch(t.handoff.provisionUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${PROVISION_SECRET.value()}`,
    },
    body: JSON.stringify({ instanceId: iid, groups: [{ groupId, members }] }),
  });
  if (!(res.status >= 200 && res.status < 300)) {
    throw new Error(`hand-off failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const out = (await res.json()) as { gameCode?: string };
  if (!out.gameCode) throw new Error("hand-off returned no gameCode");

  await groupRef.set(
    { gameCode: out.gameCode, handed_off_at: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true },
  );
}

/** The student's deep link into the guest game's play, once their group is handed off. */
export function playLinkFor(gameCode: string, participantId: string): string {
  const base = ACTIVE_TENANT.handoff.playUrl.replace(/\/$/, "");
  return `${base}/?class=${encodeURIComponent(gameCode)}&sid=${encodeURIComponent(participantId)}`;
}
