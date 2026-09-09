import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { invoke } from '@tauri-apps/api/core'
import App from './App'

// In development, forward uncaught errors to the Rust side so they land in the
// `tauri dev` output. Without this a boot-time exception just looks like a
// window that never finishes loading.
if (import.meta.env.DEV) {
  const report = (level: string, message: string) => {
    void invoke('log_frontend', { level, message }).catch(() => {})
  }
  window.addEventListener('error', (e) =>
    report('error', `${e.message} (${e.filename}:${e.lineno}:${e.colno})`),
  )
  window.addEventListener('unhandledrejection', (e) =>
    report('rejection', String((e as PromiseRejectionEvent).reason)),
  )
}

// The context menu is provided per-component; the webview's own is noise.
document.addEventListener('contextmenu', (e) => {
  const el = e.target as HTMLElement
  if (!el.closest('input, textarea, .term')) e.preventDefault()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
