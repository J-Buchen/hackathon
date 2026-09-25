import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DelegationTree,
  childName,
  parentNameOf,
  leftLabel,
} from "./tree";
import { AttenuationError } from "./attenuation";

const FAR = 4_000_000_000;

function seed(): DelegationTree {
  const tree = new DelegationTree();
  tree.fundRoot({
    principal: "alice",
    rootName: "alice.eth",
    mandate: { budget: 100_000000n, expiry: FAR },
  });
  return tree;
}

test("name helpers", () => {
  assert.equal(leftLabel("scraper.researcher.alice.eth"), "scraper");
  assert.equal(parentNameOf("scraper.researcher.alice.eth"), "researcher.alice.eth");
  assert.equal(parentNameOf("eth"), null);
  assert.equal(childName("alice.eth", "researcher"), "researcher.alice.eth");
});

test("delegation reserves budget and reduces parent available", () => {
  const tree = seed();
  assert.equal(tree.available("alice.eth"), 100_000000n);

  tree.delegate("alice.eth", "researcher", {
    budget: 30_000000n,
    allowedMerchants: ["arxiv", "openai"],
    expiry: FAR,
  });

  assert.equal(tree.reserved("alice.eth"), 30_000000n);
  assert.equal(tree.available("alice.eth"), 70_000000n);
  assert.equal(tree.available("researcher.alice.eth"), 30_000000n);
});

test("nested delegation and ancestor walk", () => {
  const tree = seed();
  tree.delegate("alice.eth", "researcher", {
    budget: 30_000000n,
    allowedMerchants: ["arxiv", "openai"],
    expiry: FAR,
  });
  tree.delegate("researcher.alice.eth", "scraper", {
    budget: 10_000000n,
    allowedMerchants: ["arxiv"],
    expiry: FAR,
  });

  const ancestors = tree.ancestors("scraper.researcher.alice.eth").map((a) => a.name);
  assert.deepEqual(ancestors, ["researcher.alice.eth", "alice.eth"]);
  assert.equal(tree.available("researcher.alice.eth"), 20_000000n);
});

test("over-budget delegation throws AttenuationError and logs a rejection event", () => {
  const tree = seed();
  tree.delegate("alice.eth", "researcher", {
    budget: 30_000000n,
    allowedMerchants: ["arxiv", "openai"],
    expiry: FAR,
  });

  assert.throws(
    () =>
      tree.delegate("researcher.alice.eth", "greedy", {
        budget: 999_000000n,
        allowedMerchants: ["arxiv"],
        expiry: FAR,
      }),
    (err: unknown) =>
      err instanceof AttenuationError && err.reason === "BUDGET_EXCEEDS_AVAILABLE",
  );

  const last = tree.events[tree.events.length - 1];
  assert.equal(last?.result, "ATTENUATION_REJECTED");
});

test("revoke marks the chain as revoked for descendants", () => {
  const tree = seed();
  tree.delegate("alice.eth", "researcher", { budget: 30_000000n, expiry: FAR });
  tree.delegate("researcher.alice.eth", "scraper", { budget: 10_000000n, expiry: FAR });

  assert.equal(tree.isRevokedInChain("scraper.researcher.alice.eth"), false);
  tree.revoke("researcher.alice.eth");
  assert.equal(tree.isRevokedInChain("researcher.alice.eth"), true);
  assert.equal(tree.isRevokedInChain("scraper.researcher.alice.eth"), true);
});

test("expiry-in-chain detection", () => {
  const tree = new DelegationTree();
  tree.fundRoot({ principal: "alice", rootName: "alice.eth", mandate: { budget: 100_000000n, expiry: 2000 } });
  tree.delegate("alice.eth", "researcher", { budget: 10_000000n, expiry: 1500 });

  assert.equal(tree.isExpiredInChain("researcher.alice.eth", 1000), false);
  assert.equal(tree.isExpiredInChain("researcher.alice.eth", 1600), true); // child expired
  assert.equal(tree.isExpiredInChain("alice.eth", 2500), true); // root expired
});

/* ---------------------------------------------------------------- */
/* resize — the allocator's lever                                   */
/* ---------------------------------------------------------------- */

test("resize shrink frees parent available and records RESIZE/OK", () => {
  const tree = seed();
  tree.delegate("alice.eth", "pod", { budget: 40_000000n, expiry: FAR });
  tree.resize("pod.alice.eth", 10_000000n);
  assert.equal(tree.requireNode("pod.alice.eth").mandate.budget, 10_000000n);
  assert.equal(tree.available("alice.eth"), 90_000000n);
  const last = tree.events.at(-1)!;
  assert.equal(last.type, "RESIZE");
  assert.equal(last.result, "OK");
});

test("resize grow draws from parent available, and is capped by it", () => {
  const tree = seed();
  tree.delegate("alice.eth", "pod", { budget: 40_000000n, expiry: FAR });
  tree.resize("pod.alice.eth", 100_000000n); // +60 = exactly root's available
  assert.equal(tree.available("alice.eth"), 0n);
  assert.throws(
    () => tree.resize("pod.alice.eth", 100_000001n),
    (e: unknown) => e instanceof AttenuationError && e.reason === "BUDGET_EXCEEDS_AVAILABLE",
  );
  assert.equal(tree.events.at(-1)!.result, "ATTENUATION_REJECTED");
});

test("resize cannot cut below what a node already delegated or spent", () => {
  const tree = seed();
  tree.delegate("alice.eth", "pod", { budget: 40_000000n, expiry: FAR });
  tree.delegate("pod.alice.eth", "agent", { budget: 25_000000n, expiry: FAR });
  assert.throws(
    () => tree.resize("pod.alice.eth", 24_000000n),
    (e: unknown) => e instanceof AttenuationError && e.reason === "BELOW_COMMITTED",
  );
  tree.resize("pod.alice.eth", 25_000000n); // exactly committed is fine
  assert.equal(tree.available("pod.alice.eth"), 0n);
});

test("resize: root can only shrink; revoked subtrees cannot be resized", () => {
  const tree = seed();
  assert.throws(() => tree.resize("alice.eth", 101_000000n), AttenuationError);
  tree.resize("alice.eth", 50_000000n);
  tree.delegate("alice.eth", "pod", { budget: 10_000000n, expiry: FAR });
  tree.delegate("pod.alice.eth", "agent", { budget: 5_000000n, expiry: FAR });
  tree.revoke("pod.alice.eth");
  assert.throws(
    () => tree.resize("agent.pod.alice.eth", 1_000000n),
    (e: unknown) => e instanceof AttenuationError && e.reason === "PARENT_REVOKED",
  );
});
