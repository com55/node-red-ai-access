/**
 * Proposal JSON store under `.ai-access/proposals/`.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

import type { FlowTab } from '../runtime/types.js';

import type { AiAccessPaths } from './paths.js';
import {
  assertSafeProposalId,
  assertSafeSegment,
  resolveUnderDir,
  sanitizeFlowTab,
} from './safe.js';

export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'failed';

export type ProposalType = 'replace_flow';

export interface ProposalCreator {
  kind: 'access-link';
  linkId: string;
  label?: string;
}

export interface ProposalDecisionBy {
  kind: 'admin';
  username?: string;
}

export interface ReplaceFlowPayload {
  flowId: string;
  flow: Partial<FlowTab>;
}

export interface Proposal {
  id: string;
  type: ProposalType;
  status: ProposalStatus;
  expectedRev: string;
  payload: ReplaceFlowPayload;
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
  createdBy: ProposalCreator;
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

export class ProposalConcurrentApproveError extends Error {
  readonly code = 'proposal_approve_in_progress' as const;
  readonly statusCode = 409;
  constructor(id: string) {
    super(`Proposal '${id}' is already being approved`);
    this.name = 'ProposalConcurrentApproveError';
  }
}

function isProposalStatus(value: unknown): value is ProposalStatus {
  return value === 'pending' || value === 'approved' || value === 'rejected' || value === 'failed';
}

export class ProposalStore {
  private readonly inFlight = new Set<string>();
  private readonly now: () => number;
  private readonly randomId: () => string;

  constructor(
    private readonly paths: AiAccessPaths,
    options: { now?: () => number; randomId?: () => string } = {}
  ) {
    this.now = options.now ?? (() => Date.now());
    this.randomId = options.randomId ?? (() => randomBytes(12).toString('hex'));
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

    if (proposal.decidedBy) {
      const decidedBy: ProposalDecisionBy = { kind: 'admin' };
      if (typeof proposal.decidedBy.username === 'string') {
        decidedBy.username = proposal.decidedBy.username.replace(/\0/g, '').slice(0, 200);
      }
      record.decidedBy = decidedBy;
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
    const temp = `${target}.${process.pid}.tmp`;
    // Intentionally persist owner-approved / access-link proposal JSON under
    // userDir/.ai-access after path + field validation above. This is the
    // product's storage surface, not an open file write of raw request bodies.
    // codeql[js/file-write]
    writeFileSync(temp, `${JSON.stringify(disk, null, 2)}\n`, 'utf8');
    renameSync(temp, target);
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
      createdBy: input.createdBy,
      createdAt: at,
      updatedAt: at,
    };
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
}
