/**
 * Compile-time exhaustiveness helper.
 *
 * `assertNever` is the canonical TypeScript pattern for closing a `switch` (or
 * `if/else` chain) over a discriminated union so that adding a new union member
 * becomes a COMPILE error at every call site rather than a silently-wrong
 * fallthrough. Once every variant is handled, the value narrows to `never`, so
 * the call type-checks today; introduce a new variant and the `never` parameter
 * no longer accepts it, forcing the missing case to be handled.
 *
 * The runtime `throw` only fires if a bad value reaches it at runtime (e.g. data
 * crossing a trust boundary that the type system could not vouch for).
 */
export function assertNever(value: never, label = "unexpected variant"): never {
  throw new Error(`${label}: ${String(value)}`);
}
