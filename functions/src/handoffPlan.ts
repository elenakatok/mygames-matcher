// mygames-matcher / functions / handoffPlan.ts
//
// WHICH GROUPS "START" WILL HAND OFF — AND, FOR EVERY OTHER GROUP, WHY NOT.
//
// One pure function, read by three places that must never disagree: the instructor's group
// row (via getOnlineGroups), the Start confirm dialog (from the same read), and startAllGroups
// itself, which DECIDES with it. Before this existed the row and the dialog judged readiness
// by SEAT COUNT alone, while startAllGroups also required every human to have logged in
// (online mode). A full group with one no-show therefore read "full — ready to hand off", the
// dialog promised to start it, the call skipped it and returned success, and the screen said
// "0 handed off" with no reason anywhere. Seen in production 2026-09-10.
//
// ⚠ THE RULE IS UNCHANGED. This is the exact decision startAllGroups made inline before —
// same order, same fields — lifted out so it can also be REPORTED. A group missing a human
// is still not handed off by default.

export type HandOffStatus =
  | "handed_off" // already carries a gameCode
  | "short"      // fewer seats than the tenant's group size — top it up first
  | "waiting"    // ONLINE: full, but a human member has not logged in yet
  | "ready";     // Start hands this one off

/** What startAllGroups did with one group. Named after the counters it already returned. */
export type HandOffOutcome = "started" | "already_running" | "skipped_short" | "skipped_waiting";

export interface WaitingMember {
  participant_id: string;
  display_name: string;
}

export interface GroupHandOffPlan {
  group_id: string;
  /** Dashboard numbering: 1-based over group ids sorted with localeCompare (as getOnlineGroups). */
  group_number: number;
  status: HandOffStatus;
  /** The humans who have not logged in. Non-empty exactly when status is "waiting". */
  waiting: WaitingMember[];
}

/**
 * The shared game-server displayNameOf (online/context.ts), duplicated because it is not
 * exported: chosen display name, then roster name, then the id. Same rule, so a waiting
 * student is named exactly as the instructor's row names them.
 */
export function displayNameOf(data: Record<string, unknown>, participantId: string): string {
  const chosen = data["display_name"];
  if (typeof chosen === "string" && chosen.trim()) return chosen;
  const roster = data["name"];
  if (typeof roster === "string" && roster.trim()) return roster;
  return participantId;
}

export function planHandOff(input: {
  groups: Array<{ id: string; data: Record<string, unknown> }>;
  participants: Map<string, Record<string, unknown>>;
  /** clock_mode 'off'. Classroom matching already forms groups only from present students. */
  online: boolean;
  groupSize: number;
}): GroupHandOffPlan[] {
  // Deterministic order, matching the dashboard's group numbering: group ids sorted.
  const sorted = [...input.groups].sort((a, b) => a.id.localeCompare(b.id));
  return sorted.map((g, i) => {
    const base = { group_id: g.id, group_number: i + 1 };
    const d = g.data;
    if (d["gameCode"]) return { ...base, status: "handed_off", waiting: [] };
    const seats = Array.isArray(d["player_participants"]) ? (d["player_participants"] as string[]) : [];
    const bots = new Set(Array.isArray(d["bot_participants"]) ? (d["bot_participants"] as string[]) : []);
    if (seats.length !== input.groupSize) return { ...base, status: "short", waiting: [] };
    if (input.online) {
      // "Logged in" = the participant doc carries last_login_at (recordLogin stamps it). The
      // group doc's member_logins map is a cosmetic copy and is NOT consulted.
      const waiting = seats
        .filter((pid) => !bots.has(pid))
        .filter((pid) => input.participants.get(pid)?.["last_login_at"] == null)
        .map((pid) => ({ participant_id: pid, display_name: displayNameOf(input.participants.get(pid) ?? {}, pid) }));
      if (waiting.length > 0) return { ...base, status: "waiting", waiting };
    }
    return { ...base, status: "ready", waiting: [] };
  });
}
