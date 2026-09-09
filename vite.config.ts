import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Tauri expects a fixed port and does not tolerate a fallback.
const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  // Tauri targets a known webview: skip legacy transpilation to keep the bundle small.
  build: {
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari15',
    // Vite 8 bundles with rolldown; leave the minifier at its default (oxc).
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // Keep xterm out of the entry chunk so first paint is not blocked by it.
        manualChunks: (id: string) =>
          id.includes('node_modules/@xterm/') ? 'xterm' : undefined,
      },
    },
  },
})
