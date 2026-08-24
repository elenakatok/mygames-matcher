// mygames-matcher / functions / tenants.ts
//
// The matcher runs the standard classroom matching front-of-house (login → ready →
// in-class-code OR online → dashboard with Match Now + edit-group-membership) from the
// shared @mygames/game-server factories, and — instead of playing a round — HANDS the
// matched groups to a guest game's provisioning endpoint. A "tenant" is a guest game
// plugged in this way.
//
// MATCHING MODEL = stage family (like Information Sharing): matching forms
// UNDIFFERENTIATED groups of `groupSize`; the guest game assigns the actual seat roles
// at hand-off (the Beer Game's provisionClassSession already does this) and bot-fills
// short groups. So the matcher needs NO per-role machinery — just a group size + bots.

import type { ConfigFieldDef } from "@mygames/game-server";

export interface MatchingTenant {
  /** Registry game_id — what the classroom launches, carried in the launch JWT. */
  gameId: string;
  title: string;

  /** Undifferentiated matching group size. Beer Game = 4 (one supply chain). */
  groupSize: number;

  /** The guest game's seat roles — METADATA only (the guest game assigns them). */
  seatRoles?: string[];

  /** Which modes this tenant allows. */
  modes: { inClass: boolean; online: boolean };

  /** The matcher's own frontend origin(s) — CORS + the classroom launch url. */
  corsOrigins: string[];

  /** The hand-off: how matched groups reach the guest game, and how students enter it. */
  handoff: {
    /** Guest game "receive matched groups" endpoint (Beer Game: provisionClassSession). */
    provisionUrl: string;
    /** Guest game "end session" endpoint (Beer Game: finalizeClassSession). */
    finalizeUrl: string;
    /** Name of the secret (in the matcher's project) holding the shared provisioning secret. */
    secretName: string;
    /** Student play URL; the matcher appends `?class=<gameCode>&sid=<participantId>`. */
    playUrl: string;
  };

  /** Gradebook callback key (`<game_id>_v1`) — the guest game pushes grades directly. */
  callbackSecretId: string;
  /** Secret (in the matcher's project) used to read the classroom roster via getCourseRoster. */
  rosterSecretName: string;

  /**
   * Instructor-editable settings for the GUEST GAME, surfaced through the matcher's Settings
   * page and passed to the guest at hand-off. The matcher itself doesn't interpret them — it
   * stores them on the instance config and the hand-off (see handoff.ts buildGuestConfig)
   * translates them into the guest's own config shape. Each key must also appear in the
   * frontend's configSections.ts.
   */
  guestConfigFields?: ConfigFieldDef[];
}

export const BEERGAME_TENANT: MatchingTenant = {
  gameId: "beergame",
  title: "The Beer Game",
  groupSize: 4,
  seatRoles: ["retailer", "wholesaler", "distributor", "factory"],
  modes: { inClass: true, online: true },
  corsOrigins: [
    "https://matcher.mygames.live",
    "https://matcher-mygames-live.web.app",
  ],
  handoff: {
    provisionUrl:
      "https://us-central1-beergame-mygames-live.cloudfunctions.net/provisionClassSession",
    finalizeUrl:
      "https://us-central1-beergame-mygames-live.cloudfunctions.net/finalizeClassSession",
    secretName: "PROVISION_SECRET_BEERGAME",
    playUrl: "https://beergame-mygames-live.web.app",
  },
  callbackSecretId: "beergame_v1",
  rosterSecretName: "CALLBACK_SECRET_BEERGAME",

  // The Beer Game's instructor-tunable knobs. Customer demand is the classic step: a low
  // level for the first few weeks, then a one-time jump (the shock that drives the bullwhip).
  // handoff.ts turns these four into the guest's `customerDemand` array + `nWeeks`.
  guestConfigFields: [
    { key: "demand_initial", kind: "positiveInt", default: 4 },
    { key: "demand_final", kind: "positiveInt", default: 8 },
    { key: "demand_step_week", kind: "positiveInt", default: 4 },
    { key: "num_weeks", kind: "positiveInt", default: 40 },
  ],
};

/**
 * The tenant this matcher deployment serves. Single-tenant per deploy for now (the
 * shared factories bake one GameDefinition in at deploy). A second guest game gets its
 * own matcher deploy, or a future multi-tenant dispatch layer.
 */
export const ACTIVE_TENANT: MatchingTenant = BEERGAME_TENANT;
