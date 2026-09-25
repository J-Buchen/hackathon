/**
 * World ID for Agents — the machine-identity gate.
 *
 * Every `pay()` runs the identity stage FIRST: the acting node must prove it is a
 * genuine, currently-valid agent identity, and so must every ancestor up the
 * delegation chain. This is the `IdentityGate` port from `@allowance/core`.
 *
 * Sponsor: World ID for Agents ($5k). Docs / dev-env flow:
 *   https://docs.world.org/  (World ID)  ·  Agent identities are World-ID-backed
 *   credentials proven per action; verification is performed BACKEND-ONLY with an
 *   app-scoped API key — a client must never be trusted to self-attest.
 *
 * This file ships:
 *   - `MockIdentityGate`        deterministic, offline (used by the demo)
 *   - `WorldAgentIdentityGate`  real-integration stub (TODO(cred))
 */

import type {
  AgentNode,
  IdentityCheckContext,
  IdentityGate,
  IdentityResult,
} from "@allowance/core";
import { leftLabel } from "@allowance/core";
import { AdapterNotConfiguredError } from "./errors";

/** Configuration for the deterministic mock identity gate. */
export interface MockIdentityGateConfig {
  /**
   * If provided, ONLY these fully-qualified node names are treated as
   * machine-verified, regardless of their `identityStatus`. Useful for tests
   * that want to pin exactly which agents hold a valid World ID credential.
   * When omitted, the node's own `identityStatus` drives the decision.
   */
  verifiedNames?: string[];
  /**
   * Left-most-label prefixes that simulate rogue / impersonating agents which
   * fail identity outright (e.g. a spoofed `ghost.alice.eth`). Default:
   * `["ghost"]`.
   */
  deniedLabelPrefixes?: string[];
}

/**
 * Deterministic, offline World-ID-for-Agents gate.
 *
 * Decision rule (matches DESIGN §5): a payment is allowed IFF the acting node
 * AND every ancestor are machine-verified. A node fails if:
 *   1. its left-most label matches a denied prefix (default `ghost.*`), or
 *   2. `verifiedNames` is set and the node is not in it, or
 *   3. its `identityStatus` is not `"verified"` ("expired" / "none").
 *
 * The first failing node short-circuits and its name is included in the reason,
 * so the demo's expired-identity path (`ghost.alice.eth`) reports a clear cause.
 */
export class MockIdentityGate implements IdentityGate {
  private readonly verifiedNames?: Set<string>;
  private readonly deniedPrefixes: string[];

  constructor(config: MockIdentityGateConfig = {}) {
    this.verifiedNames = config.verifiedNames ? new Set(config.verifiedNames) : undefined;
    this.deniedPrefixes = config.deniedLabelPrefixes ?? ["ghost"];
  }

  async verify(ctx: IdentityCheckContext): Promise<IdentityResult> {
    // Check the acting node first, then walk the ancestor chain to the root.
    for (const node of [ctx.node, ...ctx.ancestors]) {
      const outcome = this.checkOne(node, node === ctx.node);
      if (!outcome.ok) return outcome;
    }
    return { ok: true };
  }

  /** Verify a single node against the mock's rules. */
  private checkOne(node: AgentNode, isSelf: boolean): IdentityResult {
    const who = isSelf ? node.name : `ancestor ${node.name}`;

    // 1) Impersonation / rogue-agent prefix (e.g. ghost.*).
    const label = leftLabel(node.name);
    if (this.deniedPrefixes.some((p) => label === p || label.startsWith(p))) {
      return { ok: false, reason: `${who} failed World ID (rogue/unregistered agent)` };
    }

    // 2) Explicit allowlist override.
    if (this.verifiedNames && !this.verifiedNames.has(node.name)) {
      return { ok: false, reason: `${who} has no valid World ID credential` };
    }

    // 3) Credential status.
    if (node.identityStatus === "expired") {
      return { ok: false, reason: `${who} World ID credential is expired` };
    }
    if (node.identityStatus === "none") {
      return { ok: false, reason: `${who} is not World-ID verified` };
    }

    return { ok: true };
  }
}

/**
 * Real World-ID-for-Agents identity gate (integration stub).
 *
 * PRODUCTION FLOW (backend-only):
 *   1. The agent presents a per-action World ID proof (obtained via the World
 *      dev-environment agent flow) alongside the action it wants to perform.
 *   2. This service POSTs the proof to World's verification endpoint using an
 *      app-scoped API key that MUST stay server-side.
 *   3. World returns whether the credential is valid and unexpired; we map that
 *      to an `IdentityResult`. Every ancestor's credential is verified the same
 *      way so a revoked/expired ancestor invalidates the whole chain.
 *
 * TODO(cred): set `appId` + `apiKey` from the World developer portal
 *   (https://developer.worldcoin.org/) and implement `verifyProof` against the
 *   agent-identity verification API. Until then this stub throws so it can never
 *   be mistaken for a real check.
 */
export interface WorldAgentIdentityGateConfig {
  /** World app id (`app_...`). TODO(cred). */
  appId?: string;
  /** Server-side API key. TODO(cred). NEVER ship to a client. */
  apiKey?: string;
  /** Verification endpoint. Defaults to the World cloud verifier. */
  apiUrl?: string;
}

export class WorldAgentIdentityGate implements IdentityGate {
  constructor(private readonly config: WorldAgentIdentityGateConfig = {}) {}

  async verify(_ctx: IdentityCheckContext): Promise<IdentityResult> {
    if (!this.config.appId || !this.config.apiKey) {
      throw new AdapterNotConfiguredError(
        "World ID for Agents",
        "See https://developer.worldcoin.org/ — verification is backend-only.",
      );
    }
    // TODO(cred): for ctx.node and each ancestor, POST the presented World ID
    // proof to `${apiUrl}/api/v2/verify/${appId}` with the API key and return
    // { ok: response.success }. Left unimplemented on purpose.
    throw new AdapterNotConfiguredError("World ID for Agents", "verifyProof not implemented.");
  }
}
