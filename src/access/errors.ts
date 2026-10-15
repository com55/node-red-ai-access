/**
 * Errors for the in-memory access-link store.
 */

export class AccessLinkLimitError extends Error {
  readonly code = 'access_link_limit' as const;
  readonly statusCode = 409;

  constructor(maxActive: number) {
    super(
      `Cannot create access link: at most ${maxActive} active links are allowed. Revoke an existing link first.`
    );
    this.name = 'AccessLinkLimitError';
  }
}

export class AccessLinkNotFoundError extends Error {
  readonly code = 'access_link_not_found' as const;
  readonly statusCode = 404;

  constructor(linkId: string) {
    super(`Access link '${linkId}' was not found`);
    this.name = 'AccessLinkNotFoundError';
  }
}

export class AccessLinkValidationError extends Error {
  readonly code = 'access_link_invalid' as const;
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = 'AccessLinkValidationError';
  }
}
