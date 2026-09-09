// mygames-matcher / functions / seatToken.ts — MATCHER SIDE: mint a seat token.
//
// Spec D2 — "The seat claim is proven by a signed token, not asserted by the client. The
// matcher mints an HMAC over the seat identity plus an expiry, using a secret shared with
// the guest; the guest verifies it before granting the seat."
//
// ⚠ CANONICALISATION IS DUPLICATED, DELIBERATELY. The verifier lives in the guest's own
// repo (beergame functions/src/seatToken.ts) because the two sides are separate codebases
// and a third-party guest will reimplement it from the contract document rather than import
// ours. If you change the canonical string, change it in BOTH repos and in the conformance
// harness's mint, or every hand-off fails signature verification.
//
//   wire:        "<exp>.<hex hmac-sha256>"
//   signed over: "seat.v1|<gameCode>|<studentId>|<exp>"
//
// `seat.v1` is a TOKEN-FORMAT tag, not the contract version — the contract stays at
// contract_version 1 through this pass.
//
// ── WHY THE EXPIRY IS SHORT (120s) ────────────────────────────────────────────
// Read from the guest's client rather than assumed, which is what §4.1 of the hardening
// spec asks for:
//   • the token is spent on ONE exchange — resumeClassPlayer is called only from the
//     deep-link effect (beergame src/App.tsx), gated on `?class=` being present;
//   • a RELOAD never needs it: the reload-resume effect restores from sessionStorage and
//     returns early when `class` is present, and every later action authenticates with
//     beergame's own sessionToken instead;
//   • the matcher re-mints on every render of the redirect screen, so the one real
//     re-entry case (sessionStorage is per-tab, so closing the tab loses it) simply gets a
//     fresh token.
// So the token's whole life is mint → redirect → verify. 120s absorbs slow networks and
// clock skew while making a leaked URL — history, referrer, a shared screen — useless
// almost immediately.

import * as crypto from "crypto";

/** Default lifetime. See the note above before lengthening this. */
export const SEAT_TOKEN_TTL_SECONDS = 120;

/** Signed material. Order and separator are part of the contract. */
export function canonicalSeatPayload(gameCode: string, studentId: string, exp: number): string {
  return `seat.v1|${gameCode}|${studentId}|${exp}`;
}

/** Mint a seat token binding this student to this session until `exp`. */
export function mintSeatToken(
  gameCode: string,
  studentId: string,
  secret: string,
  ttlSeconds: number = SEAT_TOKEN_TTL_SECONDS,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const exp = nowSeconds + ttlSeconds;
  const mac = crypto
    .createHmac("sha256", secret)
    .update(canonicalSeatPayload(gameCode, studentId, exp))
    .digest("hex");
  return `${exp}.${mac}`;
}
