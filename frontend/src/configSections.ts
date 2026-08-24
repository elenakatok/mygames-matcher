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
    id: 'contact',
    title: 'Instructor contact',
    fields: [
      { key: 'instructor_email', label: 'Instructor email (for the "cannot reach my group" flag)', kind: 'string' as const, placeholder: 'you@university.edu' },
    ],
  },
]
