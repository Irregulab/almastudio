import { Component, type ReactNode } from 'react'
import { invoke } from '@tauri-apps/api/core'

interface Props {
  children: ReactNode
}
interface State {
  error: Error | null
}

/**
 * Catches a render-time crash instead of letting React unmount the whole
 * tree, which otherwise leaves nothing on screen but the page's own
 * background — indistinguishable from the window never having painted at
 * all. Reports the error the same way main.tsx reports a boot-time one, so a
 * crash in a shipped build leaves a trace in its log file instead of just
 * "the window went black".
 */
export class CrashBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    const message = `${error.message}\n${error.stack ?? ''}\n${info.componentStack ?? ''}`
    void invoke('log_frontend', { level: 'crash', message }).catch(() => {})
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          padding: 24,
          textAlign: 'center',
          background: '#1e1e1e',
          color: '#cccccc',
          fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
        }}
      >
        <div style={{ fontWeight: 600, fontSize: 15 }}>
          AlmaStudio hit a problem and needs to reload
        </div>
        <div style={{ fontSize: 12, opacity: 0.7, maxWidth: 560, whiteSpace: 'pre-wrap' }}>
          {error.message}
        </div>
        <button
          onClick={() => window.location.reload()}
          style={{
            padding: '6px 14px',
            borderRadius: 6,
            border: '1px solid #555',
            background: '#333',
            color: '#eeeeee',
            cursor: 'pointer',
            font: 'inherit',
          }}
        >
          Reload
        </button>
      </div>
    )
  }
}
