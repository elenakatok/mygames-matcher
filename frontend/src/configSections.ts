// ═══════════════════════════════════════════════════════════════════════════════
// THE SETTINGS MANIFEST — kept OUT of App.tsx so it can be read without booting the app.
//
// ⚠ EVERY KEY HERE MUST ALSO EXIST IN `configFields` IN functions/src/gameDefinition.ts,
// and adding one means redeploying BOTH getGameConfig AND updateGameConfig — the
// recognised-field list is baked into the deployed bundle, and the symptom of forgetting
// is "No recognised fields to update" on code that is entirely correct.
//
// The matcher has only two config fields, and `clock_mode` is NOT here on purpose: the
// instructor sets the session mode from the dashboard's mode switch (above the roster,
// where the decision is made), exactly as the stage games do. That leaves one setting.
// ═══════════════════════════════════════════════════════════════════════════════

export const configSections = [
  {
    // ⚠ THE BEER GAME'S SETTINGS, surfaced through the matcher. Every key here must also be
    // in the tenant's guestConfigFields (functions/src/tenants.ts) AND is translated into the
    // Beer Game's own config at hand-off (functions/src/handoff.ts buildGuestConfig). Customer
    // demand is the classic step: a low level for the first few weeks, then a one-time jump —
    // the shock that drives the bullwhip effect.
    id: 'beergame',
    title: 'Beer Game settings',
    fields: [
      { key: 'demand_initial',   label: 'Customer demand — starting level (units/week)', kind: 'positiveInt' as const, placeholder: '4' },
      { key: 'demand_final',     label: 'Customer demand — after the step (units/week)',  kind: 'positiveInt' as const, placeholder: '8' },
      { key: 'demand_step_week', label: 'Week the demand step happens',                   kind: 'positiveInt' as const, placeholder: '4' },
      { key: 'num_weeks',        label: 'Number of weeks',                                kind: 'positiveInt' as const, placeholder: '40' },
    ],
  },
  {
    id: 'contact',
    title: 'Instructor contact',
    fields: [
      { key: 'instructor_email', label: 'Instructor email (for the "cannot reach my group" flag)', kind: 'string' as const, placeholder: 'you@university.edu' },
    ],
  },
]
