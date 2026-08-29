import { Component, type ReactNode } from 'react';

// A render throw would otherwise unmount the whole tree to a blank page — worst
// on the unattended clubhouse TV. Catch it, show a calm fallback, and reload on
// a timer so the board recovers itself with nobody there to press refresh.
interface Props {
  children: ReactNode;
}
interface State {
  failed: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };
  private timer: number | undefined;

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    // Surface to the console (and PostHog's error capture, if enabled).
    console.error('Board error boundary caught:', error);
    this.timer = window.setTimeout(() => window.location.reload(), 8000);
  }

  componentWillUnmount(): void {
    if (this.timer) window.clearTimeout(this.timer);
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="page-loading mono-label" style={{ textAlign: 'center', lineHeight: 1.8 }}>
          SIGNAL INTERRUPTED
          <br />
          <span style={{ opacity: 0.6 }}>reacquiring…</span>
        </div>
      );
    }
    return this.props.children;
  }
}
