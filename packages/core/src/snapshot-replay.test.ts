/**
 * The audit holds across persistence: a snapshot's JSON alone rebuilds the
 * tree (`replaySnapshot`), and what was edited in it is reported
 * (`verifySnapshot`). (That every API path and random operation sequences
 * round-trip exactly is pinned in replay.test.ts, whose `assertReplays`
 * replays the snapshot JSON too.) Each test here pins one side:
 *  - the hash chain: every recorded event carries it, a caller cannot set it;
 *  - a node edited in the JSON without a matching event is reported;
 *  - an event edited, deleted or inserted in the JSON breaks the chain;
 *  - what the chain does NOT stop, stated as tests: a rewrite that recomputes
 *    every later hash, or a log cut short at its end, is caught only against
 *    a trusted head; a forged event appended through recordEvent is not;
 *  - older snapshots (no grant/before/hash) still parse, and are reported
 *    as not replayable rather than crashing;
 *  - the committed demo snapshot replays.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GENESIS_HASH, eventHash } from "./chain";
import { pay, type PaymentAdapters } from "./payment";
import { SnapshotFormatError, fromSnapshotEvents, replaySnapshot, toSnapshot, verifySnapshot } from "./serialize";
import { DelegationTree, ReplayError, type LogDiscrepancy } from "./tree";
import type { Snapshot, SnapshotEvent } from "./types";

const FAR = 4_000_000_000;
const NOW = 1_000;
const allowAll: PaymentAdapters = {
  identity: { verify: async () => ({ ok: true }) },
  screening: { screen: async () => ({ approved: true }) },
  settlement: {
    settle: async (req) => ({
      settled: true,
      swapped: false,
      fromToken: req.payerToken,
      toToken: req.merchantToken,
      amountIn: req.amount,
      amountOut: req.amount,
    }),
  },
};
const rejectScreening: PaymentAdapters = { ...allowAll, screening: { screen: async () => ({ approved: false }) } };

const POD = "pod.fund.eth";
const A = `a.${POD}`;
const B = `b.${POD}`;
const EXEC = `exec.${A}`;

/** fundRoot, delegate, resize, close, revoke and settled/blocked payments. */
async function built(): Promise<DelegationTree> {
  const tree = new DelegationTree();
  tree.fundRoot({ principal: "p", rootName: "fund.eth", mandate: { budget: 1_000n, allowedMerchants: ["X", "Y"], expiry: FAR } });
  tree.delegate("fund.eth", "pod", { budget: 600n, allowedMerchants: ["X", "Y"], allowedPurposes: ["trade"], expiry: FAR });
  tree.delegate(POD, "a", { budget: 300n, allowedMerchants: ["X", "Y"], allowedPurposes: ["trade"], expiry: FAR });
  tree.delegate(POD, "b", { budget: 200n, allowedMerchants: ["X"], allowedPurposes: ["trade"], expiry: FAR }, { identityStatus: "expired" });
  tree.delegate(A, "exec", { budget: 100n, allowedMerchants: ["X"], allowedPurposes: ["trade"], expiry: FAR });
  assert.equal((await pay(tree, { node: A, merchant: "X", amount: 20n, purpose: "trade" }, allowAll, { now: NOW })).outcome, "SETTLED");
  assert.equal((await pay(tree, { node: EXEC, merchant: "X", amount: 5n, purpose: "trade" }, allowAll, { now: NOW })).outcome, "SETTLED");
  assert.equal((await pay(tree, { node: A, merchant: "X", amount: 5n, purpose: "trade" }, rejectScreening, { now: NOW })).outcome, "BLOCKED_SCREENING");
  tree.resize(A, 250n);
  tree.close(EXEC);
  tree.revoke(B);
  return tree;
}

/** The tree's snapshot as a reader gets it: parsed JSON, free to edit. */
function jsonOf(tree: DelegationTree): Snapshot {
  return JSON.parse(JSON.stringify(toSnapshot(tree, { asOf: 1 }))) as Snapshot;
}

const kinds = (d: readonly LogDiscrepancy[]) => d.map((x) => `${x.kind} ${x.node}`);

/** Give A's budget `to` in the JSON's nodes, with pod's reserved and both availables to match. */
function editBudgetOfA(snap: Snapshot, from: bigint, to: bigint): void {
  const a = snap.nodes.find((n) => n.name === A)!.mandate;
  const pod = snap.nodes.find((n) => n.name === POD)!.mandate;
  a.budget = to.toString();
  a.available = (BigInt(a.available) + to - from).toString();
  pod.reserved = (BigInt(pod.reserved) + to - from).toString();
  pod.available = (BigInt(pod.available) - to + from).toString();
}

/** Recompute the hashes of events `from` to `to` (default: the end), as someone rewriting the JSON would. */
function rechain(snap: Snapshot, from = 0, to = snap.events.length): void {
  const events = fromSnapshotEvents(snap.events);
  let prev = from === 0 ? GENESIS_HASH : snap.events[from - 1]!.hash!;
  for (let i = from; i < to; i++) {
    const e = { ...events[i]! };
    delete e.hash;
    prev = eventHash(prev, e);
    snap.events[i]!.hash = prev;
  }
}

test("every recorded event carries its chain link; a caller cannot set it", async () => {
  const tree = await built();
  let prev = GENESIS_HASH;
  for (const e of tree.events) {
    const { hash, ...fields } = e;
    assert.match(hash!, /^[0-9a-f]{64}$/);
    assert.equal(hash, eventHash(prev, fields), `seq ${e.seq}`);
    prev = hash!;
  }
  assert.equal(tree.head, prev);
  assert.equal(new DelegationTree().head, GENESIS_HASH);

  const forced = tree.recordEvent({ type: "DELEGATE", node: `x.${B}`, detail: "", result: "ATTENUATION_REJECTED", amount: 1n, merchant: null, hash: "f".repeat(64) } as never);
  assert.notEqual(forced.hash, "f".repeat(64));
  assert.deepEqual(tree.verifyAgainstLog({ fromScratch: true }), []);
});

test("the JSON replays to the live tree, and the replayed tree carries on the same chain", async () => {
  const tree = await built();
  const back = replaySnapshot(jsonOf(tree), { head: tree.head });
  assert.deepEqual(back.listNodes(), tree.listNodes());
  assert.deepEqual(back.events, tree.events);
  for (const t of [tree, back]) {
    t.resize(A, 200n);
    t.delegate(POD, "c", { budget: 50n, allowedMerchants: ["Y"], allowedPurposes: ["trade"], expiry: FAR });
  }
  assert.equal(back.head, tree.head);
  assert.deepEqual(jsonOf(back), jsonOf(tree));
  assert.deepEqual(back.verifyAgainstLog(), []);
});

test("a node edited in the JSON without a matching event is reported, field by field", async () => {
  const tree = await built();
  const edits: [string, (s: Snapshot) => void, string[]][] = [
    ["a budget", (s) => void (s.nodes.find((n) => n.name === A)!.mandate.budget = "900"), [`UNLOGGED_WRITE ${A}`]],
    ["a budget with its available to match", (s) => {
      const m = s.nodes.find((n) => n.name === A)!.mandate;
      m.budget = "900";
      m.available = (BigInt(m.available) + 650n).toString();
    }, [`UNLOGGED_WRITE ${A}`, `UNLOGGED_WRITE ${A}`]],
    ["a spend refunded", (s) => void (s.nodes.find((n) => n.name === A)!.mandate.spentDirect = "0"), [`UNLOGGED_WRITE ${A}`]],
    ["a revoke undone", (s) => void (s.nodes.find((n) => n.name === B)!.mandate.revoked = false), [`UNLOGGED_WRITE ${B}`]],
    ["a merchant added", (s) => void s.nodes.find((n) => n.name === EXEC)!.mandate.allowedMerchants!.push("Y"), [`UNLOGGED_WRITE ${EXEC}`]],
    ["a purpose list dropped", (s) => void (s.nodes.find((n) => n.name === B)!.mandate.allowedPurposes = null), [`UNLOGGED_WRITE ${B}`]],
    ["an identity upgraded", (s) => void (s.nodes.find((n) => n.name === B)!.identityStatus = "verified"), [`UNLOGGED_WRITE ${B}`]],
    ["an expiry extended", (s) => void (s.nodes.find((n) => n.name === B)!.mandate.expiry = FAR + 1), [`UNLOGGED_WRITE ${B}`]],
    ["the principal", (s) => void (s.principal.verified = false), ["UNLOGGED_WRITE null"]],
    ["a node removed", (s) => void (s.nodes = s.nodes.filter((n) => n.name !== EXEC)), [`UNLOGGED_WRITE ${EXEC}`]],
    ["a node added", (s) => void s.nodes.push({ ...structuredClone(s.nodes[4]!), name: `ghost.${POD}` }), [`UNLOGGED_WRITE ghost.${POD}`]],
    ["two nodes swapped", (s) => void ([s.nodes[2], s.nodes[3]] = [s.nodes[3]!, s.nodes[2]!]), ["UNLOGGED_WRITE null"]],
  ];
  for (const [label, edit, expected] of edits) {
    const snap = jsonOf(tree);
    assert.deepEqual(verifySnapshot(snap, { head: tree.head }), [], `${label}: clean before the edit`);
    edit(snap);
    const found = verifySnapshot(snap, { head: tree.head });
    assert.deepEqual(kinds(found), expected, label);
    assert.throws(() => replaySnapshot(snap), ReplayError, label);
  }
  const snap = jsonOf(tree);
  snap.nodes.find((n) => n.name === A)!.mandate.budget = "900";
  assert.match(verifySnapshot(snap)[0]!.message, /in the snapshot, budget of "a.pod.fund.eth" is "900", but its log says "250"/);
});

test("an event edited, deleted, inserted or reordered in the JSON breaks the chain where it happened", async () => {
  const tree = await built();
  const chainBreaks = (d: readonly LogDiscrepancy[]) => d.filter((x) => x.kind === "LOG_REWRITTEN").map((x) => x.seq);

  // Edited: a resize's amount (the node edited to match, so only the chain can tell).
  const resizeAt = tree.events.findIndex((e) => e.type === "RESIZE" && e.node === A);
  const edited = jsonOf(tree);
  edited.events[resizeAt]!.amount = "290";
  editBudgetOfA(edited, 250n, 290n);
  assert.deepEqual(kinds(verifySnapshot(edited)), [`LOG_REWRITTEN ${A}`], "the nodes match the edited log: only the chain tells");
  assert.deepEqual(chainBreaks(verifySnapshot(edited)), [resizeAt]);
  assert.throws(() => replaySnapshot(edited), (err: unknown) => err instanceof ReplayError && /hash chain breaks/.test(err.message));

  // Edited, and that event's own hash recomputed: the NEXT link breaks.
  rechain(edited, resizeAt, resizeAt + 1);
  assert.deepEqual(chainBreaks(verifySnapshot(edited)), [resizeAt + 1]);

  // A settled payment deleted (and the spend edited out of the nodes).
  const payAt = tree.events.findIndex((e) => e.type === "PAYMENT" && e.result === "SETTLED" && e.node === A);
  const deleted = jsonOf(tree);
  deleted.events.splice(payAt, 1);
  const a = deleted.nodes.find((n) => n.name === A)!.mandate;
  a.spentDirect = "0";
  a.available = (BigInt(a.available) + 20n).toString();
  // The event after the gap no longer links to the one now before it (it
  // keeps its own seq, payAt + 1, which is also out of sequence).
  assert.equal(chainBreaks(verifySnapshot(deleted))[0], payAt + 1);
  assert.ok(verifySnapshot(deleted).some((d) => d.kind === "BAD_EVENT" && /out of sequence/.test(d.message)));
  // ... and renumbered, so the sequence numbers no longer tell.
  deleted.events.forEach((e, i) => (e.seq = i));
  assert.deepEqual(chainBreaks(verifySnapshot(deleted)).slice(0, 1), [payAt]);

  // An event inserted (a copy of the grant to a, re-sequenced).
  const inserted = jsonOf(tree);
  inserted.events.splice(3, 0, structuredClone(inserted.events[2]!));
  inserted.events.forEach((e, i) => (e.seq = i));
  assert.ok(chainBreaks(verifySnapshot(inserted)).includes(3));

  // Two events swapped, with their sequence numbers.
  const swapped = jsonOf(tree);
  [swapped.events[5], swapped.events[6]] = [swapped.events[6]!, swapped.events[5]!];
  swapped.events[5]!.seq = 5;
  swapped.events[6]!.seq = 6;
  assert.ok(chainBreaks(verifySnapshot(swapped)).includes(5));

  // A hash deleted.
  const unhashed = jsonOf(tree);
  delete unhashed.events[4]!.hash;
  assert.match(verifySnapshot(unhashed)[0]!.message, /carries no hash/);
});

test("what the chain does not stop: a full rewrite or a cut-off tail passes without a trusted head; a forged recordEvent passes", async () => {
  const tree = await built();
  const head = tree.head;

  // Rewritten, every later hash recomputed, nodes edited to match: only the
  // trusted head tells.
  const resizeAt = tree.events.findIndex((e) => e.type === "RESIZE" && e.node === A);
  const rewritten = jsonOf(tree);
  rewritten.events[resizeAt]!.amount = "290";
  editBudgetOfA(rewritten, 250n, 290n);
  rechain(rewritten, resizeAt);
  assert.deepEqual(verifySnapshot(rewritten), [], "an unkeyed chain can be recomputed");
  assert.deepEqual(kinds(verifySnapshot(rewritten, { head })), ["LOG_REWRITTEN null"]);

  // The last event (b's revoke) cut off, and the node edited to match.
  const cut = jsonOf(tree);
  cut.events.pop();
  cut.nodes.find((n) => n.name === B)!.mandate.revoked = false;
  assert.deepEqual(verifySnapshot(cut), [], "a shorter valid chain is still a valid chain");
  assert.match(verifySnapshot(cut, { head })[0]!.message, /cut short or rewritten/);

  // A forged event appended through the public API is chained like any other.
  const forged = await built();
  forged.requireNode(B).mandate.revoked = false;
  forged.recordEvent({ type: "RESIZE", node: A, detail: "forged", result: "OK", amount: 260n, merchant: null, before: 250n });
  forged.requireNode(A).mandate.budget = 260n;
  assert.deepEqual(kinds(forged.verifyAgainstLog()), [`UNLOGGED_WRITE ${B}`], "the direct write is caught; the forged event is not");
  assert.deepEqual(verifySnapshot(jsonOf(forged), { head: forged.head }).filter((d) => d.node === A), []);
});

test("in memory too: an edited or deleted past event is caught by the chain on a replay of the whole log", async () => {
  const edited = await built();
  const log = edited.events as import("./types").AllowanceEvent[];
  log[2] = Object.freeze({ ...log[2]!, amount: 301n });
  assert.ok(edited.verifyAgainstLog({ fromScratch: true }).some((d) => d.kind === "LOG_REWRITTEN" && d.seq === 2));

  const deleted = await built();
  const events = [...deleted.events];
  events.splice(6, 1);
  // The very event objects the tree recorded, one gone: the one after the
  // gap follows another hash than the one it was chained to.
  const gap = DelegationTree.replayLog(events).discrepancies.filter((d) => d.kind === "LOG_REWRITTEN");
  assert.deepEqual(gap.map((d) => d.seq), [7]);
  const renumbered = events.map((e, i) => Object.freeze({ ...e, seq: i }));
  const { discrepancies } = DelegationTree.replayLog(renumbered);
  assert.equal(discrepancies.find((d) => d.kind === "LOG_REWRITTEN")?.seq, 6);
  assert.throws(() => DelegationTree.replay(renumbered), ReplayError);
});

test("older snapshots (no grant, before or hash) still read, and are reported as not replayable", async () => {
  const tree = await built();
  const old = jsonOf(tree);
  for (const e of old.events as SnapshotEvent[]) {
    delete e.grant;
    delete e.before;
    delete e.hash;
  }
  const events = fromSnapshotEvents(old.events);
  assert.equal(events.length, tree.events.length);
  const found = verifySnapshot(old);
  assert.ok(found.some((d) => d.kind === "BAD_EVENT" && /no grant/.test(d.message)));
  assert.ok(found.some((d) => d.kind === "LOG_REWRITTEN" && /carries no hash/.test(d.message)));
  assert.throws(() => replaySnapshot(old), ReplayError);
});

test("a malformed serialized field is a SnapshotFormatError naming its path", async () => {
  const snap = jsonOf(await built());
  snap.events[0]!.amount = "1e3";
  assert.throws(() => verifySnapshot(snap), (err: unknown) => err instanceof SnapshotFormatError && /events\[0\]\.amount/.test(err.message));
  const snap2 = jsonOf(await built());
  (snap2.events[1]!.grant as { allowedMerchants: unknown }).allowedMerchants = "X";
  assert.throws(() => verifySnapshot(snap2), (err: unknown) => err instanceof SnapshotFormatError && /events\[1\]\.grant\.allowedMerchants/.test(err.message));
});

test("the committed demo snapshot (npm run demo) replays from its JSON alone", () => {
  const path = fileURLToPath(new URL("../../../apps/web/public/demo-snapshot.json", import.meta.url));
  const snap = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
  const tree = replaySnapshot(snap);
  assert.equal(tree.events.length, snap.events.length);
  assert.deepEqual(toSnapshot(tree, { asOf: snap.asOf, decimals: snap.decimals }), snap);
});
