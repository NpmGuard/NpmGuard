import * as fs from "node:fs";
import * as path from "node:path";
import {
  Hypothesis,
  HypothesisGraphSnapshot,
} from "@npmguard/shared";
import type {
  Hypothesis as HypothesisType,
  HypothesisGraphSnapshot as HypothesisGraphSnapshotType,
  HypothesisState as HypothesisStateType,
  EvidenceRef as EvidenceRefType,
  FocusRange as FocusRangeType,
  HypothesisResolution as HypothesisResolutionType,
  ToolCall as ToolCallType,
} from "@npmguard/shared";
import { findDuplicate, DEFAULT_MERGE_THRESHOLD } from "./merge.js";

/**
 * In-memory hypothesis graph with state-machine transitions, persistence, and
 * parent/child linkage. Invariants enforced on every write:
 *  - hypIds are unique within a graph
 *  - parentHypId, if set, must exist in the graph when added
 *  - adding a child hypothesis updates the parent's `childHypIds`
 *  - state transitions obey the rules in `transition()`
 *  - CONFIRMED / REFUTED require at least one evidence ref
 *  - INCONCLUSIVE / DEFERRED require a resolution reason
 *  - terminal states (CONFIRMED, REFUTED, INCONCLUSIVE, DEFERRED) are sticky
 */
const TERMINAL_STATES: ReadonlySet<HypothesisStateType> = new Set<HypothesisStateType>([
  "CONFIRMED",
  "REFUTED",
  "INCONCLUSIVE",
  "DEFERRED",
]);

export class HypothesisGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HypothesisGraphError";
  }
}

export interface TransitionInput {
  to: HypothesisStateType;
  by: string;
  reason?: string;
  evidenceRefs?: EvidenceRefType[];
  resolvedAt?: string;
}

export class HypothesisGraph {
  private readonly nodes = new Map<string, HypothesisType>();
  private readonly nowFn: () => string;
  private createdAt: string;
  private updatedAt: string;

  constructor(
    private readonly auditId: string,
    now: () => string = () => new Date().toISOString(),
  ) {
    this.nowFn = now;
    this.createdAt = this.nowFn();
    this.updatedAt = this.createdAt;
  }

  get size(): number {
    return this.nodes.size;
  }

  get id(): string {
    return this.auditId;
  }

  /** Insert a new hypothesis. Validates schema; updates parent link if present. */
  add(h: HypothesisType): HypothesisType {
    const parsed = Hypothesis.parse(h);

    if (this.nodes.has(parsed.hypId)) {
      throw new HypothesisGraphError(`duplicate hypId: ${parsed.hypId}`);
    }

    if (parsed.parentHypId !== null) {
      const parent = this.nodes.get(parsed.parentHypId);
      if (!parent) {
        throw new HypothesisGraphError(`parent not found: ${parsed.parentHypId}`);
      }
      if (!parent.childHypIds.includes(parsed.hypId)) {
        this.nodes.set(parent.hypId, {
          ...parent,
          childHypIds: [...parent.childHypIds, parsed.hypId],
        });
      }
    }

    this.nodes.set(parsed.hypId, parsed);
    this.updatedAt = this.nowFn();
    return parsed;
  }

  get(hypId: string): HypothesisType {
    const h = this.nodes.get(hypId);
    if (!h) throw new HypothesisGraphError(`hypothesis not found: ${hypId}`);
    return h;
  }

  has(hypId: string): boolean {
    return this.nodes.has(hypId);
  }

  children(hypId: string): HypothesisType[] {
    const h = this.get(hypId);
    return h.childHypIds.map((id) => this.get(id));
  }

  all(): HypothesisType[] {
    return Array.from(this.nodes.values());
  }

  filterByState(state: HypothesisStateType): HypothesisType[] {
    return this.all().filter((h) => h.state === state);
  }

  /**
   * Add a hypothesis, or merge it into an existing near-duplicate (by
   * Jaro-Winkler similarity on `description`). Returns the resulting node
   * plus a flag indicating whether a merge occurred. When merging, only
   * focusFiles and focusLines are unioned into the existing node — state,
   * severity, claim, and evidenceRefs on the existing node are preserved.
   */
  addOrMerge(
    h: HypothesisType,
    threshold: number = DEFAULT_MERGE_THRESHOLD,
  ): { node: HypothesisType; merged: boolean } {
    const parsed = Hypothesis.parse(h);
    const match = findDuplicate(parsed, this.all(), threshold);
    if (!match) {
      return { node: this.add(parsed), merged: false };
    }

    const focusFiles = Array.from(new Set([...match.focusFiles, ...parsed.focusFiles]));
    const rangeKey = (fr: FocusRangeType) => `${fr.file}|${fr.range}`;
    const seen = new Set(match.focusLines.map(rangeKey));
    const merged: FocusRangeType[] = [...match.focusLines];
    for (const fl of parsed.focusLines) {
      if (!seen.has(rangeKey(fl))) {
        merged.push(fl);
        seen.add(rangeKey(fl));
      }
    }

    const updated: HypothesisType = {
      ...match,
      focusFiles,
      focusLines: merged,
    };
    const validated = Hypothesis.parse(updated);
    this.nodes.set(match.hypId, validated);
    this.updatedAt = this.nowFn();
    return { node: validated, merged: true };
  }

  /**
   * Attach the experiment (the ToolCall[] the HYPOTHESIZE pass composed) to a
   * node without changing its state. This is how a runnable experiment reaches
   * a deduped graph node; the orchestrator then routes on its presence.
   */
  setExperiment(hypId: string, experiment: ToolCallType[]): HypothesisType {
    const h = this.get(hypId);
    const parsed = Hypothesis.parse({ ...h, experiment });
    this.nodes.set(hypId, parsed);
    this.updatedAt = this.nowFn();
    return parsed;
  }

  /** Append evidence refs to a hypothesis without changing its state. */
  addEvidence(hypId: string, refs: EvidenceRefType[]): HypothesisType {
    const h = this.get(hypId);
    const updated: HypothesisType = {
      ...h,
      evidenceRefs: [...h.evidenceRefs, ...refs],
    };
    const parsed = Hypothesis.parse(updated);
    this.nodes.set(hypId, parsed);
    this.updatedAt = this.nowFn();
    return parsed;
  }

  /** State-machine transition with invariant checking. Returns the updated node. */
  transition(hypId: string, input: TransitionInput): HypothesisType {
    const h = this.get(hypId);

    if (TERMINAL_STATES.has(h.state)) {
      throw new HypothesisGraphError(
        `cannot transition ${hypId} out of terminal state ${h.state}`,
      );
    }

    const effectiveRefs = input.evidenceRefs
      ? [...h.evidenceRefs, ...input.evidenceRefs]
      : h.evidenceRefs;

    if ((input.to === "CONFIRMED" || input.to === "REFUTED") && effectiveRefs.length === 0) {
      throw new HypothesisGraphError(
        `transition to ${input.to} requires at least one evidenceRef (got 0)`,
      );
    }

    if ((input.to === "INCONCLUSIVE" || input.to === "DEFERRED") && !input.reason) {
      throw new HypothesisGraphError(
        `transition to ${input.to} requires resolution.reason`,
      );
    }

    const now = this.nowFn();
    const terminal = TERMINAL_STATES.has(input.to);
    const resolvedAt = terminal ? (input.resolvedAt ?? now) : null;
    const resolution: HypothesisResolutionType | null = terminal
      ? { reason: input.reason ?? "", by: input.by }
      : null;

    const updated: HypothesisType = {
      ...h,
      state: input.to,
      evidenceRefs: effectiveRefs,
      resolvedAt,
      resolution,
    };

    const parsed = Hypothesis.parse(updated);
    this.nodes.set(hypId, parsed);
    this.updatedAt = now;
    return parsed;
  }

  serialize(): HypothesisGraphSnapshotType {
    const snapshot: HypothesisGraphSnapshotType = {
      version: 1,
      auditId: this.auditId,
      nodes: this.all(),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
    return HypothesisGraphSnapshot.parse(snapshot);
  }

  /** Replace in-memory state from a snapshot. Validates schema. */
  static load(
    snapshot: HypothesisGraphSnapshotType,
    now?: () => string,
  ): HypothesisGraph {
    const parsed = HypothesisGraphSnapshot.parse(snapshot);
    const g = new HypothesisGraph(parsed.auditId, now);
    g.createdAt = parsed.createdAt;
    g.updatedAt = parsed.updatedAt;
    for (const node of parsed.nodes) {
      g.nodes.set(node.hypId, node);
    }
    return g;
  }

  /** Persist to disk as JSON. Parent directories are created if missing. */
  saveTo(filePath: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(this.serialize(), null, 2), "utf-8");
  }

  static loadFrom(filePath: string, now?: () => string): HypothesisGraph {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as HypothesisGraphSnapshotType;
    return HypothesisGraph.load(parsed, now);
  }
}
