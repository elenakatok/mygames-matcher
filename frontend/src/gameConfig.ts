import type { RoleConfig, OutcomeSchema } from '@mygames/game-engine'

// ═══════════════════════════════════════════════════════════════════════════════
// The frontend's mirror of the matcher's MATCHING role config.
//
// ⚠ ONE undifferentiated matching role, `player`. The Beer Game's SEAT roles
// (Retailer / Wholesaler / Distributor / Factory) are assigned by the GUEST GAME at
// hand-off — the matcher never learns them — so they never appear here: the shared roster
// and matching UI would otherwise offer to assign roles this app does not own.
//
// This mirrors functions/src/gameDefinition.ts. It is a mirror because the frontend cannot
// import from functions/ — keep the two in step.
// ═══════════════════════════════════════════════════════════════════════════════

export const matcherRoleConfig: RoleConfig = {
  roles: [{ key: 'player', label: 'Player', short: 'P' }],
}

/** The single matching role key. Every student holds it, start to finish. */
export const MATCHING_ROLE = 'player'

/**
 * Placeholder outcome schema — the matcher never scores (the Beer Game grades). Mirrors
 * the stub schema in functions/src/gameDefinition.ts so the shared finalize/type contract
 * is satisfied.
 */
export const matcherOutcomeSchema: OutcomeSchema = [
  { key: 'placeholder_result', type: 'decimal', min: 0, max: 1_000_000, step: 1 },
]

export type { OutcomeSchema }
