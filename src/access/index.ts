/**
 * Access-link store exports.
 */

export {
  AccessLinkLimitError,
  AccessLinkNotFoundError,
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
  CreateAccessLinkInput,
} from './link-store.js';
