import type { Credentials } from './credentials.ts';
import { fingerprint } from './redact.ts';
import { NotLoggedInError, TokenExpiredError } from './errors.ts';
import type { CredentialSource, Logger } from './source.ts';

export interface AccessToken {
  token: string;
  expiresAt: Date;
  region?: string;
  profileArn?: string;
  oauthFlow?: string;
  startUrl?: string;
  /** Fingerprint of the refresh token (never the token): changes on every new sign-in. */
  refreshFingerprint?: string;
  hasClientRegistration: boolean;
  source: string;
}

export interface TokenProviderOptions {
  sources: CredentialSource[];
  /** Margin before expiry at which the token is already treated as invalid. */
  leewayMs?: number;
  now?: () => number;
  log?: Logger;
  /**
   * Asks kiro-cli to renew its token (e.g. by running `kiro-cli whoami`). Called when no source has a
   * usable token but one has an expired (or nearly expired) token. Must not throw.
   */
  renew?: () => Promise<unknown>;
  /** A token closer than this to expiry is never used, even when renewal did not replace it. */
  minValidityMs?: number;
}

function toAccessToken(c: Credentials): AccessToken {
  return {
    token: c.accessToken,
    expiresAt: c.expiresAt,
    region: c.region,
    profileArn: c.profileArn,
    oauthFlow: c.oauthFlow,
    startUrl: c.startUrl,
    refreshFingerprint: c.refreshToken ? fingerprint(c.refreshToken) : undefined,
    hasClientRegistration: c.hasClientRegistration,
    source: c.source,
  };
}

/**
 * Access token provider that COOPERATES with kiro-cli:
 *  - read-only; never refreshes the token or writes anything itself (Kiro refresh tokens may be
 *    single-use);
 *  - keeps the token in memory until close to expiry and then RE-READS the sources,
 *    because kiro-cli may have renewed it already;
 *  - if the token expired, optionally asks kiro-cli to renew it (`renew`) and re-reads once;
 *  - if there is still no valid token, throws an error telling the user to use kiro-cli.
 */
export class KiroCliTokenProvider {
  private readonly sources: CredentialSource[];
  private readonly leewayMs: number;
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly renew: (() => Promise<unknown>) | undefined;
  private readonly minValidityMs: number;
  private cached: Credentials | undefined;
  private inflight: Promise<AccessToken> | undefined;

  constructor(opts: TokenProviderOptions) {
    this.sources = opts.sources;
    this.leewayMs = opts.leewayMs ?? 300_000;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.renew = opts.renew;
    this.minValidityMs = opts.minValidityMs ?? 30_000;
  }

  /** Drops the cache (e.g. after a 401/403 from the backend). */
  invalidate(): void {
    this.cached = undefined;
  }

  async getAccessToken(opts: { forceReload?: boolean } = {}): Promise<AccessToken> {
    if (!opts.forceReload && this.cached && this.isUsable(this.cached)) {
      return toAccessToken(this.cached);
    }
    // single-flight: concurrent calls share the same read
    this.inflight ??= this.reload().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private isUsable(c: Credentials): boolean {
    return c.expiresAt.getTime() - this.leewayMs > this.now();
  }

  private async readSources(): Promise<{ usable?: Credentials; expiredBest?: Credentials; notes: string[] }> {
    const notes: string[] = [];
    let expiredBest: Credentials | undefined;
    for (const source of this.sources) {
      let result;
      try {
        result = await source.load();
      } catch (e) {
        notes.push(`[${source.id}] error: ${(e as Error).message}`);
        continue;
      }
      for (const n of result.notes) notes.push(`[${source.id}] ${n}`);
      for (const c of result.credentials) {
        if (this.isUsable(c)) return { usable: c, notes };
        if (!expiredBest || c.expiresAt > expiredBest.expiresAt) expiredBest = c;
      }
    }
    return { expiredBest, notes };
  }

  private accept(c: Credentials, how: string): AccessToken {
    this.cached = c;
    this.log(`valid token from ${c.source}${how}`);
    return toAccessToken(c);
  }

  private async reload(): Promise<AccessToken> {
    let read = await this.readSources();
    if (read.usable) return this.accept(read.usable, '');

    // Ask kiro-cli to renew only when there is a token to renew: without one, only "kiro-cli login" helps.
    if (read.expiredBest && this.renew) {
      await this.renew();
      read = await this.readSources();
      if (read.usable) return this.accept(read.usable, ' after renewal');
      // kiro-cli only renews close to expiry: a token inside the leeway but still valid is used as is.
      const c = read.expiredBest;
      if (c && c.expiresAt.getTime() - this.minValidityMs > this.now()) {
        return this.accept(c, ' (inside the leeway, kiro-cli did not renew it yet)');
      }
    }

    this.cached = undefined;
    if (read.expiredBest) throw new TokenExpiredError(read.expiredBest.expiresAt, read.expiredBest.source);
    throw new NotLoggedInError(read.notes);
  }
}
