import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Force singleton copies of packages that game-ui also installs as devDeps.
    // Without this, Vite resolves firebase/react-router-dom from game-ui's local
    // node_modules (via symlink) and bundles a second copy — breaking React context
    // (blank page). MANDATORY for the file:-linked game-ui.
    dedupe: ['react', 'react-dom', 'react-router-dom', 'firebase'],
  },
  optimizeDeps: {
    // game-engine's dist is CommonJS and is consumed via a file: link (both directly and
    // transitively by the file:-linked game-ui). Vite's dev optimizer skips file:-linked
    // deps by default, so the raw CJS ("exports is not defined") reaches the browser.
    // Force pre-bundling (CJS→ESM) of the subpaths game-ui uses.
    include: [
      '@mygames/game-engine',
      '@mygames/game-engine/outcome',
      '@mygames/game-engine/roles',
      '@mygames/game-engine/matching',
      '@mygames/game-engine/rounds',
    ],
  },
})
