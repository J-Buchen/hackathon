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
