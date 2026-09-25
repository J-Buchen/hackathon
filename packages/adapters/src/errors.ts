/**
 * Shared error type for the real-integration stubs.
 *
 * Every "real" adapter in this package is a thin, clearly-marked stub that
 * documents the production integration but is NOT wired to live credentials
 * (we don't have them in this environment). Calling a real adapter without
 * configuration throws this error so the failure is loud and unambiguous —
 * the demo path always uses the deterministic mocks instead.
 */
export class AdapterNotConfiguredError extends Error {
  /** The sponsor/adapter that is not configured, e.g. "1inch Aqua". */
  readonly adapter: string;

  constructor(adapter: string, hint?: string) {
    super(
      `${adapter} real adapter is not configured. ` +
        `Wire the credentials marked TODO(cred) to enable it.` +
        (hint ? ` ${hint}` : ""),
    );
    this.name = "AdapterNotConfiguredError";
    this.adapter = adapter;
  }
}
