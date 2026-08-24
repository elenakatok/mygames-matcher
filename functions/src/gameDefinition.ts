// mygames-matcher / functions / gameDefinition.ts
//
// Build the GameDefinition the shared factories expect FROM the active tenant config.
// The matcher runs matching only — it never plays a round or grades — so the scoring /
// KC / content fields are minimal stubs that satisfy the shared types; the guest game
// owns real play and grades. Modeled on games/infoshare/functions/src/gameDefinition.ts.

import type { Outcome, OutcomeSchema, RoleConfig } from "@mygames/game-engine";
import type { GameDefinition, PrepTextQuestion } from "@mygames/game-server";
import { ACTIVE_TENANT, MatchingTenant } from "./tenants";

// Option 1 (stage family): ONE undifferentiated matching role. The guest game assigns
// its real seat roles at hand-off. So matching forms groups of `groupSize` players.
const PLAYER_ROLE_CONFIG: RoleConfig = {
  roles: [{ key: "player", label: "Player", short: "P" }],
};

// Matching never scores — the guest game does. A minimal participation stub keeps the
// shared finalize/type contract satisfied without ever being used for a real grade.
const outcomeSchema: OutcomeSchema = [
  { key: "placeholder_result", type: "decimal", min: 0, max: 1_000_000, step: 1 },
];

function computeScoreBreakdown(
  _roleKey: string,
  _outcome: Outcome | null,
  _configData?: Record<string, unknown>,
): { value_or_cost: number; raw_score: number } {
  return { value_or_cost: 1, raw_score: 1 };
}
function computeRawScore(
  roleKey: string,
  outcome: Outcome | null,
  configData?: Record<string, unknown>,
): number {
  return computeScoreBreakdown(roleKey, outcome, configData).raw_score;
}

export function defFrom(t: MatchingTenant): GameDefinition {
  return {
    game_id: t.gameId,
    roles: PLAYER_ROLE_CONFIG,
    scoreSense: { player: "value" },

    // perRoleCap === composition LOCKS the group size (see infoshare's note): omit it
    // and the cap becomes eligible.length, letting one group grow past its seats.
    composition: { player: t.groupSize },
    perRoleCap: t.groupSize,

    outcomeSchema,
    computeRawScore,
    computeScoreBreakdown,
    reservations: { player: 0 },

    corsOrigins: t.corsOrigins,

    classroom: {
      callbackSecretId: t.callbackSecretId,
      callbackSecretName: t.rosterSecretName,
    },

    // clock_mode = the in-class ('on') vs online ('off') toggle (per-instance).
    // instructor_email = the online "can't reach my group" mailto target.
    // ...plus the guest game's own instructor-tunable settings (e.g. Beer Game customer
    // demand), declared by the tenant and passed through at hand-off.
    configFields: [
      { key: "clock_mode", kind: "string", default: t.modes.online ? "off" : "on" },
      { key: "instructor_email", kind: "string", default: "" },
      ...(t.guestConfigFields ?? []),
    ],

    // No knowledge check / prep in the matcher (the Beer Game's KC is deferred, and the
    // matcher only matches). Empty bank → the flow routes straight to ready → match.
    prepDefaults: [] as PrepTextQuestion[],

    content: {
      infoPDFs: {} as Record<string, { private: string; public?: string }>,
      kcQuestions: [],
      prepQuestions: [],
      scenarioText: {},
    },
  };
}

export const matcherGameDef: GameDefinition = defFrom(ACTIVE_TENANT);
