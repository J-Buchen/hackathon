/**
 * Runtime validator for the snapshot JSON at the fetch boundary.
 *
 * `demo-snapshot.json` is untrusted input as far as the type system is
 * concerned: `fetch(...).json()` returns `any`, so casting it to `Snapshot`
 * is a lie the compiler happily accepts. A malformed or stale file would then
 * crash deep inside `buildTree`/`formatAmount` with an opaque error. Instead we
 * validate the parsed value here and throw a precise, path-tagged message that
 * the App's `{status:'error'}` branch can render verbatim.
 *
 * This file only *reads* the frozen schema in `./types` — it never redefines or
 * mutates it. The exported `parseSnapshot` returns the same value it was given,
 * re-typed as `Snapshot` once every field has been proven correct at runtime.
 */

import type {
  Snapshot,
  SnapshotNode,
  SnapshotEvent,
  SnapshotMandate,
  IdentityStatus,
  EventType,
  EventResult,
} from "./types";

/** Thrown for any structural/type mismatch; message includes the JSON path. */
export class SnapshotParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotParseError";
  }
}

/* -------------------------------------------------------------------------- */
/* Primitive guards + assertion helpers                                        */
/* -------------------------------------------------------------------------- */

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fail(path: string, expected: string, actual: unknown): never {
  const got = actual === null ? "null" : Array.isArray(actual) ? "array" : typeof actual;
  throw new SnapshotParseError(`${path}: expected ${expected}, got ${got}`);
}

function asObject(v: unknown, path: string): Record<string, unknown> {
  if (!isObject(v)) fail(path, "object", v);
  return v;
}

function asString(v: unknown, path: string): string {
  if (typeof v !== "string") fail(path, "string", v);
  return v;
}

function asNumber(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) fail(path, "finite number", v);
  return v;
}

function asBoolean(v: unknown, path: string): boolean {
  if (typeof v !== "boolean") fail(path, "boolean", v);
  return v;
}

/** `string | null` — used for parent, amount, merchant. */
function asStringOrNull(v: unknown, path: string): string | null {
  if (v === null) return null;
  if (typeof v !== "string") fail(path, "string | null", v);
  return v;
}

/** `string[] | null` — used for allowedMerchants / allowedPurposes. */
function asStringArrayOrNull(v: unknown, path: string): string[] | null {
  if (v === null) return null;
  if (!Array.isArray(v)) fail(path, "string[] | null", v);
  v.forEach((item, i) => asString(item, `${path}[${i}]`));
  return v as string[];
}

/* -------------------------------------------------------------------------- */
/* Union-literal guards (kept in lockstep with types.ts by construction)       */
/* -------------------------------------------------------------------------- */

// A `Record<Literal, true>` gives us a compile-time exhaustiveness check: if a
// new union member is ever added to types.ts, TypeScript flags the missing key
// here, so these guards can never silently fall behind the frozen schema.
const IDENTITY_STATUSES: Record<IdentityStatus, true> = {
  verified: true,
  expired: true,
  none: true,
};
function isIdentityStatus(v: unknown): v is IdentityStatus {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(IDENTITY_STATUSES, v);
}

const EVENT_TYPES: Record<EventType, true> = {
  FUND: true,
  DELEGATE: true,
  PAYMENT: true,
  REVOKE: true,
};
function isEventType(v: unknown): v is EventType {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(EVENT_TYPES, v);
}

const EVENT_RESULTS: Record<EventResult, true> = {
  OK: true,
  SETTLED: true,
  BLOCKED_MANDATE: true,
  BLOCKED_SCREENING: true,
  DENIED_IDENTITY: true,
  REVOKED: true,
  ATTENUATION_REJECTED: true,
};
function isEventResult(v: unknown): v is EventResult {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(EVENT_RESULTS, v);
}

/* -------------------------------------------------------------------------- */
/* Composite guards                                                            */
/* -------------------------------------------------------------------------- */

function parseMandate(v: unknown, path: string): SnapshotMandate {
  const m = asObject(v, path);
  return {
    budget: asString(m.budget, `${path}.budget`),
    spentDirect: asString(m.spentDirect, `${path}.spentDirect`),
    reserved: asString(m.reserved, `${path}.reserved`),
    available: asString(m.available, `${path}.available`),
    allowedMerchants: asStringArrayOrNull(m.allowedMerchants, `${path}.allowedMerchants`),
    allowedPurposes: asStringArrayOrNull(m.allowedPurposes, `${path}.allowedPurposes`),
    expiry: asNumber(m.expiry, `${path}.expiry`),
    revoked: asBoolean(m.revoked, `${path}.revoked`),
  };
}

function isSnapshotNode(v: unknown, path: string): SnapshotNode {
  const n = asObject(v, path);
  if (!isIdentityStatus(n.identityStatus)) {
    fail(`${path}.identityStatus`, `'verified' | 'expired' | 'none'`, n.identityStatus);
  }
  return {
    name: asString(n.name, `${path}.name`),
    parent: asStringOrNull(n.parent, `${path}.parent`),
    identityStatus: n.identityStatus,
    mandate: parseMandate(n.mandate, `${path}.mandate`),
  };
}

function isSnapshotEvent(v: unknown, path: string): SnapshotEvent {
  const e = asObject(v, path);
  if (!isEventType(e.type)) {
    fail(`${path}.type`, `'FUND' | 'DELEGATE' | 'PAYMENT' | 'REVOKE'`, e.type);
  }
  if (!isEventResult(e.result)) {
    fail(
      `${path}.result`,
      `'OK' | 'SETTLED' | 'BLOCKED_MANDATE' | 'BLOCKED_SCREENING' | 'DENIED_IDENTITY' | 'REVOKED' | 'ATTENUATION_REJECTED'`,
      e.result,
    );
  }
  return {
    seq: asNumber(e.seq, `${path}.seq`),
    type: e.type,
    node: asString(e.node, `${path}.node`),
    detail: asString(e.detail, `${path}.detail`),
    result: e.result,
    amount: asStringOrNull(e.amount, `${path}.amount`),
    merchant: asStringOrNull(e.merchant, `${path}.merchant`),
  };
}

/* -------------------------------------------------------------------------- */
/* Public entry point                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Validate parsed JSON against the frozen Snapshot schema.
 *
 * @throws {SnapshotParseError} with a precise path message on any mismatch,
 *   e.g. `snapshot.nodes[3].mandate.budget: expected string, got number`.
 */
export function parseSnapshot(raw: unknown): Snapshot {
  const s = asObject(raw, "snapshot");

  const principal = asObject(s.principal, "snapshot.principal");

  if (!Array.isArray(s.nodes)) fail("snapshot.nodes", "array", s.nodes);
  if (!Array.isArray(s.events)) fail("snapshot.events", "array", s.events);

  return {
    asOf: asNumber(s.asOf, "snapshot.asOf"),
    currency: asString(s.currency, "snapshot.currency"),
    decimals: asNumber(s.decimals, "snapshot.decimals"),
    principal: {
      name: asString(principal.name, "snapshot.principal.name"),
      verified: asBoolean(principal.verified, "snapshot.principal.verified"),
    },
    nodes: s.nodes.map((n, i) => isSnapshotNode(n, `snapshot.nodes[${i}]`)),
    events: s.events.map((e, i) => isSnapshotEvent(e, `snapshot.events[${i}]`)),
  };
}
