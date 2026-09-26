/**
 * The operator's record: where the fund book's stop-outs meet the screening
 * of anything NEW that goes to that operator.
 *
 *   runBook(..., { incidents: new StopOutIncidentSink({ ledger }) })
 *        │  one "stop-out" incident per STOP_OUT, keyed by the agent's operator
 *        ▼
 *   IncidentLedger  (in memory, or a JsonFileIncidentStore other processes read)
 *        │
 *        ├─► OperatorGrantScreen.grant()        a NEW mandate in a fund's tree
 *        └─► AgentHireScreeningService.screen() a NEW hire on AgentHire
 *
 * The book (`@allowance/swarm`) defines the port (`IncidentSink`); this module
 * implements it. Swarm does not depend on adapters.
 *
 * A stop-out is a LOSS, not misconduct: the agent's own drawdown reached its
 * stop and its mandate was closed. It is recorded Allowance-side only, is
 * never sent to AgentHire's dispute route, and never slashes anything. It is
 * counted apart from misconduct incidents (e.g. `mandate_overspend`), under
 * its own limit: one stop-out is ordinary attrition, a run of them across an
 * operator's names is a record a new grant should not ignore.
 *
 * A refusal takes nothing back. What the operator already runs is the book's
 * business (its ladder, its operator cap); this only stops something new.
 */
import type { AgentNode, DelegateOptions, DelegationTree, MandateInput, ScreeningResult } from "@allowance/core";
import type { IncidentSink, StopOutIncident } from "@allowance/swarm";
import type { AllowanceIncident, IncidentLedger, OperatorBinding } from "./agenthire";

/** The `kind` a fund stop-out is recorded under: the book's own (`StopOutIncident["kind"]`). */
export const STOP_OUT_KIND: StopOutIncident["kind"] = "stop-out";

/** Default: one misconduct incident against the operator refuses (unchanged from before stop-outs were recorded). */
export const DEFAULT_MAX_OPERATOR_INCIDENTS = 0;
/** Default: two stop-outs are accepted, the third refuses (AgentHire bans on an agent's 3rd incident too). */
export const DEFAULT_MAX_OPERATOR_STOP_OUTS = 2;

export interface OperatorRecordLimits {
  /** Most incidents that are NOT stop-outs accepted. Default `DEFAULT_MAX_OPERATOR_INCIDENTS`. */
  maxIncidents?: number | undefined;
  /** Most fund stop-outs accepted. Default `DEFAULT_MAX_OPERATOR_STOP_OUTS`. */
  maxStopOuts?: number | undefined;
}

function limit(x: number | undefined, fallback: number, what: string): number {
  const v = x ?? fallback;
  if (!(v >= 0) || !(Number.isInteger(v) || v === Infinity)) throw new RangeError(`${what} must be a whole number ≥ 0, got ${x}`);
  return v;
}

/** Resolve limits once (validated): refusing on a garbled threshold beats silently never refusing. */
export function operatorRecordLimits(limits: OperatorRecordLimits = {}): Required<{ [K in keyof OperatorRecordLimits]: number }> {
  return {
    maxIncidents: limit(limits.maxIncidents, DEFAULT_MAX_OPERATOR_INCIDENTS, "maxIncidents"),
    maxStopOuts: limit(limits.maxStopOuts, DEFAULT_MAX_OPERATOR_STOP_OUTS, "maxStopOuts"),
  };
}

/** Where an incident happened, for a refusal message: the book agent, else the AgentHire agent id. */
function whereOf(i: AllowanceIncident): string {
  return i.agent ?? `agent ${i.agentId}`;
}

/**
 * Why an operator with these incidents (its own, e.g. `ledger.forOperator`)
 * is refused under `limits`, or null when it is not. Misconduct is checked
 * first; stop-outs are counted apart.
 */
export function operatorRecordRefusal(incidents: readonly AllowanceIncident[], limits: OperatorRecordLimits = {}): string | null {
  const { maxIncidents, maxStopOuts } = operatorRecordLimits(limits);
  const misconduct = incidents.filter((i) => i.kind !== STOP_OUT_KIND);
  if (misconduct.length > maxIncidents) {
    const where = [...new Set(misconduct.map(whereOf))].join(", ");
    return `has ${misconduct.length} Allowance incident(s) (${where}) > ${maxIncidents} allowed`;
  }
  const stopOuts = incidents.filter((i) => i.kind === STOP_OUT_KIND);
  if (stopOuts.length > maxStopOuts) {
    const where = [...new Set(stopOuts.map(whereOf))].join(", ");
    return `has ${stopOuts.length} fund stop-out(s) (${where}) > ${maxStopOuts} allowed`;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* The book's port                                                    */
/* ------------------------------------------------------------------ */

export interface StopOutIncidentSinkConfig {
  ledger: IncidentLedger;
  /**
   * The operator binding a stop-out is filed under. Default: the book's
   * `operator` IS the counterparty key (in production `AgentSpec.operator` is
   * the operator's World ID nullifier), with no AgentHire agent id (0) and no
   * wallet. Return undefined to refuse (the sink then throws).
   */
  bindingOf?: (incident: StopOutIncident) => OperatorBinding | undefined | Promise<OperatorBinding | undefined>;
}

/**
 * The adapters' implementation of the book's `IncidentSink`: files each
 * stop-out in an `IncidentLedger` as ONE incident of kind "stop-out", keyed by
 * the agent's operator, carrying the agent, the tick and the authority the
 * close freed. It never sends anything to AgentHire and never slashes.
 *
 * A stop-out whose agent has no operator throws: an operator record that
 * files incidents under a guessed key would either shield the operator or
 * blame another. (Give every agent an operator, or a `bindingOf` that knows.)
 */
export class StopOutIncidentSink implements IncidentSink {
  private readonly config: StopOutIncidentSinkConfig;
  /** The incidents this sink filed, in order. */
  readonly filed: AllowanceIncident[] = [];

  constructor(config: StopOutIncidentSinkConfig) {
    this.config = config;
  }

  async record(incident: StopOutIncident): Promise<void> {
    if (incident.kind !== STOP_OUT_KIND) throw new Error(`StopOutIncidentSink: not a stop-out: ${String(incident.kind)}`);
    const binding = this.config.bindingOf
      ? await this.config.bindingOf(incident)
      : incident.operator !== undefined && incident.operator !== ""
        ? { agentId: 0, deployerWallet: "", worldIdNullifier: incident.operator, simulated: true }
        : undefined;
    if (!binding) {
      throw new Error(`StopOutIncidentSink: ${incident.agent} was stopped out at tick ${incident.tick} but has no operator to file it under`);
    }
    const filed = await this.config.ledger.record(binding, {
      kind: STOP_OUT_KIND,
      reason:
        `stopped out at a ${(incident.drawdown * 100).toFixed(1)}% drawdown (stop ${(incident.ddStop * 100).toFixed(1)}%): ` +
        `${incident.reason} (a loss, not misconduct; nothing slashed)`,
      node: incident.agent,
      agent: incident.agent,
      tick: incident.tick,
      freed: incident.freed,
      at: incident.at,
    });
    this.filed.push(filed);
  }
}

/* ------------------------------------------------------------------ */
/* New grants                                                         */
/* ------------------------------------------------------------------ */

export interface OperatorGrantScreenConfig extends OperatorRecordLimits {
  incidents: IncidentLedger;
}

export type GrantResult =
  | { granted: true; node: AgentNode; screening: ScreeningResult }
  | { granted: false; screening: ScreeningResult };

/**
 * Screens a NEW grant (a mandate for an agent run by `operator`) against the
 * operator's record. It re-reads the ledger on every check (another process,
 * or an earlier run, may have filed a stop-out since) and fails closed when
 * the record cannot be read.
 */
export class OperatorGrantScreen {
  private readonly incidents: IncidentLedger;
  private readonly limits: ReturnType<typeof operatorRecordLimits>;

  constructor(config: OperatorGrantScreenConfig) {
    this.incidents = config.incidents;
    this.limits = operatorRecordLimits(config);
  }

  async screen(operator: string): Promise<ScreeningResult> {
    const reference = `operator-record:${operator}`;
    if (!operator) return { approved: false, reason: "grant screening: no operator named", reference };
    try {
      await this.incidents.sync();
    } catch (err) {
      return {
        approved: false,
        reason: `grant screening: incident record ${this.incidents.location} unreadable: ${err instanceof Error ? err.message : String(err)}`,
        reference,
      };
    }
    const mine = this.incidents.forOperator(operator);
    const refusal = operatorRecordRefusal(mine, this.limits);
    if (refusal) return { approved: false, reason: `grant screening: operator ${operator} ${refusal}`, reference };
    return { approved: true, reason: `cleared: operator ${operator} has ${mine.length} Allowance incident(s) on record`, reference };
  }

  /**
   * Delegate `childLabel` under `parentName` for an agent run by `operator`,
   * only if the operator's record clears. A refused grant creates no node and
   * reserves nothing; a cleared one is an ordinary `tree.delegate` (which can
   * still refuse on attenuation).
   */
  async grant(
    tree: DelegationTree,
    parentName: string,
    childLabel: string,
    mandate: MandateInput,
    operator: string,
    opts?: DelegateOptions,
  ): Promise<GrantResult> {
    const screening = await this.screen(operator);
    if (!screening.approved) return { granted: false, screening };
    return { granted: true, node: tree.delegate(parentName, childLabel, mandate, opts), screening };
  }
}
