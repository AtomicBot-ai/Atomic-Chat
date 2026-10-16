import { Component, type ErrorInfo, type ReactNode } from 'react'
import GlobalError from '@/containers/GlobalError'
import { reportError } from '@/lib/crash-reporting'

type AppErrorBoundaryProps = { children: ReactNode }
type AppErrorBoundaryState = { error: unknown; hasError: boolean }

/**
 * Last-resort boundary around the router: a render error anywhere below
 * shows the global error screen instead of a blank window. Errors are
 * logged locally, and reported only when the user turned crash reports on.
 */
export class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { error: null, hasError: false }

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return { error, hasError: true }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[AppErrorBoundary]', error, info.componentStack)
    reportError(error)
  }

  render(): ReactNode {
    if (this.state.hasError) return <GlobalError error={this.state.error} />
    return this.props.children
  }
}
