import { Component, type ErrorInfo, type ReactNode } from 'react'

// ═══════════════════════════════════════════════════════════════════════════════
// AN ERROR BOUNDARY AROUND ONE PANEL.
//
// A crashing panel must not blank the page: React unmounts the whole tree when a render
// throws and nothing catches it. The error text and the panel name are the difference
// between "the dashboard broke" and a one-line bug report, so the message is SHOWN, not
// just logged to a console nobody has open during a class.
// ═══════════════════════════════════════════════════════════════════════════════

type Props = { name: string; children: ReactNode }
type State = { error: Error | null }

export default class PanelBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[matcher] panel "${this.props.name}" crashed`, error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div
        data-testid={`panel-error-${this.props.name}`}
        role="alert"
        style={{ margin: '0 0 1rem', padding: '0.6rem 1rem', border: '1px solid #fca5a5',
                 borderRadius: 8, background: '#fef2f2', fontSize: '0.85rem' }}
      >
        <strong>The “{this.props.name}” panel could not be shown.</strong>
        {' '}The rest of this page still works.
        <div style={{ marginTop: '0.3rem', fontFamily: 'monospace', fontSize: '0.75rem', color: '#7f1d1d' }}>
          {this.state.error.message}
        </div>
      </div>
    )
  }
}
