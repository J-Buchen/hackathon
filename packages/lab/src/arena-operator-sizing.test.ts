/**
 * (G) Operator sizing on randomized arena worlds, crowding included. The
 * arena gives an operator at most two names, so every world on research seeds
 * 1–40 is regrouped here: its roster is split into operators of 1–5 names
 * (drawn from the seed). Each world is run with those labels and blind (labels
 * stripped), and checked tick by tick for every live name:
 *
 *  - the band: min(own size, cutFactor × full size) ≤ capital ≤ own size,
 *    where the own size is what its own rules give it (`AgentResult.ownSize`):
 *    the allocator's target under the band, its own ladder's cuts and the
 *    crowding cuts. Crowding cuts are solved on what names actually hold, so
 *    here the own size is the book's own record, not the blind book's budget
 *    (that exact comparison is made on crowding-free books in swarm's
 *    operator-sizing.test.ts);
 *  - no operator event moves an own size: across a tick where the name's only
 *    move was a cap or a lift, its own size is unchanged, and across a tick
 *    where its own ladder cut it (and nothing else moved it), its own size
 *    fell by exactly cutFactor;
 *  - the cap binds: from the tick after a cap until it lifts, capital ≤
 *    cutFactor × full size;
 *  - dormant until the first credit event: until then, the two runs hold the
 *    same capital and own sizes;
 *  - no one's ladder moves: every CUT, RESTORE and STOP_OUT is the same with
 *    and without labels.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultCenterBookPolicy, mulberry32, runBook, type BookResult, type SwarmSpec } from "@allowance/swarm";
import { makeWorld } from "./arena";

// Research seeds only (< ARENA_EVAL_FLOOR).
const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1);
const policy = defaultCenterBookPolicy();
const CF = policy.cutFactor!;
const isReallocation = (t: number) => t >= policy.warmup && (t - policy.warmup) % policy.rebalanceEvery === 0;

/** Split the roster into operators of 1–5 names, drawn from the seed. */
function regroup(spec: SwarmSpec, seed: number): number[] {
  const u = mulberry32(seed * 104_729 + 13);
  const order = spec.agents.map((_, i) => ({ i, k: u() })).sort((a, b) => a.k - b.k).map((x) => x.i);
  const sizes: number[] = [];
  for (let at = 0; at < order.length; ) {
    const k = Math.min(1 + Math.floor(u() * 5), order.length - at);
    for (let j = 0; j < k; j++) spec.agents[order[at + j]!]!.operator = `grp-${sizes.length}`;
    sizes.push(k);
    at += k;
  }
  return sizes;
}

const ladderMoves = (b: BookResult) =>
  b.decisions.filter((d) => d.kind === "CUT" || d.kind === "RESTORE" || d.kind === "STOP_OUT").map((d) => `${d.t} ${d.kind} ${d.node}`);

test("arena, operators of 1–5 names: min(own, one cap) ≤ capital ≤ own every tick, and no operator event moves an own size", async () => {
  const seen = { worlds: 0, bySize: [0, 0, 0, 0, 0, 0], caps: 0, recaps: 0, binding: 0, heldCrowdCuts: 0, heldLadderCuts: 0, capOnlyTicks: 0, ticks: 0 };
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    const labelled = world.swarm();
    for (const k of regroup(labelled, seed)) seen.bySize[k]!++;
    const blindSpec = world.swarm();
    for (const a of blindSpec.agents) delete a.operator;
    const lab = await runBook(world.market, labelled, policy);
    const blind = await runBook(world.market, blindSpec, policy);
    seen.worlds++;
    assert.deepEqual(ladderMoves(lab), ladderMoves(blind), `seed ${seed}: the labels move no ladder`);
    assert.deepEqual(lab.tree.audit(), []);

    const log = lab.decisions;
    const firstCap = log.find((d) => d.kind === "OPERATOR_CUT")?.t ?? Infinity;
    const at = (kind: string, node: string, t: number) => log.some((d) => d.kind === kind && d.t === t && d.node.split(", ").includes(node));
    for (const a of lab.agents) {
      const b = blind.agents.find((x) => x.name === a.name)!;
      const caps = log.filter((d) => d.kind === "OPERATOR_CUT" && d.node === a.name);
      seen.caps += caps.length;
      seen.recaps += Math.max(0, caps.length - 1);
      for (let t = 0; t < a.capital.length; t++) {
        const own = a.ownSize[t]!;
        const got = a.capital[t]!;
        if (own === 0 && got === 0) continue;
        seen.ticks++;
        const oneCap = CF * a.fullSize[t]!;
        assert.ok(got <= own + 1e-6, `seed ${seed} ${a.label} t=${t}: capital ${got} above its own size ${own}`);
        assert.ok(got >= Math.min(own, oneCap) - 1e-6, `seed ${seed} ${a.label} t=${t}: capital ${got} below min(own ${own}, one cap ${oneCap})`);
        if (got < own - 1e-6) seen.binding++;
        if (t <= firstCap) {
          assert.equal(got, b.capital[t], `seed ${seed} ${a.label} t=${t}: dormant until the first credit event`);
          assert.equal(own, b.capital[t], `seed ${seed} ${a.label} t=${t}: own size before any cap`);
        }
        if (t === 0) continue;
        // What moved the own size between the trades of t − 1 and t: tick
        // t − 1's ladder (a cut or a stop) and operator step, then tick t's
        // reallocation and crowding check.
        const prev = a.ownSize[t - 1]!;
        const cut = at("CUT", a.name, t - 1);
        const ownRules = cut || isReallocation(t) || at("CROWDING_CUT", a.name, t);
        if (!ownRules) {
          assert.equal(own, prev, `seed ${seed} ${a.label} t=${t}: own size moved with no own rule acting (${prev} → ${own})`);
          if (at("OPERATOR_CUT", a.name, t - 1) || at("OPERATOR_RESTORE", a.name, t - 1)) seen.capOnlyTicks++;
        } else if (cut && !isReallocation(t) && !at("CROWDING_CUT", a.name, t)) {
          assert.ok(Math.abs(own - CF * prev) <= 1e-6, `seed ${seed} ${a.label} t=${t}: its ladder cut its own size ${prev} → ${own}`);
          if (got < prev - 1e-6 && a.capital[t - 1]! < prev - 1e-6) seen.heldLadderCuts++;
        }
        if (at("CROWDING_CUT", a.name, t) && a.capital[t - 1]! < a.ownSize[t - 1]! - 1e-6) seen.heldCrowdCuts++;
      }
      // The cap binds from the tick after it is set until it lifts.
      for (const cap of caps) {
        const lift = log.find((d) => d.kind === "OPERATOR_RESTORE" && d.node === a.name && d.t > cap.t)?.t ?? a.capital.length - 1;
        for (let t = cap.t + 1; t <= lift && t < a.capital.length; t++) {
          if (a.capital[t] === 0 && a.ownSize[t] === 0) break;
          assert.ok(a.capital[t]! <= CF * a.fullSize[t]! + 1e-6, `seed ${seed} ${a.label} t=${t}: ${a.capital[t]} above the cap ${CF * a.fullSize[t]!}`);
        }
      }
    }
  }
  for (let k = 1; k <= 5; k++) assert.ok(seen.bySize[k]! >= 10, `operators with ${k} names: ${JSON.stringify(seen)}`);
  for (const key of ["caps", "recaps", "binding", "heldCrowdCuts", "heldLadderCuts", "capOnlyTicks"] as const) {
    assert.ok(seen[key] >= 5, `${key}: ${JSON.stringify(seen)}`);
  }
});
