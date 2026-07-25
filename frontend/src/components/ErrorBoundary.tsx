/**
 * The single class component in the app — React error boundaries require one
 * (the documented exception to functional-only). A render crash shows a calm
 * recovery card instead of a blank page (React 19: an unhandled render error
 * unmounts the whole tree).
 */

import { DegradedSurface } from "./ui/degraded-state.tsx";
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
        // A crash is a DEGRADED state, not an empty one — the old markup was
        // `.empty-state`, i.e. the treatment that means "we looked and there was
        // nothing here". `DegradedSurface` names what failed, wears the `error`
        // violet rather than danger red (§0 rule 3: this is our plumbing, not a
        // claim about a package), and offers a way out.
        //
        // Deliberately NOT a `PanelPage`: this boundary mounts outside both
        // providers, so it must not depend on anything a provider supplies.
        <div className="ng-root mx-auto w-full max-w-[1160px] px-4 py-16">
          <DegradedSurface
            failure={{
              what: "This page",
              detail: this.state.error.message,
              retry: () => {
                this.setState({ error: null });
                window.location.assign("/");
              },
            }}
            escape={{ label: "Back to home", href: "/" }}
          />
        </div>
      );
    }
    return this.props.children;
  }
}
