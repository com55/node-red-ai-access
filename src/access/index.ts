/**
 * Access-link store exports.
 */

export {
  AccessLinkLimitError,
  AccessLinkNotFoundError,
  AccessLinkValidationError,
} from './errors.js';
export { AccessLinkStore } from './link-store.js';
export type {
  AccessLinkCreated,
  AccessLinkPublic,
  AccessLinkRecord,
  AccessLinkStoreOptions,
  CreateAccessLinkInput,
} from './link-store.js';
