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

const app = initializeApp(firebaseConfig)

export const db        = getFirestore(app)
export const rtdb      = getDatabase(app)
export const auth      = getAuth(app)
export const functions = getFunctions(app)

// DEV → the emulator ports in this repo's firebase.json. If you change one, change
// BOTH — a mismatch presents as every callable hanging with no error.
//   functions 5005, firestore 8082, database 9002, auth 9101.
if (import.meta.env.DEV) {
  connectFunctionsEmulator(functions, 'localhost', 5005)
  connectFirestoreEmulator(db,        'localhost', 8082)
  connectDatabaseEmulator(rtdb,       'localhost', 9002)
  connectAuthEmulator(auth, 'http://localhost:9101')
}
