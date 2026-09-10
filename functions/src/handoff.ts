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
  const out = await res.json().catch(() => null);
  if (out === null) {
    throw new MalformedGuestResultsError(`getClassResults for ${gameCode} is malformed: the reply is not JSON`);
  }
  assertGuestVersion("getGuestResults", out);
  return parseGuestResults(gameCode, out);
}

/**
 * A getClassResults reply that does not have the contract's shape.
 *
 * D10 — "Malformed results fail loudly. Today a wrong-shaped 200 degrades to teams: [] /
 * players: [], which grades an entire class as absent and looks like a class that did not
 * play." Its own class so scoreAndRecord can tell a SHAPE regression (it hits every session
 * the guest serves, so grade nothing) from one session it could not reach (the rest can
 * still be read, as before).
 */
export class MalformedGuestResultsError extends Error {}

/** Validate the whole reply and never coerce. Every field scoreAndRecord reads is checked. */
function parseGuestResults(gameCode: string, out: unknown): GuestResults {
  const fail = (why: string): MalformedGuestResultsError =>
    new MalformedGuestResultsError(`getClassResults for ${gameCode} is malformed: ${why}`);
  if (!out || typeof out !== "object") throw fail("the reply is not a JSON object");
  const o = out as Record<string, unknown>;
  if (o["ok"] !== true) throw fail(`ok is ${JSON.stringify(o["ok"])}, not true`);
  if (o["gameCode"] !== gameCode) throw fail(`it answers for ${JSON.stringify(o["gameCode"])}`);
  if (!Array.isArray(o["teams"])) throw fail("teams is not an array");
  if (!Array.isArray(o["players"])) throw fail("players is not an array");
  // A provisioned session always holds at least one human (D5 refuses an empty group), so an
  // empty players[] is exactly the "class that did not play" D10 exists to stop.
  if ((o["players"] as unknown[]).length === 0) throw fail("players is empty for a provisioned session");
  const isNum = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v);
  const numOrNull = (v: unknown): boolean => v === null || isNum(v);
  const strOrNull = (v: unknown): boolean => v === null || typeof v === "string";
  (o["teams"] as unknown[]).forEach((t, i) => {
    const r = (t ?? {}) as Record<string, unknown>;
    if (typeof r["teamId"] !== "string" || !r["teamId"]) throw fail(`teams[${i}].teamId is missing`);
    if (typeof r["teamName"] !== "string") throw fail(`teams[${i}].teamName is not a string`);
    if (!isNum(r["teamCost"])) throw fail(`teams[${i}].teamCost is not a number`);
  });
  (o["players"] as unknown[]).forEach((p, i) => {
    const r = (p ?? {}) as Record<string, unknown>;
    if (typeof r["studentId"] !== "string" || !r["studentId"]) throw fail(`players[${i}].studentId is missing`);
    if (typeof r["participated"] !== "boolean") throw fail(`players[${i}].participated is not a boolean`);
    if (!strOrNull(r["role"]) || !strOrNull(r["teamId"]) || !strOrNull(r["teamName"])) {
      throw fail(`players[${i}] role/teamId/teamName must be string or null`);
    }
    if (!numOrNull(r["teamCost"]) || !numOrNull(r["individualCost"])) {
      throw fail(`players[${i}] teamCost/individualCost must be number or null`);
    }
  });
  return {
    gameCode,
    teams: o["teams"] as GuestResults["teams"],
    players: o["players"] as GuestResultPlayer[],
  };
}

export async function provisionGroupToTenant(iid: string, groupId: string): Promise<void> {
  const t = ACTIVE_TENANT;
  const groupRef = db().collection("game_instances").doc(iid).collection("groups").doc(groupId);
  const snap = await groupRef.get();
  if (!snap.exists) return;
  const g = snap.data() as Record<string, unknown>;
  if (g["gameCode"]) return; // already handed off

  const seatIds = Array.isArray(g["player_participants"]) ? (g["player_participants"] as string[]) : [];
  const bots = new Set(Array.isArray(g["bot_participants"]) ? (g["bot_participants"] as string[]) : []);

  // Matcher-bots are NOT posted: the guest bot-fills the seats they held, and says so (D5).
  // ⚠ D4 — "displayName is removed from the provision body. It is the only PII on the wire.
  // It flows one way and once, nothing reads it back across the boundary, and the guest
  // already falls back to studentId when it is absent." A member is { studentId } and
  // nothing else, so no student name enters a project outside Elena's control; the real
  // names stay on the matcher dashboard, on our side of the boundary. (This also drops a
  // Firestore read per member that existed only to look the names up.)
  const memberIds = seatIds.filter((pid) => !bots.has(pid));
  if (memberIds.length === 0) return;
  const members = memberIds.map((studentId) => ({ studentId }));

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
      // D5 — "The expected seat count is sent explicitly, and a mismatch is an error." The
      // guest refuses a seat count it does not have, rather than truncating or bot-filling
      // around a number the two sides never agreed.
      seatCount: t.groupSize,
      instanceId: iid,
      groups: [{ groupId, members }],
      config,
    }),
  });
  if (!(res.status >= 200 && res.status < 300)) {
    throw new Error(`hand-off failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const out = ((await res.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  assertGuestVersion("provisionGroupToTenant", out);

  // D6 — verify the reply BEFORE recording anything. A group that reaches the student
  // redirect with a seat missing hands a student a link that dead-ends.
  const problem = verifyProvisionReply(out, groupId, memberIds, t.groupSize);
  if (problem) {
    // Best-effort: end the session the guest just created so it does not sit in_progress for
    // 30 days holding seats nobody will be sent to. Never masks the real error.
    if (typeof out["gameCode"] === "string") await finalizeGuestSession(out["gameCode"]).catch(() => {});
    throw new Error(`hand-off verification failed (D6): ${problem}`);
  }
  const gameCode = out["gameCode"] as string;

  // ⚠ `seats_locked_at` is what the STAGE ADAPTER reads for "this group has started"
  // (groupDocAdapter.hasStarted → seats_locked_at != null). Setting it at hand-off is the
  // matcher's equivalent of a stage game opening round 1: once a group is in the guest game
  // its membership must freeze — re-group (instance-wide lock) and move/ungroup (per-group
  // lock) both gate on this flag, so without it an instructor could re-form a group whose
  // students are already playing the Beer Game, orphaning them. `gameCode` drives the
  // student redirect and the "running" set; `seats_locked_at` drives the seat lock.
  // `report_url` (D12): the instructor's report link, built HERE from the one play origin
  // (tenants.ts playUrl) and stored beside the code, so the frontend no longer keeps a second
  // copy of the guest's origin (VITE_PLAY_URL) that could drift from the one students use.
  await groupRef.set(
    {
      gameCode,
      report_url: reportLinkFor(gameCode),
      handed_off_at: FieldValue.serverTimestamp(),
      seats_locked_at: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

const GAME_CODE_RE = /^[A-Z2-9]{4,8}$/;

/**
 * D6 — "The matcher verifies the seats array the guest returns. The guest already returns
 * it; the matcher currently discards it."
 *
 * Returns null when the reply accounts for every seat, or one sentence naming what is
 * wrong. Checks: a contract-shaped gameCode; the seatCount echoed back; every posted member
 * seated EXACTLY once, in this group, and nobody else seated; and the guest's own report of
 * how many seats went to humans and to bots (D5) agreeing with what the matcher sent.
 */
export function verifyProvisionReply(
  out: Record<string, unknown>,
  groupId: string,
  memberIds: string[],
  seatCount: number,
): string | null {
  const code = out["gameCode"];
  if (typeof code !== "string" || !GAME_CODE_RE.test(code)) {
    return `gameCode ${JSON.stringify(code)} is not a contract game code (/^[A-Z2-9]{4,8}$/)`;
  }
  if (out["seatCount"] !== seatCount) {
    return `the guest echoed seatCount ${JSON.stringify(out["seatCount"])}; the matcher sent ${seatCount}`;
  }
  if (!Array.isArray(out["seats"])) return "the reply carries no seats[]";
  const posted = new Set(memberIds);
  const seated = new Set<string>();
  for (const s of out["seats"] as Array<Record<string, unknown> | null>) {
    const sid = s?.["studentId"];
    if (typeof sid !== "string" || !posted.has(sid)) {
      return `the guest seated a student the matcher never posted (${JSON.stringify(sid)})`;
    }
    if (seated.has(sid)) return `the guest seated ${sid} twice`;
    if (s?.["groupId"] !== groupId) {
      return `the seat for ${sid} is in group ${JSON.stringify(s?.["groupId"])}, not ${groupId}`;
    }
    seated.add(sid);
  }
  const unseated = memberIds.filter((id) => !seated.has(id));
  if (unseated.length) return `${unseated.length} posted member(s) got no seat: ${unseated.join(", ")}`;
  const report = Array.isArray(out["groups"])
    ? (out["groups"] as Array<Record<string, unknown> | null>).find((r) => r?.["groupId"] === groupId)
    : undefined;
  if (!report) return "the reply carries no groups[] report for this group";
  const wantBots = seatCount - memberIds.length;
  if (report["humanSeats"] !== memberIds.length || report["botSeats"] !== wantBots) {
    return `the guest reports ${JSON.stringify(report["humanSeats"])} human + ` +
      `${JSON.stringify(report["botSeats"])} bot seat(s); the matcher sent ${memberIds.length} ` +
      `human(s) for ${seatCount} seats (${wantBots} bot)`;
  }
  return null;
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
 *
 * D12 — "One source of truth for the play URL." Done in pass C: the frontend's copy (and its
 * VITE_PLAY_URL base) is deleted, and the instructor report link below is built from the
 * same tenants.ts playUrl. This file is now the only place the guest's origin is read.
 */
function playBase(): string {
  return ACTIVE_TENANT.handoff.playUrl.replace(/\/$/, "");
}

export function playLinkFor(gameCode: string, participantId: string, seatToken: string): string {
  const base = playBase();
  return (
    `${base}/?class=${encodeURIComponent(gameCode)}` +
    `&sid=${encodeURIComponent(participantId)}` +
    `&t=${encodeURIComponent(seatToken)}`
  );
}

/** The instructor's read-only report page for one handed-off session (orders + inventory). */
export function reportLinkFor(gameCode: string): string {
  return `${playBase()}/?report=${encodeURIComponent(gameCode)}`;
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
