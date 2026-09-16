import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { invoke } from '@tauri-apps/api/core'
import App from './App'
import { CrashBoundary } from './components/CrashBoundary'

// Forward uncaught errors to the Rust side, which both prints them where
// `tauri dev` shows them and appends them to a log file. A shipped build's
// console is otherwise invisible, so without this a crash — at boot or later
// — just looks like a window that went blank, with nothing to diagnose it by.
const report = (level: string, message: string) => {
  void invoke('log_frontend', { level, message }).catch(() => {})
}
window.addEventListener('error', (e) =>
  report('error', `${e.message} (${e.filename}:${e.lineno}:${e.colno})`),
)
window.addEventListener('unhandledrejection', (e) =>
  report('rejection', String((e as PromiseRejectionEvent).reason)),
)

// The context menu is provided per-component; the webview's own is noise.
document.addEventListener('contextmenu', (e) => {
  const el = e.target as HTMLElement
  if (!el.closest('input, textarea, .term')) e.preventDefault()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CrashBoundary>
      <App />
    </CrashBoundary>
  </StrictMode>,
)
