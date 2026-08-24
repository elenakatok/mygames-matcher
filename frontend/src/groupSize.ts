// ═══════════════════════════════════════════════════════════════════════════════
// HOW MANY STUDENTS ARE IN A GROUP — ONE DEFINITION, INCLUDING THE WORD FOR IT.
//
// The matcher forms UNDIFFERENTIATED groups of this size; the guest game (the Beer Game)
// assigns the four seat roles — Retailer / Wholesaler / Distributor / Factory — at
// hand-off and bot-fills any empty seat. So this is the matching group size, and it must
// match the server's `online.seatCount` / `ACTIVE_TENANT.groupSize` (functions/src/tenants.ts).
//
// The WORD is exported too, not just the number: a constant that only fixes the arithmetic
// leaves the prose a student reads free to drift the moment the group size changes.
// ═══════════════════════════════════════════════════════════════════════════════

/** Seats in one matching group. Must match the server's `online.seatCount` (4 for the Beer Game). */
export const SEATS_PER_GROUP = 4

/** The same number as English, for prose. Change both together or neither. */
export const SEATS_PER_GROUP_WORD = 'four'
