# Matcher secrets — what exists, where, and how to check it

Written 2026-09-09 from source at matcher `35d1899`. Records what
`scripts/set-matcher-secrets.sh` does, because the harness in `tools/` needs the
provision secret and there was nowhere documenting how it is supplied.

> **Elena never types a secret value and never hand-edits a secret file.** Every procedure
> below either copies a value machine-to-machine or verifies one without revealing it.

---

## The script

**`scripts/set-matcher-secrets.sh`** — no arguments. Added 2026-08-24 in commit `69d0dbe`
("scripts: set-matcher-secrets.sh — copy the two runtime secrets via stdin").

```bash
cd /Users/emk120030/projects/games-platform/games/mygames-matcher
./scripts/set-matcher-secrets.sh
```

⚠ **It COPIES existing secrets; it does not generate new ones.** The matcher took over the
"classroom side" of talking to the Beer Game, so its values must MATCH what is already
deployed elsewhere. A fresh `openssl rand` — which `spawn-secret.sh` does — would guarantee
a permanent 403.

| Lands in project | Under the name | Copied from project | Source name |
|---|---|---|---|
| `matcher-mygames-live` | `PROVISION_SECRET_BEERGAME` | `beergame-mygames-live` | `CLASSROOM_PROVISION_SECRET` |
| `matcher-mygames-live` | `CALLBACK_SECRET_BEERGAME` | `mygames-classroom-aec1b` | `CALLBACK_SECRET_BEERGAME` |

**The same secret has two names in two projects.** The matcher SENDS
`PROVISION_SECRET_BEERGAME`; beergame VALIDATES it as `CLASSROOM_PROVISION_SECRET`. Same
bytes, different labels. Anything acting as the matcher — including
`tools/guest-conformance.mjs` — needs the **matcher's** copy.

Per hardening-spec **D13** this divergence is deliberate and documented rather than
unified: *"A third party names his own environment variable; the contract specifies the
header, not the storage."* The harness therefore takes `--secret-env <NAME>`, so a
third-party developer supplies the secret under whatever name he uses, with none of the
gcloud/`.secret.local` machinery above:

```bash
SHARED_SECRET=... node tools/guest-conformance.mjs --secret-env SHARED_SECRET --base-url https://his-endpoints.example.com
```

Prerequisites: Secret Manager API enabled on `matcher-mygames-live`, and gcloud
authenticated with access to all three projects. The script does not enable APIs or grant
IAM. It exits 3 if a source secret is missing rather than copying nothing.

### Invariants it maintains

- The value never touches a terminal, a log, argv, or shell history — read into a shell
  variable and only ever piped via stdin (`printf '%s' | gcloud ... --data-file=-`).
- Written with `printf '%s'`, **no trailing newline**. Secret Manager keeps whitespace
  verbatim while the Firebase CLI strips it on deploy, so a trailing newline is a permanent
  mismatch and a silent 403.
- The local mirror is `functions/.secret.local`, next to `functions/package.json` — never
  the repo root. At the root, the emulator falls through to live GCP Secret Manager.
- Idempotent: an existing secret gets a NEW VERSION; `.secret.local` keys are upserted and
  other keys preserved.

---

## `.secret.local` — yes, the convention is in use here

Same as elsewhere on the platform. `functions/.secret.local` exists in this repo, holds
`PROVISION_SECRET_BEERGAME` and `CALLBACK_SECRET_BEERGAME`, and is gitignored by
`**/.secret.local` (`.gitignore:14`). `functions/.env` is tracked, but holds only
non-secret endpoint URLs.

## How the code resolves the secret

`functions/src/handoff.ts:31`:

```ts
function guestSecret(): string {
  return process.env.FUNCTIONS_EMULATOR === "true"
    ? (process.env[ACTIVE_TENANT.handoff.secretName] ?? "emulator-secret")
    : PROVISION_SECRET.value();
}
```

| Context | Source |
|---|---|
| Production | `defineSecret("PROVISION_SECRET_BEERGAME").value()` — a Secret Manager binding, readable only inside Functions |
| Emulator | plain `process.env.PROVISION_SECRET_BEERGAME`, loaded from `functions/.secret.local` |

⚠ `setGlobalOptions({ secrets: [PROVISION_SECRET] })` at `functions/src/index.ts:43` binds
it to **every** matcher function. A per-function `secrets: [...]` array **replaces** the
global one, so `secrets: []` on any function silently strips the binding and every hand-off
sends an empty Bearer and 403s. `startAllGroups` (`online.ts:124`) and `scoreAndRecord`
(`online.ts:220`) therefore restate it explicitly.

`tools/guest-conformance.mjs` runs on a laptop, not inside Functions, so `defineSecret` is
unavailable to it. It uses the same two developer-facing sources in order: the
`.secret.local` mirror, then Secret Manager via the identical `gcloud secrets versions
access` call the script's `read_src()` makes.

---

## Verifying a binding WITHOUT re-setting a value

> ⚠ **Never run `firebase functions:secrets:set` to fix a missing binding.** It prompts for
> a NEW value and creates a mismatched second version — turning a diagnosable problem into a
> silent 403 that outlives the debugging session. Everything below is read-only.

**What is BOUND** (not merely what exists). Firebase Functions v2 are Cloud Run services;
the service name is the function name lowercased:

```bash
gcloud run services describe startallgroups --region us-central1 --project matcher-mygames-live --format=export | grep -A6 secretKeyRef
```

**What versions exist:**

```bash
gcloud secrets versions list PROVISION_SECRET_BEERGAME --project matcher-mygames-live
```

**Whether the matcher's copy still matches beergame's** — compares fingerprints, never
values. The two must be identical; if they differ, the hand-off will 403:

```bash
gcloud secrets versions access latest --secret=PROVISION_SECRET_BEERGAME --project matcher-mygames-live | shasum -a 256 | cut -c1-8
```
```bash
gcloud secrets versions access latest --secret=CLASSROOM_PROVISION_SECRET --project beergame-mygames-live | shasum -a 256 | cut -c1-8
```

`tools/guest-conformance.mjs` prints the same 8-char fingerprint of whatever secret it
resolved, so a mismatch is visible in its header without anything being disclosed.

If they differ, the fix is to re-run `./scripts/set-matcher-secrets.sh`, which re-copies
from the source of truth — not to set a value by hand.

> **Not executed here.** The commands in this section were written from the script's own
> calls and Firebase's documented v2/Cloud Run mapping; they were not run, because doing so
> needs credentials this session does not have. Treat the `--format` flags as a starting
> point if your gcloud version renders them differently — the `--format=export | grep`
> form is the most version-tolerant.
