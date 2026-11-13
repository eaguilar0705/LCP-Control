import { Component, type ReactNode } from 'react'
import { ApplicationError } from './ApplicationError'
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean; error: unknown }
> {
  state = { failed: false, error: null }
  static getDerivedStateFromError(error: unknown) {
    return { failed: true, error }
  }
  render() {
    return this.state.failed ? (
      <ApplicationError error={this.state.error} />
    ) : (
      this.props.children
    )
  }
}
