// Erasable syntax only (no enums, no parameter properties), so tests run
// directly on Node with type stripping.
//
// Messages are in English and are used in logs and diagnostics. The UI
// (extension.ts) shows localized messages based on `code` and the error fields.

export class KiroAuthError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'KiroAuthError';
    this.code = code;
  }
}

/** No usable credential was found in any source. */
export class NotLoggedInError extends KiroAuthError {
  readonly details: string[];

  constructor(details: string[]) {
    super('not-logged-in', 'No kiro-cli credentials found. Run "kiro-cli login" and try again.');
    this.name = 'NotLoggedInError';
    this.details = details;
  }
}

/**
 * There is a credential, but the access token has expired (or is within the
 * leeway) and kiro-cli has not renewed it yet. The extension does NOT renew it
 * itself: Kiro refresh tokens may be single-use, and renewing from outside could
 * sign kiro-cli out.
 */
export class TokenExpiredError extends KiroAuthError {
  readonly expiredAt: Date;
  readonly source: string;

  constructor(expiredAt: Date, source: string) {
    super(
      'token-expired',
      `The kiro-cli token expired at ${expiredAt.toISOString()} (source: ${source}). ` +
        'Use kiro-cli (or run "kiro-cli login") to renew it and try again.',
    );
    this.name = 'TokenExpiredError';
    this.expiredAt = expiredAt;
    this.source = source;
  }
}

/** node:sqlite is not available in the current runtime. */
export class SqliteUnavailableError extends KiroAuthError {
  constructor(cause: unknown) {
    super(
      'sqlite-unavailable',
      'The node:sqlite module is not available in this runtime. ' +
        'Use the "sso-cache" source, or open an issue so we can add a sql.js fallback.',
      { cause },
    );
    this.name = 'SqliteUnavailableError';
  }
}
