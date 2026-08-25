import { initializeApp } from 'firebase/app'
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore'
import { getDatabase, connectDatabaseEmulator } from 'firebase/database'
import { getAuth, connectAuthEmulator } from 'firebase/auth'
import { getFunctions, connectFunctionsEmulator } from 'firebase/functions'

const firebaseConfig = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId:             import.meta.env.VITE_FIREBASE_APP_ID,
  databaseURL:       import.meta.env.VITE_FIREBASE_DATABASE_URL,
}

// ═══════════════════════════════════════════════════════════════════════════════
// TWO Firebase apps on ONE origin, and this is load-bearing.
//
// The matcher serves the STUDENT page (/) and the INSTRUCTOR dashboard (/dashboard) on the
// same origin (matcher-mygames-live.web.app). Firebase keeps ONE signed-in user per app
// instance per origin — so with a single app, opening the dashboard while a student tab is
// open (exactly what the launcher does) makes each page's session guard see the OTHER's
// user, `signOut()` it, and strand it on its expired 15-min launch JWT → "Missing token" on
// the dashboard, and the student bounced back to the attendance-code screen then an error.
//
// Giving the instructor pages their OWN named app puts the two sessions in separate storage
// namespaces, so they can never sign each other out. (Student-vs-student in one browser is
// still separated by the launcher's per-tab `?_session=tab`.) This is the documented real
// fix for the same-origin session collision.
//
// ⚠ KEEP THE SPLIT CLEAN: instructor surfaces (dashboard, settings, the control strip) use
// the *Instructor exports; student surfaces (Play and its screens) use the default ones.
// api.ts routes each callable to the matching functions instance.
// ═══════════════════════════════════════════════════════════════════════════════

const app           = initializeApp(firebaseConfig)
const instructorApp = initializeApp(firebaseConfig, 'instructor')

// ── student app (default) ──────────────────────────────────────────────────────
export const db        = getFirestore(app)
export const rtdb      = getDatabase(app)
export const auth      = getAuth(app)
export const functions = getFunctions(app)

// ── instructor app ───────────────────────────────────────────────────────────
export const dbInstructor        = getFirestore(instructorApp)
export const rtdbInstructor      = getDatabase(instructorApp)
export const authInstructor      = getAuth(instructorApp)
export const functionsInstructor = getFunctions(instructorApp)

// DEV → the emulator ports in this repo's firebase.json. If you change one, change it
// everywhere — a mismatch presents as every callable hanging with no error.
//   functions 5005, firestore 8082, database 9002, auth 9101.
if (import.meta.env.DEV) {
  for (const f of [functions, functionsInstructor]) connectFunctionsEmulator(f, 'localhost', 5005)
  for (const d of [db, dbInstructor])               connectFirestoreEmulator(d, 'localhost', 8082)
  for (const r of [rtdb, rtdbInstructor])           connectDatabaseEmulator(r, 'localhost', 9002)
  for (const a of [auth, authInstructor])           connectAuthEmulator(a, 'http://localhost:9101')
}
