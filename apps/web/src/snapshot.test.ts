/**
 * Tests for the snapshot boundary validator (`./snapshot`).
 *
 * `parseSnapshot` is the single place the untrusted `demo-snapshot.json` is
 * proven to match the frozen schema before the rest of the app trusts it, so it
 * gets exercised here for both the happy path (round-trip) and every hand-rolled
 * type guard (each must throw a `SnapshotParseError` whose message carries the
 * exact JSON path of the offending field).
 *
 * React-free by construction: `snapshot.ts` imports only types from `./types`,
 * so this runs under `node:test` with no DOM/jsdom.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSnapshot, SnapshotParseError } from "./snapshot";
import type { Snapshot } from "./types";

/** A structurally-complete, schema-valid snapshot used as the mutation base. */
function validSnapshot(): Snapshot {
  return {
    asOf: 1_700_000_000,
    currency: "USDC",
    decimals: 6,
    principal: { name: "alice.eth", verified: true },
    nodes: [
      {
        name: "alice.eth",
        parent: null,
        identityStatus: "verified",
        mandate: {
          budget: "100000000",
          spentDirect: "0",
          reserved: "30000000",
          available: "70000000",
          allowedMerchants: null,
          allowedPurposes: null,
          expiry: 4_000_000_000,
          revoked: false,
        },
      },
      {
        name: "researcher.alice.eth",
        parent: "alice.eth",
        identityStatus: "verified",
        mandate: {
          budget: "30000000",
          spentDirect: "5000000",
          reserved: "0",
          available: "25000000",
          allowedMerchants: ["arxiv", "openai"],
          allowedPurposes: ["research"],
          expiry: 4_000_000_000,
          revoked: false,
        },
      },
    ],
    events: [
      {
        seq: 1,
        type: "FUND",
        node: "alice.eth",
        detail: "Funded root",
        result: "OK",
        amount: "100000000",
        merchant: null,
      },
      {
        seq: 2,
        type: "PAYMENT",
        node: "researcher.alice.eth",
        detail: "Bought a paper",
        result: "SETTLED",
        amount: "5000000",
        merchant: "arxiv",
      },
    ],
  };
}

test("valid snapshot round-trips and deep-equals the input", () => {
  const input = validSnapshot();
  const parsed = parseSnapshot(input);
  // Structural equality: every field is preserved verbatim.
  assert.deepEqual(parsed, input);
});

/**
 * Assert that parsing `raw` throws a `SnapshotParseError` whose message contains
 * `path` (and, when given, the human `expected` fragment).
 */
function assertRejects(raw: unknown, path: string, expected?: string): void {
  assert.throws(
    () => parseSnapshot(raw),
    (err: unknown) => {
      assert.ok(
        err instanceof SnapshotParseError,
        `expected SnapshotParseError, got ${String(err)}`,
      );
      assert.ok(
        err.message.includes(path),
        `message ${JSON.stringify(err.message)} should include path ${JSON.stringify(path)}`,
      );
      if (expected !== undefined) {
        assert.ok(
          err.message.includes(expected),
          `message ${JSON.stringify(err.message)} should include ${JSON.stringify(expected)}`,
        );
      }
      return true;
    },
  );
}

test("root that is not an object throws with 'snapshot: expected object'", () => {
  assert.throws(
    () => parseSnapshot(42),
    (err: unknown) =>
      err instanceof SnapshotParseError &&
      err.message.includes("snapshot: expected object"),
  );
  assertRejects(null, "snapshot", "expected object");
  assertRejects([], "snapshot", "expected object"); // arrays are not plain objects
});

test("mandate.budget as a number (not string) throws with the exact path message", () => {
  const bad = validSnapshot() as unknown as Record<string, unknown>;
  (bad.nodes as unknown[])[0] = {
    ...validSnapshot().nodes[0],
    mandate: { ...validSnapshot().nodes[0]!.mandate, budget: 100 },
  };
  assertRejects(
    bad,
    "snapshot.nodes[0].mandate.budget: expected string, got number",
  );
});

test("bad identityStatus literal throws at the node path", () => {
  const bad = validSnapshot();
  (bad.nodes[1] as unknown as Record<string, unknown>).identityStatus = "revoked";
  assertRejects(bad, "snapshot.nodes[1].identityStatus");
});

test("bad event.type literal throws at the event path", () => {
  const bad = validSnapshot();
  (bad.events[0] as unknown as Record<string, unknown>).type = "TRANSFER";
  assertRejects(bad, "snapshot.events[0].type");
});

test("bad event.result literal throws at the event path", () => {
  const bad = validSnapshot();
  (bad.events[1] as unknown as Record<string, unknown>).result = "MAYBE";
  assertRejects(bad, "snapshot.events[1].result");
});

test("nodes not an array throws with 'snapshot.nodes: expected array'", () => {
  const bad = validSnapshot() as unknown as Record<string, unknown>;
  bad.nodes = { "0": "nope" };
  assertRejects(bad, "snapshot.nodes", "expected array");
});

test("events not an array throws with 'snapshot.events: expected array'", () => {
  const bad = validSnapshot() as unknown as Record<string, unknown>;
  bad.events = "not-an-array";
  assertRejects(bad, "snapshot.events", "expected array");
});

test("principal.verified not a boolean throws at the principal path", () => {
  const bad = validSnapshot();
  (bad.principal as unknown as Record<string, unknown>).verified = "yes";
  assertRejects(bad, "snapshot.principal.verified", "expected boolean, got string");
});

test("event.amount of the wrong type throws at the amount path", () => {
  const bad = validSnapshot();
  // amount is `string | null`; a number is neither.
  (bad.events[0] as unknown as Record<string, unknown>).amount = 100;
  assertRejects(bad, "snapshot.events[0].amount", "expected string | null, got number");
});

/* -------------------------------------------------------------------------- */
/* Replay material (grant / before / hash): optional, checked when present     */
/* -------------------------------------------------------------------------- */

/** validSnapshot() with the fields core now serializes for replay. */
function replayableSnapshot(): Snapshot {
  const s = validSnapshot();
  s.events[0] = {
    ...s.events[0]!,
    grant: {
      parent: null,
      identityStatus: "verified",
      allowedMerchants: null,
      allowedPurposes: null,
      expiry: 4_000_000_000,
      principal: { name: "alice.eth", verified: true },
    },
    hash: "a".repeat(64),
  };
  s.events[1] = { ...s.events[1]!, before: "30000000", hash: "b".repeat(64) };
  return s;
}

test("snapshots with replay material round-trip; older ones without it stay valid", () => {
  const input = replayableSnapshot();
  assert.deepEqual(parseSnapshot(input), input);
  const old = parseSnapshot(validSnapshot());
  assert.ok(!("grant" in old.events[0]!) && !("hash" in old.events[0]!) && !("before" in old.events[1]!));
});

test("malformed replay material throws at its path", () => {
  const badHash = replayableSnapshot();
  (badHash.events[0] as unknown as Record<string, unknown>).hash = 7;
  assertRejects(badHash, "snapshot.events[0].hash", "expected string, got number");

  const badBefore = replayableSnapshot();
  (badBefore.events[1] as unknown as Record<string, unknown>).before = null;
  assertRejects(badBefore, "snapshot.events[1].before", "expected string, got null");

  const badGrant = replayableSnapshot();
  (badGrant.events[0]!.grant as unknown as Record<string, unknown>).allowedMerchants = "arxiv";
  assertRejects(badGrant, "snapshot.events[0].grant.allowedMerchants");

  const badPrincipal = replayableSnapshot();
  (badPrincipal.events[0]!.grant!.principal as unknown as Record<string, unknown>).verified = "yes";
  assertRejects(badPrincipal, "snapshot.events[0].grant.principal.verified", "expected boolean");
});

test("the committed demo snapshot parses with its replay material intact", async () => {
  const { readFileSync } = await import("node:fs");
  const raw: unknown = JSON.parse(readFileSync(new URL("../public/demo-snapshot.json", import.meta.url), "utf8"));
  const parsed = parseSnapshot(raw);
  assert.deepEqual(parsed, raw);
  assert.ok(parsed.events.every((e) => typeof e.hash === "string" && e.hash.length === 64));
  assert.ok(parsed.events.every((e) => !((e.type === "FUND" || e.type === "DELEGATE") && e.result === "OK") || e.grant !== undefined));
});
