// mygames-matcher / functions / seedInstanceConfig.ts
//
// WRITE clock_mode AT INSTANCE CREATION, so no consumer ever has to default it.
//
// ── THE DEFECT THIS CLOSES ────────────────────────────────────────────────────
// `clock_mode` lives on game_instances/<id>/config/main. Nothing wrote it unless an
// instructor actually moved the mode toggle — `makeUpdateGameConfig` writes only the fields
// present in the request, so an instance whose settings were never touched simply has no
// such field. Two consumers then defaulted the absence DIFFERENTLY:
//
//   instructor  makeGetGameConfig → readConfigField(field, undefined) → field.default
//               → "off" for an online-capable tenant → dashboard shows "Online — pre-grouped"
//   student     makeRecordLogin   → String(cfg?.['clock_mode'] ?? 'on')
//               → 'on' → CLASSROOM routing → "Enter attendance code"
//
// So the dashboard showed Online while students were sent to a code screen for a code that
// cannot exist in a session with no class. Worse, it was invisible: the instructor had no
// reason to touch the toggle, because the dashboard already displayed the mode they wanted.
//
// ── WHY SEED RATHER THAN ALIGN THE DEFAULTS ───────────────────────────────────
// Aligning makeRecordLogin's fallback with readConfigField's would hold exactly until a
// third consumer arrives with a fourth opinion, and it costs a @mygames/game-server release
// across every game that consumes the factory. Writing the field makes both defaults
// UNREACHABLE rather than merely consistent — the value is present, so nobody defaults.
//
// ⚠ The asymmetry inside makeRecordLogin is still real and is NOT fixed here. This makes it
// non-urgent, not unnecessary. It remains a separate shared-package item.
//
// ── WHY A TRIGGER, AND NOT A CREATION SITE ────────────────────────────────────
// Because the matcher has no creation site to edit. The instance document is created by
// `instanceRef.set({ game_instance_id }, { merge: true })` in @mygames/game-server's
// makeSyncRoster, and config/main is written only by that package's makeUpdateGameConfig.
// The matcher's own functions exclusively READ instances. A Firestore create trigger in the
// matcher's own project is therefore the one place this can be done without touching the
// shared package.
//
// ⚠ The default is read from matcherGameDef.configFields — the SAME declaration
// makeGetGameConfig reads through readConfigField. That is deliberate: seeding from a
// second, hand-written copy of the default would reintroduce exactly the class of bug this
// closes.

import * as admin from "firebase-admin";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import * as logger from "firebase-functions/logger";
import { matcherGameDef } from "./gameDefinition";

const db = () => admin.firestore();

/** The declared default for a config key, from the definition the instructor UI also reads. */
function declaredDefault(key: string): string | null {
  const field = (matcherGameDef.configFields ?? []).find((f) => f.key === key);
  if (!field) return null;
  return typeof field.default === "string" ? field.default : String(field.default);
}

export const seedInstanceConfig = onDocumentCreated(
  { document: "game_instances/{iid}", region: "us-central1" },
  async (event) => {
    const iid = (event.params as { iid: string }).iid;
    const value = declaredDefault("clock_mode");
    if (value == null) {
      logger.error("[seedInstanceConfig] clock_mode is not declared in configFields", { iid });
      return;
    }

    const ref = db().collection("game_instances").doc(iid).collection("config").doc("main");
    try {
      const snap = await ref.get();
      // ⚠ NEVER overwrite a real choice. An instructor may have set the mode before the
      // roster sync that creates the instance document, and their decision outranks a
      // default. Only an ABSENT (or non-string) value is seeded.
      if (typeof snap.data()?.["clock_mode"] === "string") {
        logger.info("[seedInstanceConfig] clock_mode already set; leaving it alone", { iid });
        return;
      }
      await ref.set({ clock_mode: value }, { merge: true });
      logger.info("[seedInstanceConfig] seeded clock_mode", { iid, clock_mode: value });
    } catch (err) {
      // Non-fatal by construction: if this fails the instance behaves exactly as it does
      // today (both consumers default), so the failure degrades to the old bug rather than
      // to something new. It is logged loudly because that state is now unexpected.
      logger.error("[seedInstanceConfig] failed to seed clock_mode", { iid, err: String(err) });
    }
  },
);
