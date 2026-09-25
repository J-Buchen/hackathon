/**
 * AgentHire adapter tests — offline, against a fake fetch that mimics the
 * AgentHire routes (shapes taken from agenthire @ ab317f2 and a keyless run).
 * Run: `npm -w @allowance/adapters test`.
 */

import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Wallet, verifyTypedData } from "ethers";
import type { PaymentAdapters, SettlementRequest } from "@allowance/core";
import { AttenuationError, DelegationTree, pay } from "@allowance/core";

import {
  AGENTHIRE_CHAIN_ID,
  AgentHireClient,
  AgentHireError,
  AgentHireScreeningService,
  AgentHireSettlementService,
  IncidentLedger,
  JsonFileIncidentStore,
  MockIdentityGate,
  MockScreeningService,
  OperatorRegistry,
  OverspendWatch,
  QuoteBook,
  SerializedPayer,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  agentHireMerchant,
  agentHireMicroOf,
  agentHireTreeHooks,
  aliasNodeLabel,
  aliasPayerAgentId,
  delegateAll,
  encodeUsdcParam,
  mockUsdcDomain,
  parseAliasLabel,
  permitMessage,
  payerSignerFromEnv,
  planHire,
  recoverPermitSigner,
  quoteMicro,
  settleModeFromEnv,
  usdcToMicro,
  type FetchLike,
  type X402Challenge,
  type X402Permit,
} from "./index";

/* ------------------------------------------------------------------ */
/* Fake AgentHire                                                     */
/* ------------------------------------------------------------------ */

const USDC = "0x9C49D730Dfb82B7663aBE6069B5bFe867fa34c9f";
const ESCROW = "0xD19990C7CB8C386fa865135Ce9706A5A37A3f2f2";
const OTHER = "0x6B71b84Fa3C313ccC43D63A400Ab47e6A0d4BCbB";
const CRAWLTECH = "0x1ce3b4044124714daa6a68b95441963679eea6ec";
const SHARED_OPERATOR = "0xa34a8dcb86249dac8d611cfdd0713e672ba72143";
const SERVER_NOW = 1_790_000_000;
const FAR = 4_000_000_000;

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
}

interface Profile {
  score: number;
  tier: number;
  incidentCount: number;
  stakeIncidents: number;
  banned: boolean;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function html429(): Response {
  return new Response("<!doctype html><title>429 Too Many Requests</title><h1>Too Many Requests</h1>", {
    status: 429,
    headers: { "content-type": "text/html; charset=utf-8", "retry-after": "60" },
  });
}

/** An in-memory stand-in for the AgentHire routes Allowance uses. */
class FakeAgentHire {
  calls: Call[] = [];
  chainId = AGENTHIRE_CHAIN_ID;
  agents = new Map<number, { id: number; name: string; deployer_wallet: string; use_case: string; current_price: number }>([
    [5, { id: 5, name: "WebCrawler X", deployer_wallet: CRAWLTECH, use_case: "Web Scraping", current_price: 0.03 }],
    [7, { id: 7, name: "SecureAudit AI", deployer_wallet: "0xf5aff70e7d78473ea14f7110af047fd144f638e4", use_case: "Security", current_price: 0.2 }],
    [15, { id: 15, name: "TestSmith", deployer_wallet: SHARED_OPERATOR, use_case: "Testing", current_price: 0.1 }],
    [27, { id: 27, name: "StackTracer", deployer_wallet: SHARED_OPERATOR, use_case: "Debugging", current_price: 0.1 }],
    [1, { id: 1, name: "CodeReview Pro", deployer_wallet: "0x3a50cd20f4ef2c19f7616d2b81d9de784ea0d4fa", use_case: "Code Review", current_price: 0.4 }],
  ]);
  profiles = new Map<number, Profile>();
  /** Mutates each challenge before it is served (to simulate a hostile or buggy server). */
  tamper: ((ch: X402Challenge) => void) | null = null;
  /** Return a Response to short-circuit a route (e.g. an HTML 429). */
  override: ((call: Call) => Response | undefined) | null = null;
  eventId = 100;
  tick = 5;
  /** currentPrice per agent (USDC); every other agent quotes 0.05244. */
  prices = new Map<number, number>();

  profile(id: number): Profile {
    let p = this.profiles.get(id);
    if (!p) {
      p = { score: 510, tier: 1, incidentCount: 0, stakeIncidents: 0, banned: false };
      this.profiles.set(id, p);
    }
    return p;
  }

  callsTo(prefix: string): Call[] {
    return this.calls.filter((c) => c.path.startsWith(prefix));
  }

  readonly fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k.toLowerCase()] = v;
    const call: Call = {
      method: init?.method ?? "GET",
      path: u.pathname,
      query: u.searchParams,
      headers,
      body: init?.body ? JSON.parse(init.body) : undefined,
    };
    this.calls.push(call);
    const forced = this.override?.(call);
    if (forced) return forced;
    return this.route(call);
  };

  private route(call: Call): Response {
    const { path } = call;
    let m: RegExpExecArray | null;
    if (path === "/api/onchain/info") {
      return json({
        chainId: this.chainId,
        chainIdHex: "0xa869",
        chain: "Avalanche Fuji",
        contracts: { MockUSDC: USDC, EscrowPayment: ESCROW, AgentRegistry: OTHER },
      });
    }
    if ((m = /^\/api\/agents\/(\d+)$/.exec(path))) {
      const a = this.agents.get(Number(m[1]));
      return a ? json(a) : json({ error: "agent not found" }, 404);
    }
    if ((m = /^\/api\/pricing\/quote\/(\d+)$/.exec(path))) {
      return json({
        agentId: Number(m[1]),
        currentPrice: this.prices.get(Number(m[1])) ?? 0.05244,
        demand: 0.716,
        maxPrice: 0.12,
        minPrice: 0.03,
        surgeActive: true,
        surgeMultiplier: 1.748,
        utilization: 0.666,
      });
    }
    if ((m = /^\/api\/agents\/(\d+)\/reputation$/.exec(path))) {
      const p = this.profile(Number(m[1]));
      return json({ score: p.score, tier: p.tier, tasksCompleted: 1540, incidentCount: p.incidentCount, simulated: true });
    }
    if ((m = /^\/api\/agents\/(\d+)\/stake$/.exec(path))) {
      const p = this.profile(Number(m[1]));
      return json({ stakedUSDC: "150000000", incidentCount: p.stakeIncidents, banned: p.banned, simulated: true });
    }
    if ((m = /^\/api\/x402\/demo-execute\/(\d+)$/.exec(path))) {
      const agentId = Number(m[1]);
      const amountUSDC = Number(call.query.get("amountUSDC"));
      if (call.headers["x-payment"]) {
        const permit = JSON.parse(call.headers["x-payment"]) as X402Permit;
        const receipt = { sessionId: null, txHashes: { permit: "0x" + "ab".repeat(32) }, snowtrace: null };
        return json({ ok: true, agentId, x402Receipt: receipt, from: permit.from }, 200, {
          "X-Payment-Receipt": JSON.stringify(receipt),
        });
      }
      const micro = Number(agentHireMicroOf(amountUSDC)); // AgentHire's int(float * 1e6)
      const challenge: X402Challenge = {
        scheme: "x402/eip-3009",
        version: "1",
        resourceId: `agent-${agentId}-execute`,
        chain: { chainId: this.chainId, name: "Avalanche Fuji" },
        token: { address: USDC, symbol: "USDC", decimals: 6 },
        price: { amountUSDC, amountMicro: micro, perCall: true },
        recipient: ESCROW,
        permit: {
          type: "EIP-3009/transferWithAuthorization",
          domain: { name: "Mock USDC", version: "1", chainId: this.chainId, verifyingContract: USDC },
          template: {
            from: "<buyer-address>",
            to: ESCROW,
            value: String(micro),
            validAfter: 0,
            validBefore: SERVER_NOW + 3600,
            nonce: "0x" + "00".repeat(31) + "01",
          },
        },
      };
      this.tamper?.(challenge);
      return json({ error: "Payment required", scheme: "x402/eip-3009", challenge }, 402);
    }
    if (path === "/api/x402/pay") {
      const body = call.body as Record<string, unknown>;
      return json({ sessionId: "a1b2c3d4", agentId: body.agentId, status: "mock", realTx: false, note: "No FACILITATOR_URL" });
    }
    if (path === "/api/sim/trigger-direct") {
      const body = call.body as { fromId: number; toId: number; amountUSDC: string; reason?: string };
      const amount = Number(body.amountUSDC);
      const hireId = ++this.eventId;
      const settleId = ++this.eventId;
      return json({
        triggered: true,
        ok: true,
        fromId: body.fromId,
        toId: body.toId,
        amountUSDC: amount,
        count: 2,
        realTxHash: null,
        newEvents: [
          { id: hireId, ts: 1, kind: "a2a_hire", agentId: body.fromId, message: "hire", amountUSDC: Math.round(amount * 1e4) / 1e4, meta: { subAgentId: body.toId, trigger: body.reason, direct: true } },
          { id: settleId, ts: 1, kind: "a2a_settle", agentId: body.toId, message: "settle", amountUSDC: Math.round(amount * 1e4) / 1e4, meta: { direct: true } },
        ],
      });
    }
    if (path === "/api/dispute/submit") {
      return json({ status: "pending_review", note: "No GATEKEEPER_URL and no GATEKEEPER_PRIVATE_KEY - dispute logged but no on-chain incident was signed." });
    }
    if (path === "/api/sim/status") {
      return json({ running: true, tickRealSeconds: this.tick, tickCount: 38 });
    }
    if (path === "/api/sim/speed") {
      this.tick = Number((call.body as { tickRealSeconds: number }).tickRealSeconds);
      return json({ running: true, tickRealSeconds: this.tick });
    }
    if (path === "/api/sim/a2a-candidates") {
      return json({ flagships: [{ id: 3, name: "DataSift Analytics", subAgents: [{ id: 5, name: "WebCrawler X", estCostHigh: 0.06 }] }] });
    }
    if (path === "/api/sim/events") {
      return json({ events: [{ id: 3, ts: 1, kind: "a2a_hire", agentId: 1, message: "CodeReview Pro → SecureAudit AI", amountUSDC: 0.42, meta: { subAgentId: 7 } }], status: { running: true } });
    }
    return json({ error: "not found" }, 404);
  }
}

function settlementFor(
  fake: FakeAgentHire,
  opts: { expiry?: number; mode?: "mock" | "fuji"; payerAgentIdOf?: (node: string) => number | undefined; nextSeq?: () => number } = {},
) {
  const signer = Wallet.createRandom();
  const client = new AgentHireClient("http://127.0.0.1:5055/", fake.fetch);
  const svc = new AgentHireSettlementService({
    client,
    signer,
    mandateExpiry: () => opts.expiry ?? FAR,
    mode: opts.mode ?? "mock",
    now: () => SERVER_NOW,
    ...(opts.payerAgentIdOf ? { payerAgentIdOf: opts.payerAgentIdOf } : {}),
    ...(opts.nextSeq ? { nextSeq: opts.nextSeq } : {}),
  });
  return { signer, client, svc };
}

function req(amount: bigint, over: Partial<SettlementRequest> = {}): SettlementRequest {
  return { node: "scraper.pm.fund.eth", merchant: agentHireMerchant(5), amount, payerToken: "USDC", merchantToken: "USDC", ...over };
}

function assertRecovers(permit: X402Permit, signerAddress: string): void {
  const recovered = verifyTypedData(
    mockUsdcDomain(USDC, AGENTHIRE_CHAIN_ID),
    TRANSFER_WITH_AUTHORIZATION_TYPES,
    permitMessage(permit),
    { r: permit.r, s: permit.s, v: permit.v },
  );
  assert.equal(recovered, signerAddress);
}

/* ------------------------------------------------------------------ */
/* Money                                                              */
/* ------------------------------------------------------------------ */

test("encodeUsdcParam survives AgentHire's truncating int(float * 1e6)", () => {
  // Plain decimals truncate one micro low for ~1.2% of amounts, e.g. 0.000249 -> 248.
  assert.equal(agentHireMicroOf("0.000249"), 248n);
  assert.equal(agentHireMicroOf(encodeUsdcParam(249n)), 249n);
  assert.equal(encodeUsdcParam(290_000n), "0.29");
  assert.equal(encodeUsdcParam(5_000000n), "5");
  for (let m = 1n; m <= 30_000n; m++) assert.equal(agentHireMicroOf(encodeUsdcParam(m)), m, `micro ${m}`);
  for (const m of [123_456_789n, 999_999_999n, 1_000_000_000_001n]) assert.equal(agentHireMicroOf(encodeUsdcParam(m)), m);
});

test("quotes convert to micro-USDC exactly", async () => {
  const fake = new FakeAgentHire();
  const client = new AgentHireClient("http://127.0.0.1:5055", fake.fetch);
  const q = await client.quote(5);
  assert.equal(quoteMicro(q), 52_440n);
  assert.equal(usdcToMicro(0.12), 120_000n);
  assert.throws(() => usdcToMicro(-1));
});

/* ------------------------------------------------------------------ */
/* Client                                                             */
/* ------------------------------------------------------------------ */

test("client: an HTML 429 is an AgentHireError, never a value", async () => {
  const fake = new FakeAgentHire();
  fake.override = () => html429();
  const client = new AgentHireClient("http://127.0.0.1:5055", fake.fetch);
  await assert.rejects(client.quote(5), (e: unknown) => e instanceof AgentHireError && e.kind === "non_json" && e.status === 429);
  // Even a 200 must be JSON.
  fake.override = () => new Response("<html>ok</html>", { status: 200, headers: { "content-type": "text/html" } });
  await assert.rejects(client.reputation(5), (e: unknown) => e instanceof AgentHireError && e.kind === "non_json");
});

test("client: JSON errors, network errors and wrong shapes are typed errors", async () => {
  const fake = new FakeAgentHire();
  const client = new AgentHireClient("http://127.0.0.1:5055", fake.fetch);
  await assert.rejects(client.getAgent(404), (e: unknown) => e instanceof AgentHireError && e.kind === "http" && e.status === 404);
  const down = new AgentHireClient("http://127.0.0.1:5055", async () => {
    throw new Error("ECONNREFUSED");
  });
  await assert.rejects(down.onchainInfo(), (e: unknown) => e instanceof AgentHireError && e.kind === "network");
  fake.override = (c) => (c.path.endsWith("/stake") ? json({ banned: "no" }) : undefined);
  await assert.rejects(client.stake(5), (e: unknown) => e instanceof AgentHireError && e.kind === "shape");
  // A hung AgentHire times out instead of holding a payment queue forever.
  const hung = new AgentHireClient("http://127.0.0.1:5055", () => new Promise(() => {}), { timeoutMs: 20 });
  await assert.rejects(hung.quote(5), (e: unknown) => e instanceof AgentHireError && e.kind === "network" && /timed out/.test(e.message));
});

test("client: challenge route, trigger-direct encoding, sim events, disputes", async () => {
  const fake = new FakeAgentHire();
  const client = new AgentHireClient("http://127.0.0.1:5055", fake.fetch);
  const ch = await client.x402Challenge(5, 249n);
  assert.equal(fake.calls.at(-1)!.path, "/api/x402/demo-execute/5");
  assert.equal(BigInt(ch.price.amountMicro), 249n); // the nudged encoding decoded exactly

  const td = await client.triggerDirect({ fromId: 1, toId: 7, amountMicro: 251n, reason: "allowance:x#1" });
  const sent = fake.calls.at(-1)!.body as Record<string, unknown>;
  assert.equal(agentHireMicroOf(String(sent.amountUSDC)), 251n);
  assert.equal(td.newEvents[0]!.meta.trigger, "allowance:x#1");

  const page = await client.simEvents(2);
  assert.equal(fake.calls.at(-1)!.query.get("since"), "2");
  assert.equal(page.events[0]!.kind, "a2a_hire");

  const d = await client.submitDispute({ agentId: 5, severity: 1, reason: "r", affectedUser: OTHER });
  assert.equal(d.status, "pending_review");
});

/* ------------------------------------------------------------------ */
/* Settlement                                                         */
/* ------------------------------------------------------------------ */

test("settlement (mock): validates, signs EIP-3009 that recovers to the signer, pays /api/x402/pay", async () => {
  const fake = new FakeAgentHire();
  const { svc, signer } = settlementFor(fake);
  const r = await svc.settle(req(52_440n));
  assert.equal(r.settled, true, r.reason);
  assert.equal(r.amountIn, 52_440n);
  assert.equal(r.reference, "agenthire-x402-mock:a1b2c3d4");

  const payCall = fake.callsTo("/api/x402/pay")[0]!;
  const permit = payCall.body as X402Permit;
  assert.equal(permit.from, signer.address);
  assert.equal(permit.to, ESCROW);
  assert.equal(permit.value, "52440");
  assert.equal(permit.agentId, 5);
  assert.equal(permit.validBefore, SERVER_NOW + 3600);
  assert.notEqual(permit.nonce, "0x" + "00".repeat(31) + "01", "our own nonce, not the server template's");
  assert.match(permit.nonce, /^0x[0-9a-f]{64}$/);
  assertRecovers(permit, signer.address);
  assert.equal(recoverPermitSigner(permit, USDC), signer.address);
  assert.notEqual(recoverPermitSigner({ ...permit, value: "52441" }, USDC), signer.address);

  const receipt = svc.receipts.at(-1)!;
  assert.equal(receipt.settled, true);
  assert.equal(receipt.simulated, true);
  assert.equal(receipt.realTx, false);
  assert.equal(receipt.route, "x402-pay");
  assert.equal(receipt.amountMicro, "52440");
});

const mismatches: Array<[string, (ch: X402Challenge) => void, RegExp]> = [
  ["amount (server under/over-prices)", (ch) => { ch.price.amountMicro = 1; ch.permit.template.value = "1"; }, /amountMicro 1 != mandate-checked amount 52440/],
  ["amount (permit template only)", (ch) => { ch.permit.template.value = "5000000"; }, /permit value 5000000/],
  ["chain", (ch) => { ch.chain.chainId = 1; }, /chainId 1, expected 43113/],
  ["domain chain", (ch) => { ch.permit.domain.chainId = 43114; }, /domain chainId 43114/],
  ["token", (ch) => { ch.token.address = OTHER; }, /is not MockUSDC/],
  ["verifyingContract", (ch) => { ch.permit.domain.verifyingContract = OTHER; }, /verifyingContract .* is not MockUSDC/],
  ["recipient", (ch) => { ch.recipient = OTHER; }, /recipient .* is not EscrowPayment/],
  ["permit.to", (ch) => { ch.permit.template.to = OTHER; }, /permit\.to .* is not EscrowPayment/],
  ["expired validBefore", (ch) => { ch.permit.template.validBefore = SERVER_NOW - 1; }, /not in the future/],
  ["domain name", (ch) => { ch.permit.domain.name = "USD Coin"; }, /expected "Mock USDC"/],
];

for (const [label, tamper, why] of mismatches) {
  test(`settlement refuses a challenge with a mismatched ${label} (settled:false, nothing signed or paid)`, async () => {
    const fake = new FakeAgentHire();
    fake.tamper = tamper;
    const { svc } = settlementFor(fake);
    const r = await svc.settle(req(52_440n));
    assert.equal(r.settled, false);
    assert.match(r.reason!, /^settlement: challenge rejected: /);
    assert.match(r.reason!, why);
    assert.equal(r.amountIn, 0n);
    assert.equal(fake.callsTo("/api/x402/pay").length, 0);
    assert.equal(svc.receipts.at(-1)!.permit, undefined);
  });
}

test("settlement refuses a permit that would outlive the mandate", async () => {
  const fake = new FakeAgentHire();
  const { svc } = settlementFor(fake, { expiry: SERVER_NOW + 600 }); // challenge asks for +3600
  const r = await svc.settle(req(52_440n));
  assert.equal(r.settled, false);
  assert.match(r.reason!, /validBefore \d+ outlives the mandate \(expiry \d+\)/);
  const expired = settlementFor(new FakeAgentHire(), { expiry: SERVER_NOW - 1 }).svc;
  assert.match((await expired.settle(req(1n))).reason!, /^settlement: mandate of .* expired/);
  assert.equal(fake.callsTo("/api/x402/pay").length, 0);
});

test("settlement refuses a deployment on the wrong chain, non-USDC tokens, unknown merchants", async () => {
  const fake = new FakeAgentHire();
  fake.chainId = 1;
  const { svc } = settlementFor(fake);
  assert.match((await svc.settle(req(52_440n))).reason!, /^settlement: AgentHire deployment is on chain 1, expected 43113/);
  const ok = settlementFor(new FakeAgentHire()).svc;
  assert.match((await ok.settle(req(52_440n, { payerToken: "WETH" }))).reason!, /^settlement: AgentHire settles USDC only/);
  assert.match((await ok.settle(req(52_440n, { merchant: "openai" }))).reason!, /^settlement: merchant "openai" is not an AgentHire agent/);
  // Booked for the wrong agent: the signed permit already went out, so this is
  // charged as UNCONFIRMED (for reconciliation), not refused.
  const misbooked = new FakeAgentHire();
  misbooked.override = (c) => (c.path === "/api/x402/pay" ? json({ sessionId: "x", agentId: 6, status: "mock", realTx: false }) : undefined);
  const mis = settlementFor(misbooked).svc;
  const r = await mis.settle(req(52_440n));
  assert.equal(r.settled, true);
  assert.match(r.reason!, /^settlement: UNCONFIRMED .*AgentHire booked the payment for agent 6, not 5/);
  assert.equal(mis.receipts.at(-1)!.unconfirmed, true);
});

test("settlement: an HTML 429 is never a throw; before the permit is sent it is a refusal, after it is UNCONFIRMED", async () => {
  for (const where of ["/api/pricing/quote", "/api/onchain/info", "/api/x402/demo-execute"]) {
    const fake = new FakeAgentHire();
    fake.override = (c) => (c.path.startsWith(where) ? html429() : undefined);
    const { svc } = settlementFor(fake);
    const r = await svc.settle(req(52_440n));
    assert.equal(r.settled, false, where);
    assert.match(r.reason!, /^settlement: /);
    assert.match(r.reason!, /HTTP 429 with a non-JSON body/);
    assert.equal(fake.callsTo("/api/x402/pay").length, 0);
  }
  // The signed permit went out with the POST: charged, marked for reconciliation.
  const fake = new FakeAgentHire();
  fake.override = (c) => (c.path === "/api/x402/pay" ? html429() : undefined);
  const { svc } = settlementFor(fake);
  const r = await svc.settle(req(52_440n));
  assert.equal(r.settled, true);
  assert.equal(r.amountOut, 0n, "delivery unknown");
  assert.match(r.reason!, /^settlement: UNCONFIRMED .*HTTP 429 with a non-JSON body/);
  assert.match(r.reference!, /^agenthire-unconfirmed:x402-pay:0x/);
  assert.deepEqual(svc.unconfirmedReceipts.map((x) => x.route), ["x402-pay"]);
});

test("settlement never throws, even when the signer does", async () => {
  const fake = new FakeAgentHire();
  const svc = new AgentHireSettlementService({
    client: new AgentHireClient("http://127.0.0.1:5055", fake.fetch),
    signer: { address: Wallet.createRandom().address, signTypedData: async () => { throw new Error("hsm offline"); } },
    mandateExpiry: () => FAR,
    mode: "mock",
    now: () => SERVER_NOW,
  });
  const r = await svc.settle(req(52_440n));
  assert.equal(r.settled, false);
  assert.equal(r.reason, "settlement: unexpected error: hsm offline");
});

test("settlement (fuji): the same signed permit goes out as X-Payment on the x402 route", async () => {
  const fake = new FakeAgentHire();
  const { svc, signer } = settlementFor(fake, { mode: "fuji" });
  const r = await svc.settle(req(52_440n));
  assert.equal(r.settled, true, r.reason);
  assert.equal(r.reference, "agenthire-fuji:0x" + "ab".repeat(32));
  assert.equal(fake.callsTo("/api/x402/pay").length, 0);
  const routeCalls = fake.callsTo("/api/x402/demo-execute/5");
  assert.equal(routeCalls.length, 2); // 402 challenge, then the paid retry
  assert.equal(routeCalls[0]!.headers["x-payment"], undefined);
  const permit = JSON.parse(routeCalls[1]!.headers["x-payment"]!) as X402Permit;
  assert.deepEqual(permit, svc.receipts.at(-1)!.permit);
  assert.equal(permit.value, "52440");
  assertRecovers(permit, signer.address);
  assert.equal(svc.receipts.at(-1)!.route, "x402-execute");

  // AgentHire without a facilitator answers the retry with 402. The permit has
  // been handed over (a bearer authorization until validBefore), so it is
  // charged as UNCONFIRMED, not refused.
  const refusing = new FakeAgentHire();
  refusing.override = (c) =>
    c.headers["x-payment"] ? json({ error: "payment failed", detail: "facilitator not configured" }, 402) : undefined;
  const r2 = await settlementFor(refusing, { mode: "fuji" }).svc.settle(req(52_440n));
  assert.equal(r2.settled, true);
  assert.match(r2.reason!, /^settlement: UNCONFIRMED .*AgentHire did not confirm the X-Payment permit: .*HTTP 402 payment failed: facilitator not configured/);
});

test("FUJI: a permit AgentHire answers 402 to after capturing it cannot be spent twice from the node", async () => {
  // The fake keeps every X-Payment it sees (as a server that broadcast the
  // transfer and then failed waiting for the receipt would), then answers 402.
  const fake = new FakeAgentHire();
  const captured: X402Permit[] = [];
  fake.override = (c) => {
    if (!c.headers["x-payment"]) return undefined;
    captured.push(JSON.parse(c.headers["x-payment"]) as X402Permit);
    return json({ error: "payment failed", detail: "Transaction 0xabc is not in the chain after 120 seconds" }, 402);
  };
  const tree = new DelegationTree();
  tree.fundRoot({ principal: "buyer", rootName: "buyer.eth", mandate: { budget: 52_440n, allowedMerchants: [agentHireMerchant(5)], expiry: FAR } });
  const client = new AgentHireClient("http://127.0.0.1:5055", fake.fetch);
  const settlement = new AgentHireSettlementService({ client, signer: Wallet.createRandom(), ...agentHireTreeHooks(tree), mode: "fuji", now: () => SERVER_NOW });
  const payer = new SerializedPayer({ identity: new MockIdentityGate(), screening: new MockScreeningService(), settlement }, { now: SERVER_NOW });
  const first = await payer.pay(tree, { node: "buyer.eth", merchant: agentHireMerchant(5), amount: 52_440n });
  assert.equal(first.outcome, "SETTLED", "charged: the permit is out");
  assert.match(first.settlement!.reference!, /^agenthire-unconfirmed:x402-execute:/);
  assert.equal(tree.available("buyer.eth"), 0n);
  const second = await payer.pay(tree, { node: "buyer.eth", merchant: agentHireMerchant(5), amount: 52_440n });
  assert.equal(second.outcome, "BLOCKED_MANDATE");
  assert.match(second.reason!, /exceeds available 0/);
  assert.equal(captured.length, 1, "only one permit was ever signed and handed over");
  assert.equal(settlement.unconfirmedReceipts.length, 1);
});

test("a payment request that times out after it was sent is charged as UNCONFIRMED; the node cannot pay again", async () => {
  // AgentHire books the order but answers after the client's deadline.
  const fake = new FakeAgentHire();
  const booked: string[] = [];
  const slowFetch: FetchLike = async (url, init) => {
    const res = await fake.fetch(url, init);
    if (new URL(url).pathname === "/api/x402/pay") {
      booked.push("order");
      await new Promise((r) => setTimeout(r, 60));
    }
    return res;
  };
  const tree = new DelegationTree();
  tree.fundRoot({ principal: "buyer", rootName: "buyer.eth", mandate: { budget: 52_440n, allowedMerchants: [agentHireMerchant(5)], expiry: FAR } });
  const client = new AgentHireClient("http://127.0.0.1:5055", slowFetch, { payTimeoutMs: 20 });
  const settlement = new AgentHireSettlementService({ client, signer: Wallet.createRandom(), ...agentHireTreeHooks(tree), mode: "mock", now: () => SERVER_NOW });
  const payer = new SerializedPayer({ identity: new MockIdentityGate(), screening: new MockScreeningService(), settlement }, { now: SERVER_NOW });
  const first = await payer.pay(tree, { node: "buyer.eth", merchant: agentHireMerchant(5), amount: 52_440n });
  assert.equal(first.outcome, "SETTLED");
  assert.match(first.settlement!.reason!, /UNCONFIRMED .*timed out after 20ms/);
  const second = await payer.pay(tree, { node: "buyer.eth", merchant: agentHireMerchant(5), amount: 52_440n });
  assert.equal(second.outcome, "BLOCKED_MANDATE", "the leftover is gone: AgentHire may have booked the first");
  assert.deepEqual(booked, ["order"]);
  assert.equal(tree.requireNode("buyer.eth").mandate.spentDirect, 52_440n);
  assert.equal(settlement.receipts[0]!.unconfirmed, true);
});

test("AGENTHIRE_SETTLE selects the mode", () => {
  assert.equal(settleModeFromEnv({}), "mock");
  assert.equal(settleModeFromEnv({ AGENTHIRE_SETTLE: "fuji" }), "fuji");
  assert.equal(settleModeFromEnv({ AGENTHIRE_SETTLE: " MOCK " }), "mock");
  assert.throws(() => settleModeFromEnv({ AGENTHIRE_SETTLE: "mainnet" }), /must be "mock" or "fuji"/);
});

test("payer signer: a throwaway by default; AGENTHIRE_PAYER_KEY opts in and is never echoed", () => {
  assert.equal(payerSignerFromEnv({}).source, "throwaway");
  const funded = Wallet.createRandom();
  const s = payerSignerFromEnv({ AGENTHIRE_PAYER_KEY: funded.privateKey });
  assert.equal(s.source, "AGENTHIRE_PAYER_KEY");
  assert.equal(s.signer.address, funded.address);
  assert.throws(
    () => payerSignerFromEnv({ AGENTHIRE_PAYER_KEY: "0xnot-a-key-secret123" }),
    (e: unknown) => e instanceof Error && /not a valid private key/.test(e.message) && !/secret123/.test(e.message),
  );
});

/* ------------------------------------------------------------------ */
/* Through core pay()                                                 */
/* ------------------------------------------------------------------ */

function capitalTree(): DelegationTree {
  const tree = new DelegationTree();
  tree.fundRoot({ principal: "fund", rootName: "fund.eth", mandate: { budget: 1_000_000000n, expiry: FAR } });
  tree.delegate("fund.eth", "luckin-pm", { budget: 500_000000n, expiry: FAR });
  tree.delegate("luckin-pm.fund.eth", "scraper", {
    budget: 100_000n,
    allowedMerchants: [agentHireMerchant(5)],
    expiry: FAR,
  });
  return tree;
}

test("pay() -> AgentHire: quote-sized hire settles; a hire past the sub-mandate never reaches AgentHire", async () => {
  const fake = new FakeAgentHire();
  const tree = capitalTree();
  const client = new AgentHireClient("http://127.0.0.1:5055", fake.fetch);
  const settlement = new AgentHireSettlementService({
    client,
    signer: Wallet.createRandom(),
    ...agentHireTreeHooks(tree),
    mode: "mock",
    now: () => SERVER_NOW,
  });
  const adapters: PaymentAdapters = { identity: new MockIdentityGate(), screening: new MockScreeningService(), settlement };
  const amount = quoteMicro(await client.quote(5));
  const ok = await pay(tree, { node: "scraper.luckin-pm.fund.eth", merchant: agentHireMerchant(5), amount }, adapters, { now: SERVER_NOW });
  assert.equal(ok.outcome, "SETTLED", ok.reason);
  assert.equal(tree.requireNode("scraper.luckin-pm.fund.eth").mandate.spentDirect, 52_440n);

  const before = fake.calls.length;
  const over = await pay(tree, { node: "scraper.luckin-pm.fund.eth", merchant: agentHireMerchant(5), amount }, adapters, { now: SERVER_NOW });
  assert.equal(over.outcome, "BLOCKED_MANDATE");
  assert.match(over.reason!, /exceeds available 47560/);
  assert.equal(fake.calls.length, before, "a blocked payment makes no AgentHire call");
});

test("A2A: a sub-agent hire settles via trigger-direct tagged allowance:<node>#<seq> = the PAYMENT seq", async () => {
  const fake = new FakeAgentHire();
  fake.prices.set(7, 0.420001);
  const tree = new DelegationTree();
  tree.fundRoot({ principal: "buyer", rootName: "buyer.eth", mandate: { budget: 10_000000n, expiry: FAR } });
  // CodeReview Pro (1) is hired by the buyer and may sub-hire SecureAudit AI (7).
  tree.delegate("buyer.eth", "a1", { budget: 5_000000n, expiry: FAR });
  const hooks = agentHireTreeHooks(tree);
  const { svc } = settlementFor(fake, { payerAgentIdOf: (n) => (n === "a1.buyer.eth" ? 1 : undefined), nextSeq: hooks.nextSeq });
  const adapters: PaymentAdapters = { identity: new MockIdentityGate(), screening: new MockScreeningService(), settlement: svc };
  const rec = await pay(tree, { node: "a1.buyer.eth", merchant: agentHireMerchant(7), amount: 420_001n }, adapters, { now: SERVER_NOW });
  assert.equal(rec.outcome, "SETTLED", rec.reason);
  const call = fake.callsTo("/api/sim/trigger-direct")[0]!;
  const body = call.body as Record<string, unknown>;
  assert.equal(body.reason, `allowance:a1.buyer.eth#${rec.seq}`);
  assert.equal(body.fromId, 1);
  assert.equal(body.toId, 7);
  assert.equal(agentHireMicroOf(String(body.amountUSDC)), 420_001n);
  assert.equal(rec.settlement!.reference, "agenthire-a2a-sim:101");
  const receipt = svc.receipts.at(-1)!;
  assert.equal(receipt.route, "trigger-direct");
  assert.equal(receipt.simulated, true);
  assert.deepEqual(receipt.a2a, { fromId: 1, toId: 7, reason: `allowance:a1.buyer.eth#${rec.seq}`, eventIds: [101, 102] });

  // An echo that doesn't match what we asked for is not a clean settlement.
  // AgentHire answered 200, so it booked something: charged as UNCONFIRMED.
  fake.override = (c) =>
    c.path === "/api/sim/trigger-direct" ? json({ ok: true, fromId: 1, toId: 7, amountUSDC: 9, newEvents: [] }) : undefined;
  const a2a = (amount: bigint) => svc.settle({ node: "a1.buyer.eth", merchant: agentHireMerchant(7), amount, payerToken: "USDC", merchantToken: "USDC" });
  const bad = await a2a(420_001n);
  assert.equal(bad.settled, true);
  assert.match(bad.reason!, /^settlement: UNCONFIRMED .*AgentHire booked 9 USDC, expected 0.420001/);

  // A 4xx is AgentHire refusing before it books anything: a refusal.
  fake.override = (c) => (c.path === "/api/sim/trigger-direct" ? json({ error: "agent or profile missing", ok: false }, 400) : undefined);
  const refused = await a2a(420_001n);
  assert.equal(refused.settled, false);
  assert.match(refused.reason!, /^settlement: AgentHire refused trigger-direct before booking it: .*HTTP 400/);
  // A 503 ("Payment ran but no simulation events were captured") ran: UNCONFIRMED.
  fake.override = (c) =>
    c.path === "/api/sim/trigger-direct" ? json({ error: "Payment ran but no simulation events were captured", ok: false, newEvents: [] }, 503) : undefined;
  const ran = await a2a(420_001n);
  assert.equal(ran.settled, true);
  assert.match(ran.reason!, /UNCONFIRMED .*HTTP 503/);
  // And a typed amount never reaches trigger-direct at all.
  const before = fake.callsTo("/api/sim/trigger-direct").length;
  assert.match((await a2a(1n)).reason!, /^settlement: amount 1 != AgentHire's live quote 420001 micro-USDC for agent 7/);
  assert.equal(fake.callsTo("/api/sim/trigger-direct").length, before);
});

/* ------------------------------------------------------------------ */
/* Operators + screening                                              */
/* ------------------------------------------------------------------ */

function screeningFor(fake: FakeAgentHire, over: Partial<ConstructorParameters<typeof AgentHireScreeningService>[0]> = {}) {
  const client = new AgentHireClient("http://127.0.0.1:5055", fake.fetch);
  const operators = new OperatorRegistry();
  const incidents = new IncidentLedger();
  const screening = new AgentHireScreeningService({ client, operators, incidents, ...over });
  return { client, operators, incidents, screening };
}

const screenReq = (agentId: number) => ({ node: "buyer.eth", merchant: agentHireMerchant(agentId), amount: 1n });

test("operators: two differently named agents from one deployer are one counterparty (World ID mock nullifier)", async () => {
  const fake = new FakeAgentHire();
  const { client, operators } = screeningFor(fake);
  const a = await operators.bindFromAgentHire(client, 15);
  const b = await operators.bindFromAgentHire(client, 27);
  const c = await operators.bindFromAgentHire(client, 5);
  assert.equal(a.worldIdNullifier, b.worldIdNullifier);
  assert.notEqual(a.worldIdNullifier, c.worldIdNullifier);
  assert.equal(a.simulated, true);
  assert.ok(operators.sameCounterparty(15, 27));
  assert.ok(!operators.sameCounterparty(15, 5));
  assert.deepEqual(operators.agentsOf(a.worldIdNullifier), [15, 27]);
  assert.equal(c.deployerWallet, CRAWLTECH);
  await assert.rejects(operators.bind(5, SHARED_OPERATOR), /already bound to operator/);
  assert.equal((await operators.bind(5, CRAWLTECH.toUpperCase().replace("0X", "0x"))).agentId, 5); // idempotent
});

test("screening approves a clean agent and blocks banned / low-tier / incident-heavy ones", async () => {
  const fake = new FakeAgentHire();
  const { screening } = screeningFor(fake, { minTier: 1, maxIncidents: 1 });
  const clean = await screening.screen(screenReq(5));
  assert.equal(clean.approved, true, clean.reason);
  assert.match(clean.reason!, /simulated DB mirror/);

  fake.profile(7).banned = true;
  assert.match((await screening.screen(screenReq(7))).reason!, /^screening: agent 7 is banned on AgentHire/);
  fake.profile(1).incidentCount = 2;
  assert.match((await screening.screen(screenReq(1))).reason!, /^screening: agent 1 has 2 AgentHire incident\(s\) > 1 allowed/);
  const strict = screeningFor(fake, { minTier: 2 }).screening;
  assert.match((await strict.screen(screenReq(5))).reason!, /^screening: agent 5 reputation tier 1 < required 2/);
});

test("screening blocks every agent of an operator that has an Allowance incident", async () => {
  const fake = new FakeAgentHire();
  const { client, screening, operators, incidents } = screeningFor(fake);
  assert.equal((await screening.screen(screenReq(27))).approved, true);
  // Incident recorded against agent 15 (TestSmith) ...
  await incidents.record(await operators.bindFromAgentHire(client, 15), { kind: "mandate_overspend", reason: "3 attempts past its mandate" });
  // ... follows the operator to agent 27 (StackTracer), a different name.
  const blocked = await screening.screen(screenReq(27));
  assert.equal(blocked.approved, false);
  assert.match(blocked.reason!, new RegExp(`^screening: operator ${SHARED_OPERATOR} .* has 1 Allowance incident\\(s\\) \\(agent 15\\) > 0 allowed`));
  // Another operator's agent is unaffected; AgentHire's own counters are untouched.
  assert.equal((await screening.screen(screenReq(5))).approved, true);
  assert.equal(fake.profile(15).incidentCount, 0);
});

test("screening fails closed on HTML 429 / network errors and passes non-AgentHire merchants to the inner screen", async () => {
  const fake = new FakeAgentHire();
  fake.override = (c) => (c.path.endsWith("/reputation") ? html429() : undefined);
  const { screening } = screeningFor(fake, { inner: new MockScreeningService() });
  const r = await screening.screen(screenReq(5));
  assert.equal(r.approved, false);
  assert.match(r.reason!, /^screening: AgentHire reputation unavailable: .*HTTP 429/);
  assert.equal((await screening.screen({ node: "n", merchant: "openai", amount: 1n })).approved, true);
  assert.equal((await screening.screen({ node: "n", merchant: "sanctioned-vendor", amount: 1n })).approved, false);
  const unknown = await screeningFor(new FakeAgentHire()).screening.screen(screenReq(999));
  assert.match(unknown.reason!, /^screening: operator of agent 999 unknown/);
});

test("incident loop: repeated overspend -> incident + AgentHire dispute (no slash) -> next buyer BLOCKED_SCREENING", async () => {
  const fake = new FakeAgentHire();
  const tree = capitalTree();
  const { client, screening, operators, incidents } = screeningFor(fake);
  const settlement = new AgentHireSettlementService({ client, signer: Wallet.createRandom(), ...agentHireTreeHooks(tree), mode: "mock", now: () => SERVER_NOW });
  const adapters: PaymentAdapters = { identity: new MockIdentityGate(), screening, settlement };
  // Agent 5 is not bound yet: over-mandate payments stop before screening, so
  // the watch binds the operator itself.
  assert.equal(operators.get(5), undefined);
  const watch = new OverspendWatch({ ledger: incidents, operators, threshold: 2, report: { client, affectedUser: OTHER } });

  // The scraper (acting for WebCrawler X, agent 5) keeps asking for more than its sub-mandate.
  const tooMuch = { node: "scraper.luckin-pm.fund.eth", merchant: agentHireMerchant(5), amount: 5_000000n };
  const first = await pay(tree, tooMuch, adapters, { now: SERVER_NOW });
  assert.equal(first.outcome, "BLOCKED_MANDATE");
  assert.equal(await watch.observe(first, 5), null);
  const second = await pay(tree, tooMuch, adapters, { now: SERVER_NOW });
  const incident = await watch.observe(second, 5);
  assert.ok(incident);
  assert.equal(incident.kind, "mandate_overspend");
  assert.equal(incident.deployerWallet, CRAWLTECH);
  assert.deepEqual(incident.agentHireReport, {
    route: "/api/dispute/submit",
    ok: true,
    status: "pending_review",
    note: "No GATEKEEPER_URL and no GATEKEEPER_PRIVATE_KEY - dispute logged but no on-chain incident was signed.",
  });
  const dispute = fake.callsTo("/api/dispute/submit")[0]!.body as Record<string, unknown>;
  assert.equal(dispute.agentId, 5);
  assert.match(String(dispute.reason), /not a slash request/);
  assert.equal(incidents.list()[0]!.agentHireReport?.status, "pending_review", "AgentHire's answer is stored on the incident");
  assert.equal(fake.callsTo("/api/sim/slash-agent").length, 0);

  // A second buyer, in a different tree, tries to hire WebCrawler X.
  const other = new DelegationTree();
  other.fundRoot({ principal: "bob", rootName: "bob.eth", mandate: { budget: 10_000000n, expiry: FAR } });
  const refused = await pay(other, { node: "bob.eth", merchant: agentHireMerchant(5), amount: 52_440n }, adapters, { now: SERVER_NOW });
  assert.equal(refused.outcome, "BLOCKED_SCREENING");
  assert.match(refused.reason!, /operator 0x1ce3b4044124714daa6a68b95441963679eea6ec/);
  assert.equal(fake.callsTo("/api/x402/pay").length, 0);
});

test("incident store: a buyer in another process (a fresh ledger on the same file) is still screened out", async () => {
  const dir = await mkdtemp(join(tmpdir(), "allowance-incidents-"));
  try {
    const file = join(dir, "nested", "incidents.json");
    const fake = new FakeAgentHire();
    const client = new AgentHireClient("http://127.0.0.1:5055", fake.fetch);
    const first = new IncidentLedger(new JsonFileIncidentStore(file));
    assert.equal(first.persistent, true);
    assert.equal(first.location, file);
    const ops = new OperatorRegistry();
    const incident = await first.record(await ops.bindFromAgentHire(client, 15), {
      kind: "mandate_overspend",
      reason: "2 attempts past its mandate",
      note: "scripted by a test acting for agent 15",
    });
    assert.equal(incident.id, "ALW-INC-1");
    await first.annotate(incident.id, { route: "/api/dispute/submit", ok: true, status: "pending_review" });

    // "Another process": new registry, new ledger, new screening, same file.
    const later = new IncidentLedger(new JsonFileIncidentStore(file));
    assert.equal(later.list().length, 0, "nothing loaded until sync()");
    const screening = new AgentHireScreeningService({ client, operators: new OperatorRegistry(), incidents: later });
    const refused = await screening.screen(screenReq(27)); // StackTracer: same operator as TestSmith (15)
    assert.equal(refused.approved, false);
    assert.match(refused.reason!, /has 1 Allowance incident\(s\) \(agent 15\)/);
    assert.equal(later.list()[0]!.agentHireReport?.status, "pending_review");
    assert.equal(later.list()[0]!.note, "scripted by a test acting for agent 15");
    // Numbering continues across processes.
    assert.equal((await later.record(await ops.bindFromAgentHire(client, 5), { kind: "k", reason: "r" })).id, "ALW-INC-2");

    // A corrupt store fails closed.
    await writeFile(file, "{ not json", "utf8");
    const broken = await new AgentHireScreeningService({ client, operators: new OperatorRegistry(), incidents: new IncidentLedger(new JsonFileIncidentStore(file)) }).screen(screenReq(5));
    assert.equal(broken.approved, false);
    assert.match(broken.reason!, /^screening: incident record .* unreadable/);
    // A missing store is simply empty.
    const empty = new IncidentLedger(new JsonFileIncidentStore(join(dir, "none.json")));
    await empty.sync();
    assert.equal(empty.list().length, 0);
    assert.equal(new IncidentLedger().location, "memory (this process only)");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* SerializedPayer                                                    */
/* ------------------------------------------------------------------ */

/** Adapters whose settlement takes a tick, so concurrent pay() calls overlap. */
function slowAdapters(log: { active: number; maxActive: number }): PaymentAdapters {
  return {
    identity: { verify: async () => ({ ok: true }) },
    screening: { screen: async () => ({ approved: true }) },
    settlement: {
      settle: async (r) => {
        log.active++;
        log.maxActive = Math.max(log.maxActive, log.active);
        await new Promise((res) => setTimeout(res, 5));
        log.active--;
        return { settled: true, swapped: false, fromToken: r.payerToken, toToken: r.merchantToken, amountIn: r.amount, amountOut: r.amount };
      },
    },
  };
}

function leftoverTree(name = "fund.eth"): DelegationTree {
  const tree = new DelegationTree();
  tree.fundRoot({ principal: "fund", rootName: name, mandate: { budget: 100_000000n, expiry: FAR } });
  tree.delegate(name, "pm", { budget: 10_000000n, expiry: FAR });
  tree.delegate(`pm.${name}`, "scraper", { budget: 8_000000n, expiry: FAR });
  return tree;
}

test("without serialization, two concurrent pay() calls can both spend the same leftover (the gap)", async () => {
  const tree = leftoverTree();
  const adapters = slowAdapters({ active: 0, maxActive: 0 });
  const [a, b] = await Promise.all([
    pay(tree, { node: "scraper.pm.fund.eth", merchant: "m", amount: 6_000000n }, adapters, { now: 1 }),
    pay(tree, { node: "scraper.pm.fund.eth", merchant: "m", amount: 6_000000n }, adapters, { now: 1 }),
  ]);
  assert.deepEqual([a.outcome, b.outcome], ["SETTLED", "SETTLED"]);
  assert.equal(tree.available("scraper.pm.fund.eth"), -4_000000n);
});

test("SerializedPayer: concurrent payments on one root cannot both spend the same leftover", async () => {
  const tree = leftoverTree();
  const log = { active: 0, maxActive: 0 };
  const payer = new SerializedPayer(slowAdapters(log), { now: 1 });
  // Two different nodes under the same root, racing for the pm's leftover.
  const [a, b, c] = await Promise.all([
    payer.pay(tree, { node: "scraper.pm.fund.eth", merchant: "m", amount: 6_000000n }),
    payer.pay(tree, { node: "scraper.pm.fund.eth", merchant: "m", amount: 6_000000n }),
    payer.pay(tree, { node: "pm.fund.eth", merchant: "m", amount: 2_000000n }),
  ]);
  assert.deepEqual([a.outcome, b.outcome, c.outcome], ["SETTLED", "BLOCKED_MANDATE", "SETTLED"]);
  assert.equal(log.maxActive, 1);
  assert.equal(tree.available("scraper.pm.fund.eth"), 2_000000n);
  assert.equal(tree.available("pm.fund.eth"), 0n);
  assert.equal(payer.rootOf(tree, "scraper.pm.fund.eth"), "fund.eth");
});

test("SerializedPayer: two payer instances over one tree still take turns on the same root", async () => {
  const tree = leftoverTree();
  const log = { active: 0, maxActive: 0 };
  const adapters = slowAdapters(log);
  const p1 = new SerializedPayer(adapters, { now: 1 });
  const p2 = new SerializedPayer(adapters, { now: 1 });
  const [a, b] = await Promise.all([
    p1.pay(tree, { node: "fund.eth", merchant: "m", amount: 90_000000n }),
    p2.pay(tree, { node: "fund.eth", merchant: "m", amount: 90_000000n }),
  ]);
  assert.deepEqual([a.outcome, b.outcome], ["SETTLED", "BLOCKED_MANDATE"]);
  assert.equal(log.maxActive, 1);
  assert.equal(tree.available("fund.eth"), 0n);
  // close() from one instance also waits for a payment queued by the other.
  const t2 = leftoverTree("two.eth");
  const inFlight = p1.pay(t2, { node: "scraper.pm.two.eth", merchant: "m", amount: 3_000000n });
  const freed = await p2.close(t2, "pm.two.eth");
  assert.equal((await inFlight).outcome, "SETTLED");
  assert.equal(freed, 7_000000n);
});

test("SerializedPayer: different roots run in parallel; a throwing call does not wedge the queue", async () => {
  const log = { active: 0, maxActive: 0 };
  const payer = new SerializedPayer(slowAdapters(log), { now: 1 });
  const t1 = leftoverTree("one.eth");
  const t2 = leftoverTree("two.eth");
  const results = await Promise.allSettled([
    payer.pay(t1, { node: "scraper.pm.one.eth", merchant: "m", amount: 1n }),
    payer.run(t1, "pm.one.eth", () => {
      throw new Error("boom"); // queued on one.eth's root, between two payments
    }),
    payer.pay(t2, { node: "scraper.pm.two.eth", merchant: "m", amount: 1n }),
    payer.pay(t1, { node: "pm.one.eth", merchant: "m", amount: 1n }),
  ]);
  assert.deepEqual(results.map((r) => r.status), ["fulfilled", "rejected", "fulfilled", "fulfilled"]);
  assert.equal((results[3] as PromiseFulfilledResult<{ outcome: string }>).value.outcome, "SETTLED");
  assert.equal(log.maxActive, 2); // one.eth and two.eth overlapped; one.eth never with itself
  await assert.rejects(payer.pay(t1, { node: "ghost.pm.one.eth", merchant: "m", amount: 1n }), /unknown node/);
});

test("SerializedPayer.close waits for an in-flight payment, then frees exactly the unspent part", async () => {
  const tree = leftoverTree();
  const payer = new SerializedPayer(slowAdapters({ active: 0, maxActive: 0 }), { now: 1 });
  const inFlight = payer.pay(tree, { node: "scraper.pm.fund.eth", merchant: "m", amount: 3_000000n });
  const closing = payer.close(tree, "pm.fund.eth");
  const late = payer.pay(tree, { node: "scraper.pm.fund.eth", merchant: "m", amount: 1n });
  assert.equal((await inFlight).outcome, "SETTLED");
  assert.equal(await closing, 7_000000n); // pm held 10, the scraper spent 3
  assert.equal((await late).outcome, "REVOKED");
  assert.equal(tree.available("fund.eth"), 97_000000n);
  assert.equal(tree.available("scraper.pm.fund.eth"), 0n);
});

/* ------------------------------------------------------------------ */
/* Hire sizing: QuoteBook, planHire, delegateAll, aliases             */
/* ------------------------------------------------------------------ */

test("planHire: main gets its quote, subs split cap - main pro rata, summing to the micro", () => {
  const even = planHire({ cap: 1_000_000n, main: 300_000n, subs: [{ key: "a", weight: 1n }, { key: "b", weight: 1n }, { key: "c", weight: 1n }] });
  assert.equal(even.pool, 700_000n);
  assert.deepEqual(even.subs.map((s) => s.budget), [233_334n, 233_333n, 233_333n]);

  // Weighted by the sub-agents' own quotes (ResearchBot Pro 0.004983, DataSift 0.18).
  const p = planHire({ cap: 352_040n, main: 49_710n, subs: [{ key: "a6-via-a5", weight: 4_983n }, { key: "a3-via-a5", weight: 180_000n }] });
  assert.equal(p.subs.reduce((s, x) => s + x.budget, 0n), p.pool);
  assert.equal(p.pool, 302_330n);
  // 302330 * 4983 / 184983 = 8144.0.. -> 8144; the other gets the rest.
  assert.deepEqual(p.subs.map((s) => s.budget), [8_144n, 294_186n]);

  // Largest remainder never overshoots or undershoots the pool.
  for (const pool of [1n, 2n, 7n, 999_999n]) {
    const q = planHire({ cap: pool, main: 0n, subs: [{ key: "x", weight: 3n }, { key: "y", weight: 3n }, { key: "z", weight: 1n }] });
    assert.equal(q.subs.reduce((s, x) => s + x.budget, 0n), pool);
  }
  assert.deepEqual(planHire({ cap: 10n, main: 4n, subs: [{ key: "x", weight: 0n }, { key: "y", weight: 0n }] }).subs.map((s) => s.budget), [3n, 3n]);
  assert.deepEqual(planHire({ cap: 10n, main: 10n, subs: [] }), { cap: 10n, main: 10n, pool: 0n, subs: [] });

  assert.throws(() => planHire({ cap: 99n, main: 100n, subs: [] }), /does not cover the main quote/);
  assert.throws(() => planHire({ cap: 9n, main: 1n, subs: [{ key: "x", weight: 1n }, { key: "x", weight: 2n }] }), /duplicate/);
  assert.throws(() => planHire({ cap: 9n, main: 1n, subs: [{ key: "x", weight: -1n }] }), /negative weight/);
});

test("delegateAll: every child or none (a bad sibling leaves no partial tree)", () => {
  const tree = new DelegationTree();
  tree.fundRoot({ principal: "fund", rootName: "fund.eth", mandate: { budget: 1_000n, expiry: FAR } });
  tree.delegate("fund.eth", "scraper", { budget: 100n, allowedMerchants: [agentHireMerchant(5), agentHireMerchant(6)], expiry: FAR });
  const nodes = tree.listNodes().length;
  const seq = tree.nextSeq;

  // The second child asks for a merchant the parent cannot grant.
  assert.throws(
    () =>
      delegateAll(tree, "scraper.fund.eth", [
        { label: "a6-via-a5", mandate: { budget: 10n, allowedMerchants: [agentHireMerchant(6)], expiry: FAR } },
        { label: "a3-via-a5", mandate: { budget: 10n, allowedMerchants: [agentHireMerchant(3)], expiry: FAR } },
      ]),
    (e: unknown) => e instanceof AttenuationError && e.reason === "MERCHANTS_NOT_SUBSET",
  );
  assert.equal(tree.listNodes().length, nodes, "no sibling was created");
  assert.equal(tree.nextSeq, seq + 1);
  assert.equal(tree.events.at(-1)!.result, "ATTENUATION_REJECTED");

  // Together they exceed what the parent has: refused up front, not after the first.
  assert.throws(
    () =>
      delegateAll(tree, "scraper.fund.eth", [
        { label: "a6-via-a5", mandate: { budget: 60n, allowedMerchants: [agentHireMerchant(6)], expiry: FAR } },
        { label: "a5-via-a6", mandate: { budget: 60n, allowedMerchants: [agentHireMerchant(5)], expiry: FAR } },
      ]),
    (e: unknown) => e instanceof AttenuationError && e.reason === "BUDGET_EXCEEDS_AVAILABLE",
  );
  assert.equal(tree.listNodes().length, nodes);
  assert.throws(
    () =>
      delegateAll(tree, "scraper.fund.eth", [
        { label: "x", mandate: { budget: 1n, allowedMerchants: [], expiry: FAR } },
        { label: "x", mandate: { budget: 1n, allowedMerchants: [], expiry: FAR } },
      ]),
    /x\.scraper\.fund\.eth/,
  );

  const made = delegateAll(tree, "scraper.fund.eth", [
    { label: "a6-via-a5", mandate: { budget: 40n, allowedMerchants: [agentHireMerchant(6)], expiry: FAR } },
    { label: "a5-via-a6", mandate: { budget: 60n, allowedMerchants: [agentHireMerchant(5)], expiry: FAR } },
  ]);
  assert.deepEqual(made.map((n) => n.name), ["a6-via-a5.scraper.fund.eth", "a5-via-a6.scraper.fund.eth"]);
  assert.equal(tree.available("scraper.fund.eth"), 0n);
});

test("delegateAll: a whole subtree (job + its aliases) is checked before the job itself is written", () => {
  const tree = new DelegationTree();
  tree.fundRoot({ principal: "fund", rootName: "fund.eth", mandate: { budget: 1_000n, expiry: FAR } });
  const job = (aliasBudget: bigint, aliasMerchant: string) => ({
    label: "job",
    mandate: { budget: 100n, allowedMerchants: [agentHireMerchant(5), agentHireMerchant(6)], expiry: FAR },
    children: [{ label: "a6-via-a5", mandate: { budget: aliasBudget, allowedMerchants: [aliasMerchant], expiry: FAR } }],
  });
  // The grandchild asks for more than the job will hold: the job is not created either.
  assert.throws(() => delegateAll(tree, "fund.eth", [job(101n, agentHireMerchant(6))]), (e: unknown) => e instanceof AttenuationError && e.reason === "BUDGET_EXCEEDS_AVAILABLE");
  // ...or for a merchant the job will not have.
  assert.throws(() => delegateAll(tree, "fund.eth", [job(10n, agentHireMerchant(3))]), (e: unknown) => e instanceof AttenuationError && e.reason === "MERCHANTS_NOT_SUBSET");
  assert.deepEqual(tree.listNodes().map((n) => n.name), ["fund.eth"]);
  assert.equal(tree.events.filter((e) => e.result === "ATTENUATION_REJECTED").length, 2);

  const made = delegateAll(tree, "fund.eth", [job(60n, agentHireMerchant(6))]);
  assert.deepEqual(made.map((n) => n.name), ["job.fund.eth", "a6-via-a5.job.fund.eth"]);
  assert.equal(tree.available("job.fund.eth"), 40n);
});

test("alias labels: one node per (hirer, sub-agent) edge; an alias pays as its hirer", () => {
  assert.equal(aliasNodeLabel(5, 6), "a6-via-a5");
  assert.notEqual(aliasNodeLabel(1, 7), aliasNodeLabel(7, 1)); // the 1 <-> 7 cycle stays two nodes
  assert.deepEqual(parseAliasLabel("a6-via-a5.scraper.luckin-pm.fund.eth"), { subAgentId: 6, hirerId: 5 });
  assert.equal(aliasPayerAgentId("a6-via-a5.scraper.fund.eth"), 5);
  assert.equal(aliasPayerAgentId("scraper.fund.eth"), undefined);
  assert.equal(parseAliasLabel("a6-via-a5x"), undefined);
});

test("default settlement (no QuoteBook) still pays only AgentHire's live quote: a typed amount is refused", async () => {
  const fake = new FakeAgentHire();
  const { svc } = settlementFor(fake);
  const typed = await svc.settle(req(1n));
  assert.equal(typed.settled, false);
  assert.match(typed.reason!, /^settlement: amount 1 != AgentHire's live quote 52440 micro-USDC for agent 5/);
  assert.equal(fake.callsTo("/api/x402/demo-execute").length, 0, "no challenge fetched, nothing signed");
  assert.equal(fake.callsTo("/api/x402/pay").length, 0);
  const ok = await svc.settle(req(52_440n));
  assert.equal(ok.settled, true, ok.reason);
  assert.equal(svc.receipts.at(-1)!.quoteMicro, "52440");
  assert.equal(svc.receipts.at(-1)!.quoteSource, "live");
});

test("QuoteBook: settlement pays only the AgentHire quote on file, and only while it is fresh", async () => {
  const fake = new FakeAgentHire();
  const client = new AgentHireClient("http://127.0.0.1:5055", fake.fetch);
  let clock = SERVER_NOW;
  const quotes = new QuoteBook({ now: () => clock });
  const svc = new AgentHireSettlementService({
    client,
    signer: Wallet.createRandom(),
    mandateExpiry: () => FAR,
    mode: "mock",
    now: () => SERVER_NOW,
    quotes,
    quoteMaxAgeSeconds: 900,
  });
  const node = "scraper.pm.fund.eth";

  const none = await svc.settle(req(52_440n));
  assert.equal(none.settled, false);
  assert.match(none.reason!, /^settlement: no AgentHire quote on file for "scraper\.pm\.fund\.eth" -> agent 5/);
  assert.equal(fake.calls.length, 0, "refused before any AgentHire call");

  const entry = await quotes.fetch(client, node, 5);
  assert.equal(entry.micro, 52_440n);
  assert.equal(entry.baseUrl, "http://127.0.0.1:5055");
  assert.equal(fake.callsTo("/api/pricing/quote/5").length, 1, "the book read the quote itself");
  const typed = await svc.settle(req(52_441n));
  assert.match(typed.reason!, /^settlement: amount 52441 != AgentHire quote 52440 micro-USDC for agent 5$/);
  assert.equal(fake.callsTo("/api/x402/pay").length, 0);

  const ok = await svc.settle(req(52_440n));
  assert.equal(ok.settled, true, ok.reason);
  assert.equal(svc.receipts.at(-1)!.quoteMicro, "52440");
  assert.equal(svc.receipts.at(-1)!.quoteSource, "quote-book");

  // Stale: the book stamps entries with its own clock, never the caller's.
  clock = SERVER_NOW - 901;
  await quotes.fetch(client, node, 5);
  clock = SERVER_NOW;
  assert.match((await svc.settle(req(52_440n))).reason!, /quote for agent 5 is 901s old \(max 900s\); re-quote/);

  // Entries cannot be forged: there is no way to file a quote except fetch(),
  // entries are frozen, and a quote read from another server is refused.
  assert.equal((quotes as unknown as { record?: unknown }).record, undefined);
  const fresh = await quotes.fetch(client, node, 5);
  assert.throws(() => {
    (fresh as { micro: bigint }).micro = 1n;
  }, TypeError);
  const elsewhere = new FakeAgentHire();
  elsewhere.prices.set(5, 0.000001);
  await quotes.fetch(new AgentHireClient("http://127.0.0.1:6666", elsewhere.fetch), node, 5);
  const forged = await svc.settle(req(1n));
  assert.equal(forged.settled, false);
  assert.match(forged.reason!, /was read from http:\/\/127\.0\.0\.1:6666, not from the AgentHire being paid/);
  // A server that quotes another agent is not a quote for this one.
  const confused = new FakeAgentHire();
  confused.override = (c) => (c.path.startsWith("/api/pricing/quote") ? json({ agentId: 9, currentPrice: 1, minPrice: 1, maxPrice: 1 }) : undefined);
  await assert.rejects(quotes.fetch(new AgentHireClient("http://127.0.0.1:5055", confused.fetch), node, 5), /quote is for agent 9, not 5/);
});

test("client: sim status, speed and a2a-candidates", async () => {
  const fake = new FakeAgentHire();
  const client = new AgentHireClient("http://127.0.0.1:5055", fake.fetch);
  assert.equal((await client.simStatus()).tickRealSeconds, 5);
  assert.equal((await client.setSimSpeed(0.1)).tickRealSeconds, 0.1);
  assert.deepEqual(fake.calls.at(-1)!.body, { tickRealSeconds: 0.1 });
  assert.equal((await client.a2aCandidates()).flagships[0]!.subAgents[0]!.id, 5);
  await assert.rejects(client.setSimSpeed(0), RangeError);
});

test("a planned hire fills the cap exactly: main settles by x402, the sub-agent alias by A2A, all at their quotes", async () => {
  const fake = new FakeAgentHire();
  const tree = capitalTree();
  const client = new AgentHireClient("http://127.0.0.1:5055", fake.fetch);
  const quotes = new QuoteBook({ now: () => SERVER_NOW });
  const settlement = new AgentHireSettlementService({
    client,
    signer: Wallet.createRandom(),
    ...agentHireTreeHooks(tree),
    payerAgentIdOf: aliasPayerAgentId,
    mode: "mock",
    now: () => SERVER_NOW,
    quotes,
  });
  const payer = new SerializedPayer({ identity: new MockIdentityGate(), screening: new MockScreeningService(), settlement }, { now: SERVER_NOW });

  // The PM opens a data job capped at 0.2 USDC for WebCrawler X (5) plus one sub-agent (7).
  const job = tree.delegate("luckin-pm.fund.eth", "job", {
    budget: 200_000n,
    allowedMerchants: [agentHireMerchant(5), agentHireMerchant(7)],
    expiry: FAR,
  }).name;
  const main = await quotes.fetch(client, job, 5);
  const alias = aliasNodeLabel(5, 7);
  const aliasName = `${alias}.${job}`;
  const sub = (await quotes.fetch(client, aliasName, 7)).quote;
  const plan = planHire({ cap: 200_000n, main: main.micro, subs: [{ key: alias, weight: quoteMicro(sub) }] });
  await payer.run(tree, job, () =>
    delegateAll(tree, job, plan.subs.map((s) => ({ label: s.key, mandate: { budget: s.budget, allowedMerchants: [agentHireMerchant(7)], expiry: FAR } }))),
  );
  assert.equal(tree.available(job), main.micro, "exactly the main quote is left for the main hire");

  const m = await payer.pay(tree, { node: job, merchant: agentHireMerchant(5), amount: main.micro });
  assert.equal(m.outcome, "SETTLED", m.reason);
  const s = await payer.pay(tree, { node: aliasName, merchant: agentHireMerchant(7), amount: quoteMicro(sub) });
  assert.equal(s.outcome, "SETTLED", s.reason);
  const a2a = fake.callsTo("/api/sim/trigger-direct")[0]!.body as Record<string, unknown>;
  assert.deepEqual([a2a.fromId, a2a.toId, a2a.reason], [5, 7, `allowance:${aliasName}#${s.seq}`]);
  assert.equal(tree.available(aliasName), plan.subs[0]!.budget - quoteMicro(sub));
});
