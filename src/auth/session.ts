// Estimates when the IAM Identity Center session ends. Pure module: no vscode.
//
// Neither kiro-cli nor the Kiro backend reports the session end. What we observed (2026-10-21,
// kiro-cli 2.33.0, IdC):
//  - a sign-in gives a new refresh token and an access token valid for ~60 min;
//  - renewals keep the same refresh token and give ~60 min tokens, but never past the session end:
//    close to it, a renewed token is shorter and expires exactly when the session ends;
//  - the session lasted 8 h (the AWS default; an organization can configure another duration).
// So: a new refresh token seen with a nearly full ~60 min token means "signed in just now"; the
// session ends `sessionHours` later. A renewed token clearly shorter than 60 min marks the exact end.

/** Lifetime of a fresh access token (observed). */
export const TOKEN_LIFETIME_MS = 60 * 60_000;
/** A token with at least this much left, seen for a new refresh token, was issued at sign-in. */
const FRESH_TOKEN_MS = 55 * 60_000;
/** A token renewed in the last few minutes with less than this left was capped by the session end. */
const CAPPED_TOKEN_MS = 50 * 60_000;
const RECENT_RENEWAL_MS = 3 * 60_000;

export interface SessionStore {
  get(): SessionRecord | undefined;
  set(record: SessionRecord): void;
}

export interface SessionRecord {
  /** Fingerprint of the refresh token of the session (never the token itself). */
  refreshFingerprint: string;
  /** Estimated sign-in time (ms), when seen right after sign-in. */
  signedInAt?: number;
  /** Exact end (ms), once a renewal was capped by it. */
  endsAt?: number;
}

export interface SessionEstimate {
  /** Undefined when the sign-in was not observed and the end is not known yet. */
  endsAt?: Date;
  /** true: seen as a capped renewal; false: sign-in time + configured duration. */
  exact: boolean;
}

export class SessionTracker {
  private readonly store: SessionStore;
  private readonly sessionMs: () => number;

  constructor(store: SessionStore, sessionHours: () => number = () => 8) {
    this.store = store;
    this.sessionMs = () => Math.max(1, sessionHours()) * 3_600_000;
  }

  /**
   * Records what a freshly read token tells about the session.
   * `renewedAt`: when kiro-cli last renewed the token through the extension, if recently.
   */
  observe(token: { refreshFingerprint?: string; expiresAt: Date }, now: number, renewedAt?: number): void {
    const fp = token.refreshFingerprint;
    if (!fp) return;
    const remaining = token.expiresAt.getTime() - now;
    let record = this.store.get();
    if (record?.refreshFingerprint !== fp) {
      record = { refreshFingerprint: fp };
      if (remaining >= FRESH_TOKEN_MS) record.signedInAt = token.expiresAt.getTime() - TOKEN_LIFETIME_MS;
      this.store.set(record);
    }
    const justRenewed = renewedAt !== undefined && now - renewedAt <= RECENT_RENEWAL_MS;
    if (justRenewed && remaining > 0 && remaining < CAPPED_TOKEN_MS && record.endsAt !== token.expiresAt.getTime()) {
      this.store.set({ ...record, endsAt: token.expiresAt.getTime() });
    }
  }

  estimate(): SessionEstimate {
    const record = this.store.get();
    if (record?.endsAt !== undefined) return { endsAt: new Date(record.endsAt), exact: true };
    if (record?.signedInAt !== undefined) return { endsAt: new Date(record.signedInAt + this.sessionMs()), exact: false };
    return { exact: false };
  }
}
