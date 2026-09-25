import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Error boundary for one lazily loaded section. A render error inside the
 * section (or a failed chunk load) replaces only that section with the same
 * actionable `.notice-error` the fetch errors use, instead of unmounting the
 * whole page (DESIGN.md §11.1).
 */
interface Props {
  /** What failed, e.g. "the fund console". */
  what: string;
  /** How to regenerate the section's data, e.g. "npm run demo:fund". */
  hint: ReactNode;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class SectionBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the stack in the console for whoever is debugging the section.
    console.error(`Allowance: ${this.props.what} failed to render`, error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="notice notice-error" role="alert">
        Could not render {this.props.what}: {this.state.error.message}
        <div className="notice-hint">{this.props.hint}</div>
      </div>
    );
  }
}
