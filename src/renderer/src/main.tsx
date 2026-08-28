import React from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import App from './App'
import ExportWorker from './export/ExportWorker'

/** Last line of defence: show the error instead of a blank window. */
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error?: Error }> {
  state: { error?: Error } = {}
  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }
  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('UI crashed', error, info.componentStack)
  }
  render(): React.ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div style={{ padding: 24, fontFamily: 'monospace', whiteSpace: 'pre-wrap', userSelect: 'text' }}>
        <h2 style={{ marginBottom: 12 }}>The editor hit an error</h2>
        <p style={{ marginBottom: 12 }}>Your project is still in memory; save with Ctrl+S from the menu, then reload (Ctrl+R).</p>
        <button onClick={() => this.setState({ error: undefined })}>Try to continue</button>
        <pre style={{ marginTop: 16, opacity: 0.8 }}>{this.state.error.stack ?? String(this.state.error)}</pre>
      </div>
    )
  }
}

const mode = new URLSearchParams(location.search).get('mode')
const root = createRoot(document.getElementById('root')!)
root.render(
  <React.StrictMode>
    <ErrorBoundary>{mode === 'export' ? <ExportWorker /> : <App />}</ErrorBoundary>
  </React.StrictMode>,
)
