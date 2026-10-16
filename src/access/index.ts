/**
 * Access-link store exports.
 */

export {
  AccessLinkLimitError,
  AccessLinkNotFoundError,
  AccessLinkTtlError,
  AccessLinkValidationError,
} from './errors.js';
export {
  ACCESS_LINK_KINDS,
  AccessLinkStore,
  isAccessLinkKind,
  resolveAccessLinkKind,
} from './link-store.js';
export type {
  AccessLinkCreated,
  AccessLinkKind,
  AccessLinkPublic,
  AccessLinkRecord,
  AccessLinkStoreOptions,
  AccessLinkValidateResult,
  CreateAccessLinkInput,
} from './link-store.js';
export {
  DEFAULT_ACCESS_LINK_TTL_SECONDS,
  INVALID_TTL_HINT,
  LONG_TTL_WARN_SECONDS,
  MAX_TTL_SECONDS_GET_LINK,
  MAX_TTL_SECONDS_REST_MCP,
  maxTtlSecondsForKind,
  ttlCapErrorMessage,
} from './ttl.js';
