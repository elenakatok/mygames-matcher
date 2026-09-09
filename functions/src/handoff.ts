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
import { mintSeatToken, SEAT_TOKEN_TTL_SECONDS } from "./seatToken";

// Single-tenant deploy: the provisioning secret name is fixed per deployment.
export const PROVISION_SECRET = defineSecret(ACTIVE_TENANT.handoff.secretName);

// ── CONTRACT v1 (spec D7) ─────────────────────────────────────────────────────
//
// D7 — "Every matcher→guest request carries contract_version, and the guest rejects an
// unknown major. Echoed in every response. Starts at 1. Without this, the first divergence
// between Kyle's implementation and ours surfaces as mysterious runtime behaviour rather
// than a named error."
//
// ⚠ D1: no compatibility shim. This matcher cannot talk to an unversioned guest and does
// not try — a guest that does not echo the version is a deploy-order mistake, and the
// point of D7 is that it says so by name instead of failing somewhere downstream.
export const CONTRACT_VERSION = 1;

/**
 * Assert the guest echoed a version we speak. The whole value of D7 is that a mismatch is
 * named HERE, at the boundary, rather than surfacing later as an odd-shaped payload or a
 * class that silently grades wrong.
 */
function assertGuestVersion(fn: string, parsed: unknown): void {
  const v = (parsed as Record<string, unknown> | null)?.["contract_version"];
  if (v === undefined || v === null) {
    throw new Error(
      `${fn}: guest returned no contract_version. This matcher speaks v${CONTRACT_VERSION}; ` +
      `the guest is either pre-D7 or not deployed yet. Both sides must land together.`,
    );
  }
  if (Number(v) !== CONTRACT_VERSION) {
    throw new Error(
      `${fn}: guest speaks contract_version ${String(v)}, this matcher speaks ${CONTRACT_VERSION}.`,
    );
  }
}

const db = () => admin.firestore();

/**
 * Provision one matched group into the guest game (idempotent). Reads the group's human
 * seats (bots excluded — the guest game bot-fills its own empty seats), POSTs them, and
 * writes the returned game code back onto the group doc.
 */
/** The provisioning secret (shared with the guest game), with the emulator override. */
function guestSecret(): string {
  return process.env.FUNCTIONS_EMULATOR === "true"
    ? (process.env[ACTIVE_TENANT.handoff.secretName] ?? "emulator-secret")
    : PROVISION_SECRET.value();
}

/**
 * Finalize (end) one handed-off guest session by its gameCode. Ending the session is what
 * makes the guest push participation grades to the classroom (Beer Game: finalizeClassSession
 * → onGameEndedPushResults). Idempotent — an already-ended session returns ok and does not
 * re-push. Used by scoreAndRecord so an instructor can close out an instance and grade the
 * students who took part even if a group never finished (a member left mid-game).
 */
export async function finalizeGuestSession(gameCode: string): Promise<void> {
  const url =
    process.env.FUNCTIONS_EMULATOR === "true" && process.env.FINALIZE_URL_OVERRIDE
      ? process.env.FINALIZE_URL_OVERRIDE
      : ACTIVE_TENANT.handoff.finalizeUrl;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${guestSecret()}` },
    body: JSON.stringify({ contract_version: CONTRACT_VERSION, gameCode }),
  });
  if (!(res.status >= 200 && res.status < 300)) {
    throw new Error(`finalize failed for ${gameCode}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  assertGuestVersion("finalizeGuestSession", await res.json().catch(() => null));
}

/** One human player's costs, as reported by the guest game's results endpoint. */
export interface GuestResultPlayer {
  studentId: string;
  role: string | null;
  teamId: string | null;
  teamName: string | null;
  teamCost: number | null;
  individualCost: number | null;
  participated: boolean;
}
export interface GuestResults {
  gameCode: string;
  teams: Array<{ teamId: string; teamName: string; teamCost: number }>;
  players: GuestResultPlayer[];
}

/**
 * Read one handed-off guest session's per-team + per-player COSTS (Beer Game: getClassResults).
 * Read-only — does NOT end the session or push grades. scoreAndRecord pools these across every
 * team in the instance to compute the cross-team z-score. Idempotent and safe to call repeatedly.
 */
export async function getGuestResults(gameCode: string): Promise<GuestResults> {
  const url =
    process.env.FUNCTIONS_EMULATOR === "true" && process.env.RESULTS_URL_OVERRIDE
      ? process.env.RESULTS_URL_OVERRIDE
      : ACTIVE_TENANT.handoff.resultsUrl;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${guestSecret()}` },
    body: JSON.stringify({ contract_version: CONTRACT_VERSION, gameCode }),
  });
  if (!(res.status >= 200 && res.status < 300)) {
    throw new Error(`results failed for ${gameCode}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const out = (await res.json()) as Partial<GuestResults>;
  assertGuestVersion("getGuestResults", out);
  return {
    gameCode,
    teams: Array.isArray(out.teams) ? out.teams : [],
    players: Array.isArray(out.players) ? out.players : [],
  };
}

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
    // ⚠ `display_name` is only set once a participant has been through online grouping;
    // syncRoster (and in-class matching) writes the roster `name`, not `display_name`. Reading
    // display_name ALONE fell back to the raw pid, so students showed up in the Beer Game as
    // "dNkRCOmr1BlvOzTuxxuR". Fall back name-first, exactly like the shared displayNameOf.
    const displayName =
      (typeof p["display_name"] === "string" && p["display_name"].trim()) ? (p["display_name"] as string) :
      (typeof p["name"] === "string" && (p["name"] as string).trim()) ? (p["name"] as string) :
      pid;
    members.push({ studentId: pid, displayName });
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
  const config = await buildGuestConfig(iid);

  const res = await fetch(provisionUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${guestSecret()}`,
    },
    body: JSON.stringify({
      contract_version: CONTRACT_VERSION,
      instanceId: iid,
      groups: [{ groupId, members }],
      config,
    }),
  });
  if (!(res.status >= 200 && res.status < 300)) {
    throw new Error(`hand-off failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const out = (await res.json()) as { gameCode?: string };
  assertGuestVersion("provisionGroupToTenant", out);
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

/**
 * Translate the matcher instance's stored settings into the GUEST game's config shape,
 * passed to provisionClassSession. Beer-Game-specific: the four friendly demand knobs
 * (initial / final / step-week / weeks) become the `customerDemand` array + `nWeeks` the
 * Beer Game expects (its sanitizeConfig requires customerDemand.length === nWeeks). Absent
 * settings fall back to the Beer Game's own defaults (4→8 step at week 4, 40 weeks), so an
 * instructor who changes nothing gets exactly the classic game.
 */
async function buildGuestConfig(iid: string): Promise<Record<string, unknown>> {
  const snap = await db()
    .collection("game_instances").doc(iid).collection("config").doc("main").get();
  const c = (snap.data() ?? {}) as Record<string, unknown>;
  const posInt = (key: string, fallback: number): number => {
    const n = Math.round(Number(c[key]));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };

  const nWeeks = posInt("num_weeks", 40);
  const initial = posInt("demand_initial", 4);
  const final = posInt("demand_final", 8);
  const stepWeek = Math.min(posInt("demand_step_week", 4), nWeeks);
  const customerDemand = Array.from({ length: nWeeks }, (_, i) => (i < stepWeek ? initial : final));

  return { nWeeks, customerDemand };
}

/**
 * The student's deep link into the guest game's play, once their group is handed off.
 *
 * ⚠ D2: the link now carries a SIGNED SEAT TOKEN (`t`). `sid` alone is no longer a
 * credential — the guest refuses it. That is why this function, which used to have no
 * caller at all (the matcher frontend built the URL itself), is now the ONLY place a play
 * link is made: the HMAC needs the shared secret, and the browser must never hold it.
 * (Collapsing the frontend's now-unused copy is D12, pass C.)
 */
export function playLinkFor(gameCode: string, participantId: string, seatToken: string): string {
  const base = ACTIVE_TENANT.handoff.playUrl.replace(/\/$/, "");
  return (
    `${base}/?class=${encodeURIComponent(gameCode)}` +
    `&sid=${encodeURIComponent(participantId)}` +
    `&t=${encodeURIComponent(seatToken)}`
  );
}

/**
 * Mint a fresh, short-lived play link for one student in one handed-off session.
 *
 * Called on every render of the student's redirect screen, which is what makes a 120s
 * expiry costless: a student who closes the tab (beergame keeps its session in
 * sessionStorage, which is per-tab) simply gets a new token when the screen re-mounts.
 * Nothing is stored — the token is derived, not persisted, so there is no stale credential
 * sitting in Firestore waiting to be replayed.
 */
export function mintSeatLink(gameCode: string, participantId: string): { url: string; expires_in: number } {
  const token = mintSeatToken(gameCode, participantId, guestSecret());
  return { url: playLinkFor(gameCode, participantId, token), expires_in: SEAT_TOKEN_TTL_SECONDS };
}
