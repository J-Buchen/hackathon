/**
 * Boundary parser for `agenthire-receipts.json`, the sidecar `npm run
 * demo:agenthire` writes next to `agenthire-snapshot.json`. The dashboard only
 * needs a few fields from it (the audit headline, the incident, the honesty
 * notes), so this pulls those out and proves their types. Everything else in
 * the file stays available for anyone reading the JSON directly.
 */

export class AgentHireSidecarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentHireSidecarError";
  }
}

export interface AgentHireSummary {
  /** Always true: the sidecar describes a keyless AgentHire run. */
  simulated: boolean;
  /** "mock" or "fuji". */
  mode: string;
  /** "N of M sub-agent payments would have been blocked …" with its assumption. */
  auditHeadline: string;
  /**
   * One line per incident: "ALW-INC-1 · agent 5 · operator 0x… · AgentHire
   * dispute route: pending_review (logged only)". The incident itself lives on
   * Allowance's side; keyless AgentHire only prints the dispute to its log.
   */
  incidents: string[];
  /** Micro-USDC freed by the stop-out close(), as a decimal string. */
  freed: string | null;
  /** The honesty notes printed by the demo (what is simulated, no escrow, …). */
  honesty: string[];
}

/**
 * The demo prints USDC amounts at full 6-decimal precision ("90.900000 of
 * 239.616200 USDC"). On the page they read as money: 2 decimals. Only numbers
 * with exactly 6 decimals (the demo's micro-USDC format) are touched, so ratios
 * such as "1.25 x" or "0.125" stay as they are, and a non-zero amount under a
 * cent prints "<0.01", never a false "0.00".
 */
export function roundAmounts(text: string): string {
  return text.replace(/\b(\d+)\.(\d{6})(?![\d.])/g, (_m, i: string, f: string) => {
    const v = Number(`${i}.${f}`);
    const s = v.toFixed(2);
    return v > 0 && Number(s) === 0 ? "<0.01" : s;
  });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, path: string): string {
  if (typeof v !== "string") throw new AgentHireSidecarError(`${path}: expected string`);
  return v;
}

/** Validate the fields the dashboard shows; throws `AgentHireSidecarError` with the path. */
export function parseAgentHireSummary(raw: unknown): AgentHireSummary {
  if (!isObject(raw)) throw new AgentHireSidecarError("sidecar: expected object");
  if (typeof raw.simulated !== "boolean") throw new AgentHireSidecarError("sidecar.simulated: expected boolean");
  const agenthire = raw.agenthire;
  if (!isObject(agenthire)) throw new AgentHireSidecarError("sidecar.agenthire: expected object");
  const audit = raw.audit;
  if (!isObject(audit)) throw new AgentHireSidecarError("sidecar.audit: expected object");
  if (!Array.isArray(raw.incidents)) throw new AgentHireSidecarError("sidecar.incidents: expected array");
  if (!Array.isArray(raw.honesty)) throw new AgentHireSidecarError("sidecar.honesty: expected array");
  const incidents = raw.incidents.map((i, n) => {
    const path = `sidecar.incidents[${n}]`;
    if (!isObject(i)) throw new AgentHireSidecarError(`${path}: expected object`);
    const report = isObject(i.agentHireReport) ? i.agentHireReport : null;
    const sent = !report
      ? "not sent to AgentHire"
      : report.ok === false
        ? "AgentHire dispute route: failed"
        : `AgentHire dispute route: ${typeof report.status === "string" ? report.status : "answered"} (logged only)`;
    return `${str(i.id, `${path}.id`)} · agent ${String(i.agentId)} · operator ${str(i.deployerWallet, `${path}.deployerWallet`)} · ${sent}`;
  });
  const ladder = isObject(raw.ladder) ? raw.ladder : null;
  return {
    simulated: raw.simulated,
    mode: str(agenthire.mode, "sidecar.agenthire.mode"),
    auditHeadline: roundAmounts(str(audit.headline, "sidecar.audit.headline")),
    incidents,
    freed: ladder && typeof ladder.freed === "string" ? ladder.freed : null,
    honesty: raw.honesty.map((h, n) => str(h, `sidecar.honesty[${n}]`)),
  };
}
