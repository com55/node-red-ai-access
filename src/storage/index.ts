/**
 * Disk storage exports for proposals and audit logs.
 */

export { AuditLog } from './audit-log.js';
export type { AuditActor, AuditEntry } from './audit-log.js';
export { ensureAiAccessDirs, resolveAiAccessPaths } from './paths.js';
export type { AiAccessPaths } from './paths.js';
export {
  ProposalConcurrentApproveError,
  ProposalNotFoundError,
  ProposalNotPendingError,
  ProposalStore,
} from './proposals.js';
export type {
  CreateProposalInput,
  Proposal,
  ProposalCreator,
  ProposalDecisionBy,
  ProposalStatus,
  ProposalType,
  ProposalWarning,
  ReplaceFlowPayload,
} from './proposals.js';
export {
  assertSafeProposalId,
  assertSafeSegment,
  resolveUnderDir,
  sanitizeAuditDetails,
  sanitizeFlowTab,
} from './safe.js';
export {
  AI_ACCESS_DIR_MODE,
  AI_ACCESS_FILE_MODE,
  MAX_AUDIT_APPEND_BYTES,
  MAX_PROPOSAL_JSON_BYTES,
  StoragePayloadTooLargeError,
  appendTrusted,
  assertUnderAiAccess,
  encodeTrustedJson,
  writeTrustedAtomic,
} from './trusted-write.js';
export type { EncodeTrustedJsonOptions, TrustedStoragePayload } from './trusted-write.js';
