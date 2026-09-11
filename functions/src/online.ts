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
  extractStudentOnCallIds,
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
  getGuestGrades,
  mintSeatLink,
  MalformedGuestResultsError,
  MalformedGuestGradesError,
  PROVISION_SECRET,
  type GuestResultPlayer,
  type GuestGradeRow,
} from "./handoff";
import { planHandOff, type GroupHandOffPlan, type HandOffOutcome, type WaitingMember } from "./handoffPlan";
import { HttpsError } from "firebase-functions/v2/https";

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
/**
 * Every group's hand-off status, from the ONE rule startAllGroups acts on (handoffPlan.ts).
 * Reads exactly what startAllGroups always read: config/main (mode), groups, participants.
 */
async function readHandOffPlan(iid: string): Promise<GroupHandOffPlan[]> {
  const instRef = db().collection("game_instances").doc(iid);
  const [cfgSnap, groupsSnap, partsSnap] = await Promise.all([
    instRef.collection("config").doc("main").get(),
    instRef.collection("groups").get(),
    instRef.collection("participants").get(),
  ]);
  return planHandOff({
    groups: groupsSnap.docs.map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> })),
    participants: new Map(partsSnap.docs.map((d) => [d.id, d.data() as Record<string, unknown>])),
    online: String((cfgSnap.data() as Record<string, unknown>)?.["clock_mode"] ?? "on") === "off",
    groupSize: ACTIVE_TENANT.groupSize,
  });
}

/**
 * getOnlineGroups — the shared read, plus each group's HAND-OFF status (`handoff`): ready,
 * short, already handed off, or waiting on NAMED students who have not logged in.
 *
 * ⚠ WHY A WRAPPER. The row used to say "full — ready to hand off" from seat count alone,
 * while Start also requires every human to have logged in. The shared factory carries no
 * login state, and changing it is a game-server release; so the matcher runs the shared
 * handler unchanged (`.run`) and attaches the plan startAllGroups decides with.
 * ⚠ Same export name, same callable trigger, same options (the shared corsOf is
 * `{ cors: def.corsOrigins }`) — a deploy updates it in place: no new function, and so no
 * new run.invoker binding.
 */
const sharedGetOnlineGroups = makeGetOnlineGroups(ctx);
export const getOnlineGroups = onCall(
  { cors: matcherGameDef.corsOrigins },
  async (request: CallableRequest) => {
    const base = await sharedGetOnlineGroups.run(request);
    const iid = await extractInstructorGameId(
      request.data as Record<string, unknown>,
      process.env.FUNCTIONS_EMULATOR === "true",
      request.rawRequest.headers.authorization as string | undefined,
    );
    const byId = new Map((await readHandOffPlan(iid)).map((p) => [p.group_id, p]));
    return {
      ...base,
      groups: base.groups.map((g) => {
        const p = byId.get(g.group_id);
        return { ...g, handoff: p ? { status: p.status, waiting: p.waiting } : null };
      }),
    };
  },
);
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
    // Decided by the SAME plan the instructor's row and the Start dialog read (handoffPlan.ts),
    // so what the screen promised is what happens. The rule itself is unchanged: already
    // handed off → skip; not full → skip; online with a human not logged in → skip.
    const plan = await readHandOffPlan(iid);

    let started = 0, skippedShort = 0, skippedWaiting = 0, alreadyRunning = 0;
    // ⚠ PER GROUP, WITH NAMES. The counters alone told the instructor "0 handed off" and
    // nothing else; `groups` says which group was skipped and whom it is waiting on.
    const groups: Array<{ group_id: string; group_number: number; outcome: HandOffOutcome; waiting: WaitingMember[] }> = [];
    for (const p of plan) {
      let outcome: HandOffOutcome;
      if (p.status === "handed_off") { alreadyRunning++; outcome = "already_running"; }
      else if (p.status === "short") { skippedShort++; outcome = "skipped_short"; }       // not full → top up first
      else if (p.status === "waiting") { skippedWaiting++; outcome = "skipped_waiting"; } // a member is a no-show
      else { await provisionGroupToTenant(iid, p.group_id); started++; outcome = "started"; }
      groups.push({ group_id: p.group_id, group_number: p.group_number, outcome, waiting: p.waiting });
    }
    return {
      ok: true as const, started, skipped_short: skippedShort, skipped_waiting: skippedWaiting,
      already_running: alreadyRunning, groups,
    };
  },
);

export const getOnlineReport = makeGetOnlineReport(ctx, {
  progressOf,
  absenceLabel: "Not yet arrived",
});

/** One grade row pushed to the classroom's receiveGameResult callback. */
interface GradeRow {
  game_instance_id: string;
  participant_id: string;
  status: "completed" | "no_show";
  role: string | null;
  raw_score: number | null; // Outcome column = the student's INDIVIDUAL cost
  normalized_score: number | null; // THE GRADE: the guest's value, pushed as given (G1). The gradebook renders exactly this field.
  knowledge_check_score: number | null;
  details: Record<string, unknown>;
}

/**
 * Push one gradebook row — and REQUIRE the classroom to confirm it stored that row.
 *
 * ⚠ A 2xx IS NOT A STORED GRADE. Until 2026-09-10 this returned on any 2xx without reading
 * the body, and CLASSROOM_CALLBACK_URL pointed at the classroom's Hosting site, whose only
 * rewrite was ** → /index.html: every push got "200 text/html", counted as pushed, and the
 * dashboard said "✓ Recorded" over an empty gradebook. receiveGameResult answers a stored row
 * with { success: true, result_id: "<game_instance_id>_<participant_id>" } — only that exact
 * echo counts. Anything else throws, lands in push.failed, and the button says "retry".
 */
async function pushGrade(row: GradeRow, url: string, secret: string): Promise<void> {
  const expectedId = `${row.game_instance_id}_${row.participant_id}`;
  const retryDelays = [300, 800];
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, retryDelays[attempt - 1]));
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify(row),
    });
    if (res.status >= 200 && res.status < 300) {
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (body?.["success"] === true && body["result_id"] === expectedId) return;
      // Not retried: the same receiver will give the same non-answer.
      throw new Error(
        `HTTP ${res.status} (${res.headers.get("content-type") ?? "no content-type"}) with no confirmation the grade ` +
        `was stored — expected {success:true, result_id:"${expectedId}"}. Is CLASSROOM_CALLBACK_URL receiveGameResult?`,
      );
    }
    if (res.status < 500) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
  }
  throw new Error("HTTP 5xx after retries");
}

/**
 * scoreAndRecord — the instructor's "Finalize & record" button. Re-runnable.
 *
 * ⚠ THE MATCHER RELAYS GRADES; IT DOES NOT COMPUTE THEM. Guest_Owned_Grading_Spec_Addendum_v1.md
 * G1 — "The guest owns grading completely." Until this pass the matcher z-scored the guest's team
 * costs here itself (scoring.ts, deleted) — a rule inherited from the negotiation family and never
 * chosen for any guest. Now:
 *   1. End every session the matcher recorded (idempotent; safe on already-ended).
 *   2. Read each session's results — ONLY for the dashboard's Outcome column (raw_score = the
 *      student's individual cost). The grade does not come from here.
 *   3. Ask the guest ONCE for the whole instance's grades (getClassGrades), listing the sessions
 *      the matcher recorded, and validate SHAPE only (G5): one row per student it sent, a finite
 *      number (or null: no grade), a label. ⚠ Never sensibility — a guest that grades backwards
 *      has backwards grades pushed and nothing here objects. That is G1's accepted price.
 *   4. Write raw_score + finalized_at on each participant doc and push each row with
 *      normalized_score = the guest's value AS GIVEN (the one field the gradebook renders).
 *
 * ⚠ ALL-OR-NOTHING. Every failure in 1–3 refuses the WHOLE run before one grade is written or
 * pushed: a session that did not end, an unreachable or malformed results or grades reply, a
 * results or grade set that does not match who was sent. This replaces D10's per-session
 * tolerance for an unreachable session — with one grade call per instance there is no partial
 * cohort left to tolerate.
 *
 * ⚠ §6 Q6, DECIDED HERE: a session that FAILED TO FINALIZE refuses the run. The grades are
 * relative across the class, so one session whose costs are still moving shifts every other
 * student's grade; and the button is re-runnable, so a refusal costs a retry, never a wrong grade.
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
    // The sessions the matcher RECORDED — its accepted hand-offs, in group-id order — and whom it
    // sent into each (humans only; bots never cross). The guest grades exactly these sessions,
    // pooling in this order, which is what keeps its z bit-for-bit the one computed here before.
    const recorded = groupsSnap.docs
      .map((d) => d.data() as Record<string, unknown>)
      .filter((g) => typeof g["gameCode"] === "string" && (g["gameCode"] as string).length > 0)
      .map((g) => {
        const seats = Array.isArray(g["player_participants"]) ? (g["player_participants"] as string[]) : [];
        const bots = new Set(Array.isArray(g["bot_participants"]) ? (g["bot_participants"] as string[]) : []);
        return { code: g["gameCode"] as string, sent: seats.filter((pid) => !bots.has(pid)) };
      });
    const codes = recorded.map((s) => s.code);
    const sentStudentIds = recorded.flatMap((s) => s.sent);
    const refusal = (why: string) => new HttpsError("failed-precondition", `${why} Nothing was graded.`);
    const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

    if (codes.length === 0) {
      return {
        ok: true as const, scored: 0,
        push: { total: 0, succeeded: 0, failed: [] },
        finalize: { total: 0, succeeded: 0, failed: [] },
      };
    }

    // 1. End every recorded session, so its outcomes are final (§6 Q6: any failure refuses).
    const finalizeFailed: Array<{ code: string; reason: string }> = [];
    for (const code of codes) {
      try { await finalizeGuestSession(code); }
      catch (e) { finalizeFailed.push({ code, reason: reasonOf(e) }); }
    }
    if (finalizeFailed.length > 0) {
      throw refusal(
        `${finalizeFailed.length} of ${codes.length} session(s) could not be ended, so their outcomes are ` +
        `not final (${finalizeFailed[0].code}: ${finalizeFailed[0].reason}).`,
      );
    }

    // 2. Results — the Outcome column only. D10: a wrong-SHAPED reply is refused loudly, and now
    //    an unreachable one is too.
    const results: Array<{ code: string; players: GuestResultPlayer[] }> = [];
    for (const code of codes) {
      try { results.push({ code, players: (await getGuestResults(code)).players }); }
      catch (e) {
        throw refusal(e instanceof MalformedGuestResultsError
          ? `The guest game returned malformed results for session ${code}. ${reasonOf(e)}`
          : `The guest game's results for session ${code} could not be read (${reasonOf(e)}).`);
      }
    }
    const resultIds = results.flatMap((r) => r.players.map((p) => p.studentId));
    const sentSet = new Set(sentStudentIds);
    const resultSet = new Set(resultIds);
    if (resultSet.size !== resultIds.length || resultSet.size !== sentSet.size || !resultIds.every((sid) => sentSet.has(sid))) {
      throw refusal(
        `The guest game's results list ${resultIds.length} student row(s); the matcher sent ${sentSet.size} ` +
        `student(s) into these sessions.`,
      );
    }

    // 3. The grades — ONCE, for the whole instance. Shape only (G5).
    let grades: GuestGradeRow[];
    try { grades = await getGuestGrades(iid, codes, sentStudentIds); }
    catch (e) {
      throw refusal(e instanceof MalformedGuestGradesError
        ? `The guest game returned malformed grades. ${reasonOf(e)}`
        : `The guest game's grades could not be read (${reasonOf(e)}).`);
    }
    const gradeById = new Map(grades.map((g) => [g.studentId, g]));

    // 4. Write the Outcome column and push each grade AS GIVEN.
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
        // Verified above: every student sent has exactly one grade row and one results row.
        const grade = gradeById.get(p.studentId) as GuestGradeRow;
        const participated = p.participated;
        const individualCost = typeof p.individualCost === "number" ? p.individualCost : null;

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
          // status is required by receiveGameResult and read by nothing (addendum §3); it keeps
          // its meaning — did the student take their seat.
          status: participated ? "completed" : "no_show",
          role: p.role,
          raw_score: participated ? individualCost : null,
          normalized_score: grade.value, // THE GRADE, exactly as the guest gave it (G1)
          knowledge_check_score: null,
          details: {
            team_name: p.teamName,
            team_cost: p.teamCost,
            individual_cost: individualCost,
            grade_label: grade.label,
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
      finalize: { total: codes.length, succeeded: codes.length, failed: [] },
    };
  },
);

/**
 * getSeatLink — mint this student's short-lived, signed deep link into the guest game.
 *
 * D2 put the seat claim behind an HMAC over the shared secret, which means the LINK can no
 * longer be built in the browser: the matcher frontend used to assemble
 * `?class=…&sid=…` itself, and a browser must never hold the provisioning secret. So the
 * redirect screen calls this instead, on every render.
 *
 * ⚠ The student is identified by their REAL matcher session (extractStudentOnCallIds —
 * classroom JWT or Firebase student token), and a token is minted only for the participant
 * that session resolves to. A student therefore cannot mint a link for someone else's seat,
 * which is exactly what the unsigned `sid` allowed until today.
 *
 * ⚠ Residual limit, stated rather than hidden: this proves "you hold this participant's
 * matcher session", not "you are this human". That is the same trust level as every other
 * student callable in the matcher, and a large improvement on a bare query parameter — but
 * it is not identity proof, and it is not what D2 promises to fix.
 */
export const getSeatLink = onCall(
  { cors: matcherGameDef.corsOrigins, secrets: [PROVISION_SECRET] },
  async (request: CallableRequest) => {
    const data = request.data as Record<string, unknown>;
    const { participantId, gameInstanceId } = await extractStudentOnCallIds(
      data,
      process.env.FUNCTIONS_EMULATOR === "true",
      request.rawRequest.headers.authorization as string | undefined,
    );

    const groupsSnap = await db()
      .collection("game_instances").doc(gameInstanceId).collection("groups").get();
    const mine = groupsSnap.docs.find((doc) => {
      const g = doc.data() as Record<string, unknown>;
      const seats = Array.isArray(g["player_participants"]) ? (g["player_participants"] as string[]) : [];
      return seats.includes(participantId);
    });
    if (!mine) throw new HttpsError("not-found", "You are not in a group yet.");

    const gameCode = (mine.data() as Record<string, unknown>)["gameCode"];
    if (typeof gameCode !== "string" || !gameCode) {
      throw new HttpsError("failed-precondition", "Your group has not been started yet.");
    }
    return mintSeatLink(gameCode, participantId);
  },
);
