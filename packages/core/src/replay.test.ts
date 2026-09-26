/**
 * The tree is auditable from its own history: replaying its event log
 * rebuilds it exactly (`DelegationTree.replay`), and `verifyAgainstLog()`
 * names every way the live tree departs from that replay.
 *
 * Each test pins one side of the guarantee:
 *  - every API path (fundRoot, delegate, resize, close, revoke, pay in each
 *    outcome) logs what replay needs, so the replay is exact;
 *  - a write that bypasses the API is caught at the next check, including one
 *    that keeps every invariant `audit()` checks, and one that a later API
 *    call overwrote;
 *  - the log itself can only be appended to;
 *  - over random operation sequences, the replay is exact after every
 *    operation, any direct write is caught at once, and the incremental check
 *    always agrees with a replay of the whole log.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AttenuationError } from "./attenuation";
import { pay, type PaymentAdapters } from "./payment";
import { toSnapshot } from "./serialize";
import { DelegationTree, ReplayError, type LogDiscrepancy } from "./tree";
import type { AgentNode, AllowanceEvent, PaymentOutcome } from "./types";

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
const denyIdentity: PaymentAdapters = { ...allowAll, identity: { verify: async () => ({ ok: false, reason: "no" }) } };
const rejectScreening: PaymentAdapters = { ...allowAll, screening: { screen: async () => ({ approved: false }) } };
const failSettlement: PaymentAdapters = {
  ...allowAll,
  settlement: {
    settle: async (req) => ({
      settled: false,
      swapped: false,
      fromToken: req.payerToken,
      toToken: req.merchantToken,
      amountIn: 0n,
      amountOut: 0n,
      reason: "no liquidity",
    }),
  },
};
/** Settles after a delay, so two concurrent pay() calls can both pass the budget check. */
const slow: PaymentAdapters = {
  ...allowAll,
  settlement: {
    settle: async (req) => {
      await new Promise((res) => setTimeout(res, 2));
      return allowAll.settlement.settle(req);
    },
  },
};

/**
 * The replay is exact: the incremental check and a replay of the whole log
 * find nothing, and the tree `replay` rebuilds is the live tree (every node
 * field, the principal, the children in order, and the same log).
 */
function assertReplays(tree: DelegationTree, label = ""): void {
  assert.deepEqual(tree.verifyAgainstLog(), [], `${label}: incremental`);
  assert.deepEqual(tree.verifyAgainstLog({ fromScratch: true }), [], `${label}: from scratch`);
  const rebuilt = DelegationTree.replay(tree.events);
  assert.deepEqual(rebuilt.listNodes(), tree.listNodes(), `${label}: nodes`);
  assert.deepEqual(rebuilt.principal, tree.principal, `${label}: principal`);
  for (const n of tree.listNodes()) {
    assert.deepEqual(rebuilt.childrenOf(n.name).map((c) => c.name), tree.childrenOf(n.name).map((c) => c.name), `${label}: children of ${n.name}`);
  }
  assert.deepEqual(toSnapshot(rebuilt, { asOf: 0 }), toSnapshot(tree, { asOf: 0 }), `${label}: snapshot`);
  assert.equal(rebuilt.nextSeq, tree.nextSeq);
}

const kinds = (d: readonly LogDiscrepancy[]) => d.map((x) => `${x.kind} ${x.node}`);

/* ------------------------------------------------------------------ */
/* Every API path replays exactly                                     */
/* ------------------------------------------------------------------ */

test("every API path logs what replay needs: fundRoot, delegate, resize, close, revoke and pay replay exactly", async () => {
  const tree = new DelegationTree();
  assertReplays(tree, "empty");
  tree.fundRoot({
    principal: "alice",
    rootName: "alice.eth",
    mandate: { budget: 1_000n, allowedMerchants: ["m", "n", "o"], allowedPurposes: ["data", "trade"], expiry: FAR },
    principalVerified: false,
  });
  assertReplays(tree, "fundRoot");
  const fundEvent = tree.events[0]!;
  assert.deepEqual(fundEvent.grant, {
    parent: null,
    identityStatus: "verified",
    allowedMerchants: ["m", "n", "o"],
    allowedPurposes: ["data", "trade"],
    expiry: FAR,
    principal: { name: "alice", verified: false },
  });

  tree.delegate("alice.eth", "pod", { budget: 600n, allowedMerchants: ["m", "n"], allowedPurposes: ["data", "trade"], expiry: FAR - 1 });
  tree.delegate("pod.alice.eth", "a", { budget: 300n, allowedMerchants: ["m"], allowedPurposes: ["trade"], expiry: FAR - 2 }, { identityStatus: "expired" });
  tree.delegate("pod.alice.eth", "b", { budget: 200n, allowedMerchants: ["m", "n"], allowedPurposes: ["data"], expiry: FAR - 2 });
  tree.delegate("a.pod.alice.eth", "exec", { budget: 100n, allowedMerchants: ["m"], allowedPurposes: ["trade"], expiry: FAR - 3 });
  tree.delegate("b.pod.alice.eth", "desk.v2", { budget: 50n, allowedMerchants: ["n"], allowedPurposes: ["data"], expiry: FAR - 3 }); // a dotted label
  assertReplays(tree, "delegate");

  // Every rejected delegation is logged and changes nothing.
  const rejected: [string, string, bigint, string[] | undefined, number][] = [
    ["pod.alice.eth", "greedy", 10_000n, ["m"], FAR - 2], // over available
    ["pod.alice.eth", "wide", 1n, ["m", "z"], FAR - 2], // merchants broaden
    ["pod.alice.eth", "anymerchant", 1n, undefined, FAR - 2], // "any" under a restricted parent
    ["pod.alice.eth", "late", 1n, ["m"], FAR + 5], // expiry broadens
    ["alice.eth", "neg", -1n, ["m"], FAR], // negative
  ];
  for (const [parent, label, budget, merchants, expiry] of rejected) {
    assert.throws(() => tree.delegate(parent, label, { budget, allowedMerchants: merchants, expiry }), AttenuationError);
  }
  assertReplays(tree, "rejected delegate");

  // Resizes: grow and shrink, and every refusal.
  tree.resize("b.pod.alice.eth", 250n);
  tree.resize("pod.alice.eth", 900n);
  tree.resize("a.pod.alice.eth", 150n);
  tree.resize("alice.eth", 950n);
  assert.throws(() => tree.resize("a.pod.alice.eth", 50n), AttenuationError); // below committed (exec holds 100)
  assert.throws(() => tree.resize("alice.eth", 2_000n), AttenuationError); // the root cannot grow
  assert.throws(() => tree.resize("b.pod.alice.eth", 10_000n), AttenuationError); // over the parent's available
  assert.throws(() => tree.resize("b.pod.alice.eth", -5n), AttenuationError);
  assertReplays(tree, "resize");
  const lastResize = tree.events.filter((e) => e.type === "RESIZE" && e.result === "OK").at(-1)!;
  assert.equal(lastResize.before, 1_000n);
  assert.equal(lastResize.amount, 950n);

  // Payments in every outcome: only a settlement changes the tree.
  const outcomes: [PaymentAdapters, string, string, bigint, string | undefined, PaymentOutcome][] = [
    [allowAll, "exec.a.pod.alice.eth", "m", 30n, "trade", "SETTLED"],
    [allowAll, "a.pod.alice.eth", "m", 20n, undefined, "SETTLED"],
    [allowAll, "b.pod.alice.eth", "m", 5n, "data", "SETTLED"],
    [allowAll, "exec.a.pod.alice.eth", "m", 1_000n, undefined, "BLOCKED_MANDATE"], // over available
    [allowAll, "exec.a.pod.alice.eth", "n", 1n, undefined, "BLOCKED_MANDATE"], // merchant
    [allowAll, "exec.a.pod.alice.eth", "m", 1n, "data", "BLOCKED_MANDATE"], // purpose
    [failSettlement, "b.pod.alice.eth", "m", 5n, undefined, "BLOCKED_MANDATE"],
    [rejectScreening, "b.pod.alice.eth", "m", 5n, undefined, "BLOCKED_SCREENING"],
    [denyIdentity, "b.pod.alice.eth", "m", 5n, undefined, "DENIED_IDENTITY"],
  ];
  for (const [adapters, node, merchant, amount, purpose, outcome] of outcomes) {
    const r = await pay(tree, { node, merchant, amount, purpose }, adapters, { now: NOW });
    assert.equal(r.outcome, outcome, `${node} ${merchant} ${amount}`);
    assertReplays(tree, `pay ${outcome}`);
  }
  const expired = await pay(tree, { node: "b.pod.alice.eth", merchant: "m", amount: 1n }, allowAll, { now: FAR });
  assert.equal(expired.outcome, "BLOCKED_MANDATE");

  // Two concurrent payments that both pass the budget check (the overspend
  // path SerializedPayer prevents): the log still explains the tree.
  const leaf = tree.delegate("b.pod.alice.eth", "leaf", { budget: 10n, allowedMerchants: ["n"], allowedPurposes: ["data"], expiry: FAR - 3 });
  const both = await Promise.all([
    pay(tree, { node: leaf.name, merchant: "n", amount: 10n }, slow, { now: NOW }),
    pay(tree, { node: leaf.name, merchant: "n", amount: 10n }, slow, { now: NOW }),
  ]);
  assert.deepEqual(both.map((r) => r.outcome), ["SETTLED", "SETTLED"]);
  assert.equal(leaf.mandate.spentDirect, 20n);
  assertReplays(tree, "overspend");

  // revoke (twice: it is idempotent), then close a subtree holding it, and the
  // overspent leaf's parent: every RESIZE carries the budget it started from.
  tree.revoke("desk.v2.b.pod.alice.eth");
  tree.revoke("desk.v2.b.pod.alice.eth");
  assertReplays(tree, "revoke");
  assert.throws(() => tree.resize("desk.v2.b.pod.alice.eth", 0n), AttenuationError); // revoked: refused, logged
  const from = tree.nextSeq;
  const freed = tree.close("b.pod.alice.eth");
  assert.ok(freed > 0n);
  const closeEvents = tree.events.slice(from);
  assert.ok(closeEvents.filter((e) => e.type === "RESIZE").every((e) => e.before !== undefined && e.before > e.amount!));
  assert.equal(closeEvents.at(-1)!.type, "REVOKE");
  assert.equal(closeEvents.at(-1)!.amount, freed);
  assertReplays(tree, "close");
  assert.equal(tree.close("b.pod.alice.eth"), 0n); // idempotent: logs nothing
  tree.close("a.pod.alice.eth");
  tree.close("alice.eth"); // the root, back to the principal
  assertReplays(tree, "close root");

  // Nothing new under a dead subtree: refused and logged.
  assert.throws(() => tree.delegate("exec.a.pod.alice.eth", "late", { budget: 0n, allowedMerchants: ["m"], expiry: FAR - 3 }), AttenuationError);
  assert.equal((await pay(tree, { node: "exec.a.pod.alice.eth", merchant: "m", amount: 1n }, allowAll, { now: NOW })).outcome, "REVOKED");
  assertReplays(tree, "dead");
  assert.ok(tree.events.length > 40);
});

test("the log is independent of the arrays a caller or node holds: a grant is copied and frozen when it is recorded", () => {
  const merchants = ["m", "n"];
  const tree = new DelegationTree();
  tree.fundRoot({ principal: "p", rootName: "r.eth", mandate: { budget: 100n, expiry: FAR } });
  const kid = tree.delegate("r.eth", "kid", { budget: 10n, allowedMerchants: merchants, expiry: FAR });
  const grant = tree.events.at(-1)!.grant!;
  assert.notEqual(grant.allowedMerchants, merchants);
  assert.ok(Object.isFrozen(tree.events.at(-1)) && Object.isFrozen(grant) && Object.isFrozen(grant.allowedMerchants));
  // The node shares the caller's array (as it always has): a push to it is a
  // write to the node that the log did not record.
  merchants.push("z");
  assert.deepEqual(kid.mandate.allowedMerchants, ["m", "n", "z"]);
  assert.deepEqual(grant.allowedMerchants, ["m", "n"]);
  assert.deepEqual(kinds(tree.verifyAgainstLog()), ["UNLOGGED_WRITE kid.r.eth"]);
  assert.match(tree.verifyAgainstLog()[0]!.message, /the merchants of "kid.r.eth" is \[m, n, z\], but the log says \[m, n\]/);
});

/* ------------------------------------------------------------------ */
/* Writes that bypass the API                                         */
/* ------------------------------------------------------------------ */

/** fund 1000 → pod 600 → a 300 (exec 100, a spent 20), b 200 (spent 5). */
async function built(): Promise<DelegationTree> {
  const tree = new DelegationTree();
  tree.fundRoot({ principal: "p", rootName: "fund.eth", mandate: { budget: 1_000n, allowedMerchants: ["X", "Y"], expiry: FAR } });
  tree.delegate("fund.eth", "pod", { budget: 600n, allowedMerchants: ["X", "Y"], expiry: FAR });
  tree.delegate("pod.fund.eth", "a", { budget: 300n, allowedMerchants: ["X", "Y"], expiry: FAR });
  tree.delegate("pod.fund.eth", "b", { budget: 200n, allowedMerchants: ["X"], expiry: FAR });
  tree.delegate("a.pod.fund.eth", "exec", { budget: 100n, allowedMerchants: ["X"], expiry: FAR });
  assert.equal((await pay(tree, { node: "a.pod.fund.eth", merchant: "X", amount: 20n }, allowAll, { now: NOW })).outcome, "SETTLED");
  assert.equal((await pay(tree, { node: "b.pod.fund.eth", merchant: "X", amount: 5n }, allowAll, { now: NOW })).outcome, "SETTLED");
  assertReplays(tree, "built");
  return tree;
}
const A = "a.pod.fund.eth";
const B = "b.pod.fund.eth";
const POD = "pod.fund.eth";
const EXEC = `exec.${A}`;

test("the review's case: a direct write to a budget (budget *= 2n) is caught at the next check", async () => {
  const tree = await built();
  tree.requireNode(EXEC).mandate.budget *= 2n;
  const d = tree.verifyAgainstLog();
  assert.deepEqual(kinds(d), [`UNLOGGED_WRITE ${EXEC}`]);
  assert.equal(d[0]!.seq, null, "a difference in the tree as it stands");
  assert.match(d[0]!.message, /the budget of "exec.a.pod.fund.eth" is 200, but the log says 100/);
  assert.deepEqual(tree.audit(), [], "it still fits inside its parent: audit() cannot see it");
  assert.equal(DelegationTree.replay(tree.events).requireNode(EXEC).mandate.budget, 100n, "the log alone says 100");
});

test("writes that keep every invariant audit() checks are caught: the tree is not the one its log built", async () => {
  const cases: [string, (tree: DelegationTree) => void, string[]][] = [
    [
      "budget moved between two agents of one pod",
      (tree) => {
        tree.requireNode(A).mandate.budget -= 50n;
        tree.requireNode(B).mandate.budget += 50n;
      },
      [`UNLOGGED_WRITE ${A}`, `UNLOGGED_WRITE ${B}`],
    ],
    ["a spend refunded", (tree) => void (tree.requireNode(A).mandate.spentDirect = 0n), [`UNLOGGED_WRITE ${A}`]],
    ["a bare revoke with no log entry", (tree) => void (tree.requireNode(EXEC).mandate.revoked = true), [`UNLOGGED_WRITE ${EXEC}`]],
    ["a merchant narrowed in place", (tree) => void tree.requireNode(A).mandate.allowedMerchants!.pop(), [`UNLOGGED_WRITE ${A}`]],
    ["a purpose list added", (tree) => void (tree.requireNode(B).mandate.allowedPurposes = ["data"]), [`UNLOGGED_WRITE ${B}`]],
    ["the root's own allowlist widened", (tree) => void tree.requireNode("fund.eth").mandate.allowedMerchants!.push("Z"), ["UNLOGGED_WRITE fund.eth"]],
    ["an expiry shortened", (tree) => void (tree.requireNode(B).mandate.expiry = FAR - 100), [`UNLOGGED_WRITE ${B}`]],
    ["an identity downgraded", (tree) => void (tree.requireNode(B).identityStatus = "none"), [`UNLOGGED_WRITE ${B}`]],
    ["the principal's verification flipped", (tree) => void (tree.principal!.verified = false), ["UNLOGGED_WRITE null"]],
    [
      "the mandate object swapped for a copy with a new budget",
      (tree) => {
        const n = tree.requireNode(B);
        n.mandate = { ...n.mandate, budget: 150n };
      },
      [`UNLOGGED_WRITE ${B}`],
    ],
  ];
  for (const [label, write, expected] of cases) {
    const tree = await built();
    write(tree);
    assert.deepEqual(tree.audit(), [], `${label}: audit() is clean`);
    const found = tree.verifyAgainstLog();
    assert.deepEqual(kinds(found), expected, label);
    assert.deepEqual(tree.verifyAgainstLog({ fromScratch: true }), found, `${label}: a replay of the whole log agrees`);
  }
});

test("structural writes are caught: a re-parented node, a renamed node, a node minted outside the log", async () => {
  const relinked = await built();
  relinked.requireNode(EXEC).parent = B;
  assert.deepEqual(kinds(relinked.verifyAgainstLog()), [`UNLOGGED_WRITE ${EXEC}`]);
  assert.match(relinked.verifyAgainstLog()[0]!.message, /the parent of "exec.a.pod.fund.eth" is b.pod.fund.eth, but the log says a.pod.fund.eth/);

  const renamed = await built();
  renamed.requireNode(B).name = "c.pod.fund.eth";
  assert.deepEqual(kinds(renamed.verifyAgainstLog()), [`UNLOGGED_WRITE ${B}`, `UNLOGGED_WRITE ${POD}`]);

  // Through the private insertion point, as `(tree as any)` would: the node
  // exists, holds budget and counts against its parent, but was never granted.
  const minted = await built();
  const ghost: AgentNode = {
    name: `ghost.${POD}`,
    parent: POD,
    identityStatus: "verified",
    mandate: { budget: 1n, spentDirect: 0n, allowedMerchants: ["X"], expiry: FAR, revoked: false },
  };
  (minted as unknown as { indexNode_(n: AgentNode): void }).indexNode_(ghost);
  assert.deepEqual(minted.audit(), []);
  assert.deepEqual(kinds(minted.verifyAgainstLog()), [`UNLOGGED_WRITE ghost.${POD}`, `UNLOGGED_WRITE ${POD}`]);
  assert.match(minted.verifyAgainstLog()[0]!.message, /exists, but the log never created it/);
});

test("a write overwritten through the API before the next check is still caught: each RESIZE names the budget it started from", async () => {
  // Doubled, then resized back: the tree now equals the log's final state,
  // but the RESIZE says it started from 200, and the log had left it at 100.
  const back = await built();
  back.requireNode(EXEC).mandate.budget *= 2n;
  back.resize(EXEC, 100n);
  const d = back.verifyAgainstLog();
  assert.deepEqual(kinds(d), [`UNLOGGED_WRITE ${EXEC}`]);
  assert.equal(d[0]!.seq, back.nextSeq - 1);
  assert.match(d[0]!.message, /resized from a budget of 200, but the log had left it at 100/);
  assert.equal(back.requireNode(EXEC).mandate.budget, 100n);
  assert.throws(() => DelegationTree.replay(back.events), ReplayError);

  // Inflated, then closed: close() would report freeing authority nobody granted.
  const inflated = await built();
  inflated.requireNode(B).mandate.budget = 500n;
  assert.equal(inflated.close(B), 495n, "close frees the inflated budget");
  assert.deepEqual(kinds(inflated.verifyAgainstLog()), [`UNLOGGED_WRITE ${B}`]);

  // Un-revoked, then closed again: a close is only ever logged for a live node.
  const revived = await built();
  revived.close(EXEC);
  revived.requireNode(EXEC).mandate.revoked = false;
  revived.close(EXEC);
  assert.deepEqual(kinds(revived.verifyAgainstLog()), [`UNLOGGED_WRITE ${EXEC}`]);
  assert.match(revived.verifyAgainstLog()[0]!.message, /closed as a live mandate, but the log had already revoked it/);

  // A refunded spend followed by a real payment: still off by the refund.
  const refunded = await built();
  refunded.requireNode(A).mandate.spentDirect = 0n;
  await pay(refunded, { node: A, merchant: "X", amount: 7n }, allowAll, { now: NOW });
  assert.match(refunded.verifyAgainstLog()[0]!.message, /spentDirect of "a.pod.fund.eth" is 7, but the log says 27/);

  // The before-state issue is part of the log's history: it is reported by
  // every later check, and by a replay of the whole log.
  back.resize(EXEC, 90n);
  assert.deepEqual(kinds(back.verifyAgainstLog()), [`UNLOGGED_WRITE ${EXEC}`]);
  assert.deepEqual(back.verifyAgainstLog({ fromScratch: true }), back.verifyAgainstLog());
});

/* ------------------------------------------------------------------ */
/* The log itself                                                     */
/* ------------------------------------------------------------------ */

test("the log can only be appended to: events are frozen, and a replaced, removed or smuggled-in event is caught", async () => {
  const frozen = await built();
  const e = frozen.events[2]!;
  assert.throws(() => {
    (e as { amount: bigint | null }).amount = 1n;
  }, TypeError);
  assert.throws(() => {
    (e.grant!.allowedMerchants as string[]).push("Z");
  }, TypeError);

  // Replaced after it was replayed: caught, and it stays caught.
  const replaced = await built();
  const log = replaced.events as AllowanceEvent[];
  log[3] = { ...log[3]!, amount: 250n };
  assert.deepEqual(kinds(replaced.verifyAgainstLog()), ["LOG_REWRITTEN null"]);
  replaced.resize(B, 150n);
  assert.ok(kinds(replaced.verifyAgainstLog()).includes("LOG_REWRITTEN null"), "sticky");
  // A replay of the rewritten log alone disagrees with the tree it did not build.
  assert.deepEqual(kinds(replaced.verifyAgainstLog({ fromScratch: true })), [`UNLOGGED_WRITE ${B}`]);

  // Removed.
  const truncated = await built();
  (truncated.events as AllowanceEvent[]).pop();
  // The replica already replayed the removed event (so the tree still matches
  // it); the log is now shorter than what was replayed, and than the counter.
  assert.deepEqual(kinds(truncated.verifyAgainstLog()), ["LOG_REWRITTEN null", "LOG_REWRITTEN null"]);
  // A replay of what is left does not explain b's spend.
  assert.deepEqual(kinds(truncated.verifyAgainstLog({ fromScratch: true })), ["LOG_REWRITTEN null", `UNLOGGED_WRITE ${B}`]);

  // Appended without recordEvent (the sequence counter never moved).
  const smuggled = await built();
  const next = smuggled.nextSeq;
  (smuggled.events as AllowanceEvent[]).push({
    seq: next,
    type: "RESIZE",
    node: B,
    detail: "",
    result: "OK",
    amount: 150n,
    merchant: null,
    before: 200n,
  });
  assert.deepEqual(kinds(smuggled.verifyAgainstLog()), ["LOG_REWRITTEN null", `UNLOGGED_WRITE ${B}`]);
});

test("events the tree never records do not replay: BAD_EVENT, and DelegationTree.replay throws", async () => {
  const bad: [string, Omit<AllowanceEvent, "seq">][] = [
    ["a RESIZE without its before-budget", { type: "RESIZE", node: B, detail: "", result: "OK", amount: 150n, merchant: null }],
    ["a DELEGATE without its grant", { type: "DELEGATE", node: `x.${B}`, detail: "", result: "OK", amount: 1n, merchant: null }],
    [
      "a DELEGATE under a missing parent",
      {
        type: "DELEGATE",
        node: "x.nowhere.eth",
        detail: "",
        result: "OK",
        amount: 1n,
        merchant: null,
        grant: { parent: "nowhere.eth", identityStatus: "verified", expiry: FAR },
      },
    ],
    [
      "a DELEGATE whose name is not its parent's child",
      {
        type: "DELEGATE",
        node: "x.fund.eth",
        detail: "",
        result: "OK",
        amount: 1n,
        merchant: null,
        grant: { parent: POD, identityStatus: "verified", expiry: FAR },
      },
    ],
    [
      "a second FUND",
      {
        type: "FUND",
        node: "other.eth",
        detail: "",
        result: "OK",
        amount: 1n,
        merchant: null,
        grant: { parent: null, identityStatus: "verified", expiry: FAR, principal: { name: "q", verified: true } },
      },
    ],
    ["a SETTLED payment by an unknown node", { type: "PAYMENT", node: "nobody.eth", detail: "", result: "SETTLED", amount: 1n, merchant: "X" }],
    ["a REVOKE logged as OK", { type: "REVOKE", node: B, detail: "", result: "OK", amount: null, merchant: null }],
  ];
  for (const [label, event] of bad) {
    const tree = await built();
    tree.recordEvent(event);
    const d = tree.verifyAgainstLog();
    assert.equal(d[0]?.kind, "BAD_EVENT", label);
    assert.equal(d[0]!.seq, tree.nextSeq - 1, label);
    assert.throws(
      () => DelegationTree.replay(tree.events),
      (err: unknown) => err instanceof ReplayError && err.discrepancies[0]!.kind === "BAD_EVENT",
      label,
    );
  }

  // Out of order.
  const tree = await built();
  const swapped = [...tree.events];
  [swapped[3], swapped[4]] = [swapped[4]!, swapped[3]!];
  assert.throws(() => DelegationTree.replay(swapped), (err: unknown) => err instanceof ReplayError && /out of sequence/.test(err.message));

  // What the rest of the codebase records by hand replays as a no-op: a
  // delegation rejected before anything was created (adapters' delegateAll).
  const ok = await built();
  ok.recordEvent({ type: "DELEGATE", node: `x.${B}`, detail: "rejected", result: "ATTENUATION_REJECTED", amount: 1n, merchant: null });
  assertReplays(ok, "custom rejection");
});

test("the division of labour: the replay proves the log explains the tree, audit() that the tree is sound", async () => {
  // A write logged by hand through recordEvent is part of the history (the
  // log is not authenticated), so the replay agrees; a grow the API would
  // have refused still breaks the reservation, and audit() names it.
  const tree = await built();
  tree.requireNode(B).mandate.budget = 900n;
  tree.recordEvent({ type: "RESIZE", node: B, detail: "by hand", result: "OK", amount: 900n, merchant: null, before: 200n });
  assert.deepEqual(tree.verifyAgainstLog(), []);
  assert.deepEqual(tree.audit().map((v) => `${v.kind} ${v.node}`), [`OVER_COMMITTED ${POD}`]);
});

/* ------------------------------------------------------------------ */
/* Property: random operation sequences                               */
/* ------------------------------------------------------------------ */

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MERCHANTS = ["X", "Y", "Z"];

/** One random API call (any outcome: refusals, blocked payments, overspends). */
async function randomOp(tree: DelegationTree, r: () => number, step: number): Promise<string> {
  const nodes = tree.listNodes();
  const pick = () => nodes[Math.floor(r() * nodes.length)]!;
  const amount = (n: AgentNode) => BigInt(Math.floor(r() * Number(n.mandate.budget + 10n)));
  const merchants = () => MERCHANTS.filter(() => r() < 0.6);
  const op = Math.floor(r() * 8);
  const n = pick();
  const tolerate = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      if (!(e instanceof AttenuationError)) throw e;
    }
  };
  switch (op) {
    case 0:
    case 1:
      tolerate(() =>
        tree.delegate(n.name, `n${step}`, {
          budget: BigInt(Math.floor(r() * Number(tree.available(n.name) + 20n))),
          allowedMerchants: r() < 0.2 ? undefined : merchants(),
          allowedPurposes: r() < 0.5 ? undefined : ["p"],
          expiry: n.mandate.expiry - Math.floor(r() * 3),
        }, { identityStatus: r() < 0.9 ? "verified" : "expired" }),
      );
      return `delegate under ${n.name}`;
    case 2:
    case 3:
      tolerate(() => tree.resize(n.name, amount(n)));
      return `resize ${n.name}`;
    case 4:
      tree.close(n.name);
      return `close ${n.name}`;
    case 5:
      if (r() < 0.3) tree.revoke(n.name);
      return `revoke ${n.name}`;
    case 6: {
      const adapters = [allowAll, allowAll, allowAll, denyIdentity, rejectScreening, failSettlement][Math.floor(r() * 6)]!;
      await pay(tree, { node: n.name, merchant: MERCHANTS[Math.floor(r() * 3)]!, amount: amount(n), purpose: r() < 0.3 ? "p" : undefined }, adapters, {
        now: r() < 0.95 ? NOW : FAR + 10,
      });
      return `pay from ${n.name}`;
    }
    default: {
      const a = tree.available(n.name);
      await Promise.all([
        pay(tree, { node: n.name, merchant: "X", amount: a }, slow, { now: NOW }),
        pay(tree, { node: n.name, merchant: "X", amount: a }, slow, { now: NOW }),
      ]);
      return `concurrent pays from ${n.name}`;
    }
  }
}

/** A direct write to one field of one node that changes its value. */
function randomWrite(tree: DelegationTree, r: () => number): string {
  const nodes = tree.listNodes();
  const n = nodes[Math.floor(r() * nodes.length)]!;
  const m = n.mandate;
  switch (Math.floor(r() * 7)) {
    case 0:
      m.budget += 1n + BigInt(Math.floor(r() * 50));
      return `budget up ${n.name}`;
    case 1:
      m.budget -= 1n + BigInt(Math.floor(r() * 50));
      return `budget down ${n.name}`;
    case 2:
      m.spentDirect = m.spentDirect === 0n ? 3n : 0n;
      return `spent ${n.name}`;
    case 3:
      m.revoked = !m.revoked;
      return `revoked ${n.name}`;
    case 4:
      m.allowedMerchants = m.allowedMerchants === undefined ? ["X"] : [...m.allowedMerchants, "W"];
      return `merchants ${n.name}`;
    case 5:
      m.expiry -= 1;
      return `expiry ${n.name}`;
    default:
      n.identityStatus = n.identityStatus === "verified" ? "none" : "verified";
      return `identity ${n.name}`;
  }
}

test("property: over random operation sequences the replay is exact after every operation", async () => {
  let ops = 0;
  const types = new Set<string>();
  for (let seed = 1; seed <= 60; seed++) {
    const r = rng(seed);
    const tree = new DelegationTree();
    tree.fundRoot({ principal: "p", rootName: "r.eth", mandate: { budget: 1_000n, allowedMerchants: MERCHANTS, allowedPurposes: r() < 0.5 ? undefined : ["p"], expiry: FAR } });
    for (let step = 0; step < 40; step++) {
      const what = await randomOp(tree, r, step);
      ops++;
      // The incremental check every step; a full rebuild compared field by
      // field (snapshot, nodes, children) every few.
      assert.deepEqual(tree.verifyAgainstLog(), [], `seed ${seed} step ${step}: ${what}`);
      if (step % 5 === 4) assertReplays(tree, `seed ${seed} step ${step}: ${what}`);
    }
    assertReplays(tree, `seed ${seed} end`);
    for (const e of tree.events) types.add(`${e.type}/${e.result}`);
  }
  assert.equal(ops, 60 * 40);
  // The sequences reached every kind of event the tree records.
  for (const t of [
    "FUND/OK",
    "DELEGATE/OK",
    "DELEGATE/ATTENUATION_REJECTED",
    "RESIZE/OK",
    "RESIZE/ATTENUATION_REJECTED",
    "REVOKE/REVOKED",
    "PAYMENT/SETTLED",
    "PAYMENT/REVOKED",
    "PAYMENT/BLOCKED_MANDATE",
    "PAYMENT/BLOCKED_SCREENING",
    "PAYMENT/DENIED_IDENTITY",
  ]) {
    assert.ok(types.has(t), `never produced ${t}`);
  }
});

test("property: any direct write is caught at the next check, and the incremental check always agrees with a whole-log replay", async () => {
  let caught = 0;
  for (let seed = 101; seed <= 180; seed++) {
    const r = rng(seed);
    const tree = new DelegationTree();
    tree.fundRoot({ principal: "p", rootName: "r.eth", mandate: { budget: 1_000n, allowedMerchants: MERCHANTS, expiry: FAR } });
    const tamperAt = 5 + Math.floor(r() * 20);
    for (let step = 0; step < 35; step++) {
      await randomOp(tree, r, step);
      if (step === tamperAt) {
        const what = randomWrite(tree, r);
        const found = tree.verifyAgainstLog();
        assert.ok(found.some((d) => d.kind === "UNLOGGED_WRITE"), `seed ${seed}: ${what} was not caught`);
        caught++;
      }
      // Before and after the write, with API calls on top of it.
      assert.deepEqual(tree.verifyAgainstLog(), tree.verifyAgainstLog({ fromScratch: true }), `seed ${seed} step ${step}`);
    }
  }
  assert.equal(caught, 80);
});
