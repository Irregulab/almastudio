import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

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
