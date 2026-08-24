# mygames-matcher

The **matching stub** — a game-shaped app that runs the classroom's standard matching
front-of-house (student login → role → ready → in-class attendance code *or* online
matching → instructor dashboard with Match Now + edit-group-membership) reused from the
shared `@mygames/game-server` machinery, and **hands the matched groups off to a guest
game** instead of playing a round.

First tenant: **The Beer Game** (Enno Siemsen's open-source supply-chain game). The
matcher forms undifferentiated groups of 4, then POSTs each group's members to the Beer
Game's `provisionClassSession`, which assigns the four supply-chain roles and bot-fills
short groups; students deep-link into the Beer Game's play. Grades flow from the guest
game back to the classroom directly.

Deploys to its own Firebase project `matcher-mygames-live`, launched by the classroom
like any game. See `Matching_Stub_Build_Plan_v1.md` in the workspace root.

## Layout
- `functions/` — the front-of-house (shared factories) + the hand-off (`handoff.ts`, `online.ts` `openGroup`).
- `frontend/` — the student match flow + instructor dashboard (to come; copied from the Information Sharing online components, with "matched" → redirect into the guest game's play).
