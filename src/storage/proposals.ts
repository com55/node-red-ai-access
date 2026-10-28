/**
 * Proposal JSON store under `.ai-access/proposals/`.
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

import type { FlowTab } from '../runtime/types.js';

import type { AiAccessPaths } from './paths.js';
import {
  assertSafeProposalId,
  assertSafeSegment,
  resolveUnderDir,
  sanitizeFlowTab,
} from './safe.js';
import { MAX_PROPOSAL_JSON_BYTES, encodeTrustedJson, writeTrustedAtomic } from './trusted-write.js';

export type ProposalStatus =
  | 'pending'
  | 'conflict'
  | 'approved'
  | 'rejected'
  | 'failed'
  | 'withdrawn'
  | 'expired'
  | 'superseded';

/** Open = still awaiting a decision (`conflict` is pending with approve blocked). */
export function isOpenProposalStatus(status: ProposalStatus): boolean {
  return status === 'pending' || status === 'conflict';
}

/** One stored rebase conflict (field paths only, including env names / credential keys; never values). */
export interface StoredRebaseConflict {
  kind: string;
  nodeId?: string;
  nodeType?: string;
  nodeName?: string;
  fields?: string[];
  message: string;
  choices: ('live' | 'proposed')[];
}

/** Result of the last auto-rebase check against the live flows. */
export interface ProposalRebaseInfo {
  /** Live rev the check ran against. */
  rev: string;
  state: 'clean' | 'merged' | 'conflict';
  /** Hash of the tab approve would deploy (absent on conflict). */
  mergedHash?: string;
  conflicts: StoredRebaseConflict[];
  /** Nodes (or the tab) changed live since the base snapshot. */
  liveChangedCount: number;
  checkedAt: string;
}

export type ProposalType = 'replace_flow';

export interface AccessLinkProposalCreator {
  kind: 'access-link';
  linkId: string;
  label?: string;
}
export type ProposalCreator =
  AccessLinkProposalCreator | { kind: 'oauth'; clientId: string; user: string };

export function oauthOwnerId(clientId: string, user: string): string {
  return `oauth-${createHash('sha256').update(`${clientId}\0${user}`).digest('hex')}`;
}

export function proposalOwnerId(creator: ProposalCreator): string {
  return creator.kind === 'oauth' ? oauthOwnerId(creator.clientId, creator.user) : creator.linkId;
}

export type ProposalDecisionBy =
  { kind: 'admin'; username?: string } | { kind: 'access-link'; linkId: string; label?: string };

export interface ReplaceFlowPayload {
  flowId: string;
  flow: Partial<FlowTab>;
}

/** Soft validation notes stored with a proposal (scaffold gaps, not hard errors). */
export interface ProposalWarning {
  code: string;
  error: string;
  nodeId?: string;
  type?: string;
  property?: string;
  configType?: string;
  candidates?: string[];
}

export interface Proposal {
  id: string;
  type: ProposalType;
  status: ProposalStatus;
  expectedRev: string;
  payload: ReplaceFlowPayload;
  /**
   * Flow tab snapshot at `expectedRev` when the proposal was submitted.
   * Diffs compare `payload.flow` against this base (not the live flow).
   * Optional on legacy proposals created before this field existed.
   */
  baseFlow?: Partial<FlowTab>;
  /**
   * Soft validation notes from submit (missing config, unwired nodes, …).
   * Never blocks approve — AI may scaffold first; humans configure later.
   */
  warnings?: ProposalWarning[];
  /** Fields whose `[REDACTED]` placeholder was restored to the live secret at submit. */
  restoredSecrets?: { nodeId: string; property: string }[];
  /** Persisted while a timed-out runtime deployment has an unknown outcome. */
  deployPending?: { mergedHash: string; reason: string; queueReleased?: boolean };
  /** Last auto-rebase result (pending / conflict proposals). */
  rebase?: ProposalRebaseInfo;
  /** Latest manual resolution, retained for admin undo until the next body edit. */
  conflictChoice?: {
    nodeId: string;
    choice: 'live' | 'proposed';
    undo?: {
      baseFlow: Partial<FlowTab>;
      flow: Partial<FlowTab>;
      warnings: ProposalWarning[];
    };
  };
  /**
   * Short human title (≤80 chars). Set at submit (AI-supplied or auto-generated).
   * Optional on legacy proposals; API responses always resolve a title.
   */
  title?: string;
  createdBy: ProposalCreator;
  createdAt: string;
  updatedAt: string;
  decidedBy?: ProposalDecisionBy;
  reason?: string;
  resultRev?: string;
}

export interface CreateProposalInput {
  type: ProposalType;
  expectedRev: string;
  payload: ReplaceFlowPayload;
  /** Live flow tab at expectedRev (stored for stable diffs). */
  baseFlow: Partial<FlowTab>;
  createdBy: ProposalCreator;
  /** Sanitized short title (≤80 chars). */
  title: string;
  /** Soft validation notes to persist with the proposal. */
  warnings?: ProposalWarning[];
  restoredSecrets?: { nodeId: string; property: string }[];
}

export class ProposalNotFoundError extends Error {
  readonly code = 'proposal_not_found' as const;
  readonly statusCode = 404;
  constructor(id: string) {
    super(`Proposal '${id}' was not found`);
    this.name = 'ProposalNotFoundError';
  }
}

export class ProposalNotPendingError extends Error {
  readonly code = 'proposal_not_pending' as const;
  readonly statusCode = 409;
  constructor(id: string, status: ProposalStatus) {
    super(`Proposal '${id}' is '${status}', not pending`);
    this.name = 'ProposalNotPendingError';
  }
}

export class ProposalNotOwnedError extends Error {
  readonly code = 'proposal_not_owned' as const;
  readonly statusCode = 403;
  constructor(id: string) {
    super(`Proposal '${id}' was not created by this access link`);
    this.name = 'ProposalNotOwnedError';
  }
}

export class ProposalConcurrentApproveError extends Error {
  readonly code = 'proposal_approve_in_progress' as const;
  readonly statusCode = 409;
  constructor(id: string) {
    super(`Proposal '${id}' is already being approved`);
    this.name = 'ProposalConcurrentApproveError';
  }
}

function isProposalStatus(value: unknown): value is ProposalStatus {
  return (
    value === 'pending' ||
    value === 'conflict' ||
    value === 'approved' ||
    value === 'rejected' ||
    value === 'failed' ||
    value === 'withdrawn' ||
    value === 'expired' ||
    value === 'superseded'
  );
}

const MAX_STORED_WARNINGS = 50;

function cleanText(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0
    ? value.replace(/\0/g, '').slice(0, max)
    : undefined;
}

function sanitizeRebaseInfo(raw: unknown): ProposalRebaseInfo | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const rev = cleanText(obj.rev, 200);
  const state = obj.state;
  if (!rev || (state !== 'clean' && state !== 'merged' && state !== 'conflict')) return undefined;
  const conflicts: StoredRebaseConflict[] = [];
  if (Array.isArray(obj.conflicts)) {
    for (const entry of obj.conflicts.slice(0, 200)) {
      if (!entry || typeof entry !== 'object') continue;
      const c = entry as Record<string, unknown>;
      const kind = cleanText(c.kind, 64);
      const message = cleanText(c.message, 500);
      if (!kind || !message) continue;
      const out: StoredRebaseConflict = {
        kind,
        message,
        choices: Array.isArray(c.choices)
          ? (c.choices.filter(x => x === 'live' || x === 'proposed') as ('live' | 'proposed')[])
          : [],
      };
      const nodeId = cleanText(c.nodeId, 200);
      if (nodeId) out.nodeId = nodeId;
      const nodeType = cleanText(c.nodeType, 200);
      if (nodeType) out.nodeType = nodeType;
      const nodeName = cleanText(c.nodeName, 120);
      if (nodeName) out.nodeName = nodeName;
      if (Array.isArray(c.fields)) {
        out.fields = c.fields
          .filter((f): f is string => typeof f === 'string' && f.length > 0)
          .slice(0, 100)
          .map(f => f.replace(/\0/g, '').slice(0, 200));
      }
      conflicts.push(out);
    }
  }
  const info: ProposalRebaseInfo = {
    rev,
    state,
    conflicts,
    liveChangedCount:
      typeof obj.liveChangedCount === 'number' && Number.isFinite(obj.liveChangedCount)
        ? Math.max(0, Math.floor(obj.liveChangedCount))
        : 0,
    checkedAt: cleanText(obj.checkedAt, 64) ?? '',
  };
  const mergedHash = cleanText(obj.mergedHash, 64);
  if (mergedHash && /^[0-9a-f]+$/.test(mergedHash)) info.mergedHash = mergedHash;
  return info;
}

export class ProposalConflictError extends Error {
  readonly code = 'proposal_conflict' as const;
  readonly statusCode = 409;
  readonly conflicts: StoredRebaseConflict[];
  constructor(id: string, conflicts: StoredRebaseConflict[]) {
    super(
      `Proposal '${id}' conflicts with changes made in the editor since it was submitted; ` +
        'resolve the conflicts before approving.'
    );
    this.name = 'ProposalConflictError';
    this.conflicts = conflicts;
  }
}

/** Field references only (node id + path), never values. */
function sanitizeRestoredSecrets(raw: unknown): { nodeId: string; property: string }[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: { nodeId: string; property: string }[] = [];
  for (const entry of raw.slice(0, 200)) {
    if (!entry || typeof entry !== 'object') continue;
    const { nodeId, property } = entry as Record<string, unknown>;
    if (typeof nodeId !== 'string' || typeof property !== 'string') continue;
    out.push({
      nodeId: nodeId.replace(/\0/g, '').slice(0, 200),
      property: property.replace(/\0/g, '').slice(0, 200),
    });
  }
  return out.length > 0 ? out : undefined;
}

/** Keep only safe string fields from a soft-validation warning for disk. */
function sanitizeProposalWarnings(raw: unknown): ProposalWarning[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) {
    return undefined;
  }
  const out: ProposalWarning[] = [];
  for (const entry of raw.slice(0, MAX_STORED_WARNINGS)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const obj = entry as Record<string, unknown>;
    if (typeof obj.code !== 'string' || !obj.code || typeof obj.error !== 'string' || !obj.error) {
      continue;
    }
    const warning: ProposalWarning = {
      code: obj.code.replace(/\0/g, '').slice(0, 80),
      error: obj.error.replace(/\0/g, '').slice(0, 500),
    };
    if (typeof obj.nodeId === 'string' && obj.nodeId) {
      warning.nodeId = obj.nodeId.replace(/\0/g, '').slice(0, 200);
    }
    if (typeof obj.type === 'string' && obj.type) {
      warning.type = obj.type.replace(/\0/g, '').slice(0, 200);
    }
    if (typeof obj.property === 'string' && obj.property) {
      warning.property = obj.property.replace(/\0/g, '').slice(0, 200);
    }
    if (typeof obj.configType === 'string' && obj.configType) {
      warning.configType = obj.configType.replace(/\0/g, '').slice(0, 200);
    }
    if (Array.isArray(obj.candidates)) {
      warning.candidates = obj.candidates
        .filter((c): c is string => typeof c === 'string' && c.length > 0)
        .slice(0, 20)
        .map(c => c.replace(/\0/g, '').slice(0, 200));
    }
    out.push(warning);
  }
  return out.length > 0 ? out : undefined;
}

export class ProposalStore {
  private readonly inFlight = new Set<string>();
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly maxProposalBytes: number;

  constructor(
    private readonly paths: AiAccessPaths,
    options: {
      now?: () => number;
      randomId?: () => string;
      maxProposalBytes?: number;
    } = {}
  ) {
    this.now = options.now ?? (() => Date.now());
    this.randomId = options.randomId ?? (() => randomBytes(12).toString('hex'));
    this.maxProposalBytes = options.maxProposalBytes ?? MAX_PROPOSAL_JSON_BYTES;
  }

  private fileFor(id: string): string {
    let safeId: string;
    try {
      safeId = assertSafeProposalId(id);
    } catch {
      throw new ProposalNotFoundError(id);
    }
    return resolveUnderDir(this.paths.proposals, `${safeId}.json`);
  }

  /** Rebuild a proposal record so only validated fields are written to disk. */
  private toDiskRecord(proposal: Proposal): Proposal {
    const id = assertSafeProposalId(proposal.id);
    const expectedRev = assertSafeSegment(
      String(proposal.expectedRev).slice(0, 200),
      'expectedRev'
    );
    const flowId = assertSafeSegment(String(proposal.payload.flowId).slice(0, 200), 'flowId');
    const flow = sanitizeFlowTab(proposal.payload.flow) as Partial<FlowTab>;
    const baseFlow =
      proposal.baseFlow !== undefined
        ? (sanitizeFlowTab(proposal.baseFlow) as Partial<FlowTab>)
        : undefined;

    const createdBy: ProposalCreator =
      proposal.createdBy.kind === 'oauth'
        ? {
            kind: 'oauth',
            clientId: assertSafeSegment(
              String(proposal.createdBy.clientId).slice(0, 200),
              'clientId'
            ),
            user: String(proposal.createdBy.user).replace(/\0/g, '').slice(0, 200),
          }
        : {
            kind: 'access-link',
            linkId: assertSafeSegment(String(proposal.createdBy.linkId).slice(0, 200), 'linkId'),
            ...(typeof proposal.createdBy.label === 'string'
              ? { label: proposal.createdBy.label.replace(/\0/g, '').slice(0, 200) }
              : {}),
          };

    const record: Proposal = {
      id,
      type: 'replace_flow',
      status: isProposalStatus(proposal.status) ? proposal.status : 'pending',
      expectedRev,
      payload: { flowId, flow },
      createdBy,
      createdAt: String(proposal.createdAt).slice(0, 64),
      updatedAt: String(proposal.updatedAt).slice(0, 64),
    };
    if (baseFlow !== undefined) {
      record.baseFlow = baseFlow;
    }
    if (typeof proposal.title === 'string' && proposal.title.length > 0) {
      record.title = proposal.title.replace(/\0/g, '').slice(0, 80).trim();
      if (!record.title) {
        delete record.title;
      }
    }
    const warnings = sanitizeProposalWarnings(proposal.warnings);
    if (warnings) {
      record.warnings = warnings;
    }
    const restored = sanitizeRestoredSecrets(proposal.restoredSecrets);
    if (restored) {
      record.restoredSecrets = restored;
    }
    if (proposal.deployPending && isOpenProposalStatus(record.status)) {
      const mergedHash = cleanText(proposal.deployPending.mergedHash, 64);
      const reason = cleanText(proposal.deployPending.reason, 500);
      if (mergedHash && /^[0-9a-f]+$/.test(mergedHash) && reason) {
        record.deployPending = { mergedHash, reason };
        if (proposal.deployPending.queueReleased === true)
          record.deployPending.queueReleased = true;
      }
    }
    const choice = proposal.conflictChoice;
    if (
      choice &&
      isOpenProposalStatus(record.status) &&
      (choice.choice === 'live' || choice.choice === 'proposed') &&
      typeof choice.nodeId === 'string' &&
      choice.undo
    ) {
      record.conflictChoice = {
        nodeId: choice.nodeId.replace(/\0/g, '').slice(0, 200),
        choice: choice.choice,
        undo: {
          baseFlow: sanitizeFlowTab(choice.undo.baseFlow),
          flow: sanitizeFlowTab(choice.undo.flow),
          warnings: sanitizeProposalWarnings(choice.undo.warnings) ?? [],
        },
      };
    }
    const rebase = sanitizeRebaseInfo(proposal.rebase);
    if (rebase && isOpenProposalStatus(record.status)) {
      record.rebase = rebase;
    } else if (rebase && rebase.state !== 'conflict') {
      // Keep the last clean/merged check on decided records (audit context).
      record.rebase = rebase;
    }

    if (proposal.decidedBy) {
      if (proposal.decidedBy.kind === 'access-link') {
        const decidedBy: ProposalDecisionBy = {
          kind: 'access-link',
          linkId: assertSafeSegment(String(proposal.decidedBy.linkId).slice(0, 200), 'linkId'),
        };
        if (typeof proposal.decidedBy.label === 'string') {
          decidedBy.label = proposal.decidedBy.label.replace(/\0/g, '').slice(0, 200);
        }
        record.decidedBy = decidedBy;
      } else {
        const decidedBy: ProposalDecisionBy = { kind: 'admin' };
        if (typeof proposal.decidedBy.username === 'string') {
          decidedBy.username = proposal.decidedBy.username.replace(/\0/g, '').slice(0, 200);
        }
        record.decidedBy = decidedBy;
      }
    }
    if (typeof proposal.reason === 'string') {
      record.reason = proposal.reason.replace(/\0/g, '').slice(0, 2_000);
    }
    if (typeof proposal.resultRev === 'string') {
      record.resultRev = assertSafeSegment(proposal.resultRev.slice(0, 200), 'resultRev');
    }
    return record;
  }

  private writeAtomic(id: string, proposal: Proposal): void {
    const target = this.fileFor(id);
    const disk = this.toDiskRecord(proposal);
    const payload = encodeTrustedJson(disk, this.maxProposalBytes, {
      kind: 'proposal',
      pretty: true,
    });
    writeTrustedAtomic(this.paths.root, target, payload);
  }

  create(input: CreateProposalInput): Proposal {
    const at = new Date(this.now()).toISOString();
    const id = assertSafeProposalId(`prop-${this.randomId()}`);
    const proposal: Proposal = {
      id,
      type: 'replace_flow',
      status: 'pending',
      expectedRev: input.expectedRev,
      payload: {
        flowId: input.payload.flowId,
        flow: input.payload.flow,
      },
      baseFlow: input.baseFlow,
      title: input.title,
      createdBy: input.createdBy,
      createdAt: at,
      updatedAt: at,
    };
    const warnings = sanitizeProposalWarnings(input.warnings);
    if (warnings) {
      proposal.warnings = warnings;
    }
    if (input.restoredSecrets?.length) {
      proposal.restoredSecrets = input.restoredSecrets;
    }
    this.writeAtomic(id, proposal);
    return this.get(id);
  }

  get(id: string): Proposal {
    const path = this.fileFor(id);
    if (!existsSync(path)) {
      throw new ProposalNotFoundError(id);
    }
    return JSON.parse(readFileSync(path, 'utf8')) as Proposal;
  }

  list(filter?: { linkId?: string; status?: ProposalStatus; flowId?: string }): Proposal[] {
    if (!existsSync(this.paths.proposals)) {
      return [];
    }
    const files = readdirSync(this.paths.proposals).filter(name => name.endsWith('.json'));
    const proposals: Proposal[] = [];
    for (const file of files) {
      const base = basename(file);
      if (base !== file || base.includes('..')) {
        continue;
      }
      try {
        const proposal = JSON.parse(
          readFileSync(resolveUnderDir(this.paths.proposals, base), 'utf8')
        ) as Proposal;
        if (filter?.linkId && proposalOwnerId(proposal.createdBy) !== filter.linkId) {
          continue;
        }
        if (filter?.status && proposal.status !== filter.status) {
          continue;
        }
        if (filter?.flowId && proposal.payload.flowId !== filter.flowId) {
          continue;
        }
        proposals.push(proposal);
      } catch {
        // skip corrupt / unsafe
      }
    }
    return proposals.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /**
   * Begin an approve attempt. Throws if another approve is in flight or status
   * is not pending. Caller must call finishApprove / failApprove / releaseLock.
   */
  beginApprove(id: string): Proposal {
    if (this.inFlight.has(id)) {
      throw new ProposalConcurrentApproveError(id);
    }
    const proposal = this.get(id);
    if (!isOpenProposalStatus(proposal.status)) {
      throw new ProposalNotPendingError(id, proposal.status);
    }
    this.inFlight.add(id);
    return proposal;
  }

  releaseLock(id: string): void {
    this.inFlight.delete(id);
  }

  recordDeployPending(id: string, pending: Proposal['deployPending']): Proposal {
    const proposal = this.get(id);
    if (!isOpenProposalStatus(proposal.status)) {
      throw new ProposalNotPendingError(id, proposal.status);
    }
    if (pending) proposal.deployPending = pending;
    else delete proposal.deployPending;
    proposal.status = 'pending';
    proposal.updatedAt = new Date(this.now()).toISOString();
    this.writeAtomic(id, proposal);
    return this.get(id);
  }

  markApproved(id: string, decidedBy: ProposalDecisionBy, resultRev: string): Proposal {
    const proposal = this.get(id);
    proposal.status = 'approved';
    delete proposal.deployPending;
    proposal.decidedBy = decidedBy;
    proposal.resultRev = resultRev;
    proposal.updatedAt = new Date(this.now()).toISOString();
    this.writeAtomic(id, proposal);
    return this.get(id);
  }

  markRejected(id: string, decidedBy: ProposalDecisionBy | undefined, reason: string): Proposal {
    if (this.inFlight.has(id)) throw new ProposalConcurrentApproveError(id);
    const proposal = this.get(id);
    proposal.status = 'rejected';
    if (decidedBy) {
      proposal.decidedBy = decidedBy;
    }
    proposal.reason = reason;
    proposal.updatedAt = new Date(this.now()).toISOString();
    this.writeAtomic(id, proposal);
    return this.get(id);
  }

  markFailed(id: string, decidedBy: ProposalDecisionBy | undefined, reason: string): Proposal {
    const proposal = this.get(id);
    proposal.status = 'failed';
    if (decidedBy) {
      proposal.decidedBy = decidedBy;
    }
    proposal.reason = reason;
    proposal.updatedAt = new Date(this.now()).toISOString();
    this.writeAtomic(id, proposal);
    return this.get(id);
  }

  markWithdrawn(id: string, decidedBy: ProposalDecisionBy, reason: string): Proposal {
    if (this.inFlight.has(id)) throw new ProposalConcurrentApproveError(id);
    const proposal = this.get(id);
    if (!isOpenProposalStatus(proposal.status)) {
      throw new ProposalNotPendingError(id, proposal.status);
    }
    proposal.status = 'withdrawn';
    proposal.decidedBy = decidedBy;
    proposal.reason = reason;
    proposal.updatedAt = new Date(this.now()).toISOString();
    this.writeAtomic(id, proposal);
    return this.get(id);
  }

  /**
   * Auto-close a pending proposal that can no longer be approved
   * (`expired` = pending longer than the proposal TTL).
   */
  markClosed(
    id: string,
    status: 'expired' | 'superseded',
    reason: string,
    decidedBy?: ProposalDecisionBy
  ): Proposal {
    const proposal = this.get(id);
    if (!isOpenProposalStatus(proposal.status)) {
      throw new ProposalNotPendingError(id, proposal.status);
    }
    proposal.status = status;
    if (decidedBy) {
      proposal.decidedBy = decidedBy;
    }
    proposal.reason = reason;
    proposal.updatedAt = new Date(this.now()).toISOString();
    this.writeAtomic(id, proposal);
    return this.get(id);
  }

  /**
   * Store the latest rebase check and flip `pending` ↔ `conflict`.
   * No-op (no write) when nothing changed. Skips decided or in-flight records.
   */
  recordRebase(id: string, info: ProposalRebaseInfo): Proposal {
    const proposal = this.get(id);
    if (!isOpenProposalStatus(proposal.status)) {
      return proposal;
    }
    const nextStatus: ProposalStatus = info.state === 'conflict' ? 'conflict' : 'pending';
    const prev = proposal.rebase;
    const same =
      proposal.status === nextStatus &&
      prev !== undefined &&
      prev.rev === info.rev &&
      prev.state === info.state &&
      prev.mergedHash === info.mergedHash &&
      prev.liveChangedCount === info.liveChangedCount &&
      JSON.stringify(prev.conflicts) === JSON.stringify(info.conflicts);
    if (same) {
      return proposal;
    }
    proposal.status = nextStatus;
    proposal.rebase = info;
    proposal.updatedAt = new Date(this.now()).toISOString();
    this.writeAtomic(id, proposal);
    return this.get(id);
  }

  /**
   * Replace an open proposal's base snapshot and/or body (conflict resolution).
   * Status returns to `pending`; the caller re-runs the rebase.
   */
  updateBody(
    id: string,
    update: {
      baseFlow: Partial<FlowTab>;
      flow: Partial<FlowTab>;
      expectedRev?: string;
      title?: string;
      restoredSecrets?: { nodeId: string; property: string }[];
      warnings?: ProposalWarning[];
      conflictChoice?: Proposal['conflictChoice'];
    }
  ): Proposal {
    const proposal = this.get(id);
    if (!isOpenProposalStatus(proposal.status)) {
      throw new ProposalNotPendingError(id, proposal.status);
    }
    if (this.inFlight.has(id)) {
      throw new ProposalConcurrentApproveError(id);
    }
    proposal.baseFlow = update.baseFlow;
    proposal.payload = { flowId: proposal.payload.flowId, flow: update.flow };
    if (update.expectedRev !== undefined) proposal.expectedRev = update.expectedRev;
    if (update.title !== undefined) proposal.title = update.title;
    if (update.restoredSecrets !== undefined) {
      if (update.restoredSecrets.length > 0) proposal.restoredSecrets = update.restoredSecrets;
      else delete proposal.restoredSecrets;
    }
    if (update.warnings !== undefined) {
      if (update.warnings.length > 0) proposal.warnings = update.warnings;
      else delete proposal.warnings;
    }
    if (update.conflictChoice) proposal.conflictChoice = update.conflictChoice;
    else delete proposal.conflictChoice;
    proposal.status = 'pending';
    delete proposal.rebase;
    proposal.updatedAt = new Date(this.now()).toISOString();
    this.writeAtomic(id, proposal);
    return this.get(id);
  }

  /** True while an approve holds this proposal's lock. */
  isApproving(id: string): boolean {
    return this.inFlight.has(id);
  }
}
