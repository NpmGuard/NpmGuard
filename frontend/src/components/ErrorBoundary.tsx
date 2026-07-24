/**
 * The single class component in the app — React error boundaries require one
 * (the documented exception to functional-only). A render crash shows a calm
 * recovery card instead of a blank page (React 19: an unhandled render error
 * unmounts the whole tree).
 */

import { Component, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override render() {
    if (this.state.error) {
      return (
        <div className="empty-state" role="alert" style={{ minHeight: "60vh" }}>
          <div className="empty-state__icon" aria-hidden="true">
            !
          </div>
          <p className="headline headline--sm">Something broke while rendering</p>
          <p className="subtext">{this.state.error.message}</p>
          <button
            type="button"
            className="btn"
            onClick={() => {
              this.setState({ error: null });
              window.location.assign("/");
            }}
          >
            Back to safety
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
