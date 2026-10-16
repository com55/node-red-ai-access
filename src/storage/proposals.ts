/**
 * Proposal JSON store under `.ai-access/proposals/`.
 */

import { randomBytes } from 'node:crypto';
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
  'pending' | 'approved' | 'rejected' | 'failed' | 'withdrawn' | 'expired' | 'superseded';

export type ProposalType = 'replace_flow';

export interface ProposalCreator {
  kind: 'access-link';
  linkId: string;
  label?: string;
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
    value === 'approved' ||
    value === 'rejected' ||
    value === 'failed' ||
    value === 'withdrawn' ||
    value === 'expired' ||
    value === 'superseded'
  );
}

const MAX_STORED_WARNINGS = 50;

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

    const createdBy: ProposalCreator = {
      kind: 'access-link',
      linkId: assertSafeSegment(String(proposal.createdBy.linkId).slice(0, 200), 'linkId'),
    };
    if (typeof proposal.createdBy.label === 'string') {
      createdBy.label = proposal.createdBy.label.replace(/\0/g, '').slice(0, 200);
    }

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

  list(filter?: { linkId?: string }): Proposal[] {
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
        if (filter?.linkId && proposal.createdBy.linkId !== filter.linkId) {
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
    if (proposal.status !== 'pending') {
      throw new ProposalNotPendingError(id, proposal.status);
    }
    this.inFlight.add(id);
    return proposal;
  }

  releaseLock(id: string): void {
    this.inFlight.delete(id);
  }

  markApproved(id: string, decidedBy: ProposalDecisionBy, resultRev: string): Proposal {
    const proposal = this.get(id);
    proposal.status = 'approved';
    proposal.decidedBy = decidedBy;
    proposal.resultRev = resultRev;
    proposal.updatedAt = new Date(this.now()).toISOString();
    this.writeAtomic(id, proposal);
    return this.get(id);
  }

  markRejected(id: string, decidedBy: ProposalDecisionBy | undefined, reason: string): Proposal {
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
    const proposal = this.get(id);
    if (proposal.status !== 'pending') {
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
   * (`expired` = live rev moved; `superseded` = another proposal was approved).
   */
  markClosed(
    id: string,
    status: 'expired' | 'superseded',
    reason: string,
    decidedBy?: ProposalDecisionBy
  ): Proposal {
    const proposal = this.get(id);
    if (proposal.status !== 'pending') {
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
}
