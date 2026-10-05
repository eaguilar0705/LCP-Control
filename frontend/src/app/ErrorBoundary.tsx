import { Component, type ReactNode } from 'react'
import { ErrorState } from '../components/ui'
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? (
      <ErrorState
        message="No pudimos mostrar esta pantalla. Recarga la aplicación para continuar."
        retry={() => window.location.reload()}
      />
    ) : (
      this.props.children
    )
  }
}
