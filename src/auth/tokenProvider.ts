import type { Credentials } from './credentials.ts';
import { NotLoggedInError, TokenExpiredError } from './errors.ts';
import type { CredentialSource, Logger } from './source.ts';

export interface AccessToken {
  token: string;
  expiresAt: Date;
  region?: string;
  profileArn?: string;
  oauthFlow?: string;
  hasClientRegistration: boolean;
  source: string;
}

export interface TokenProviderOptions {
  sources: CredentialSource[];
  /** Margem antes do vencimento em que o token já é considerado inválido. */
  leewayMs?: number;
  now?: () => number;
  log?: Logger;
}

function toAccessToken(c: Credentials): AccessToken {
  return {
    token: c.accessToken,
    expiresAt: c.expiresAt,
    region: c.region,
    profileArn: c.profileArn,
    oauthFlow: c.oauthFlow,
    hasClientRegistration: c.hasClientRegistration,
    source: c.source,
  };
}

/**
 * Provedor de access token COOPERATIVO com o kiro-cli:
 *  - só lê; nunca renova nem grava (refresh tokens do Kiro são de uso único);
 *  - mantém o token em memória até perto do vencimento e então RELÊ as fontes,
 *    porque o kiro-cli pode já tê-lo renovado;
 *  - se não houver token válido, lança erro orientando o usuário a usar o kiro-cli.
 */
export class KiroCliTokenProvider {
  private readonly sources: CredentialSource[];
  private readonly leewayMs: number;
  private readonly now: () => number;
  private readonly log: Logger;
  private cached: Credentials | undefined;
  private inflight: Promise<AccessToken> | undefined;

  constructor(opts: TokenProviderOptions) {
    this.sources = opts.sources;
    this.leewayMs = opts.leewayMs ?? 300_000;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  /** Descarta o cache (ex.: depois de um 401/403 do backend). */
  invalidate(): void {
    this.cached = undefined;
  }

  async getAccessToken(opts: { forceReload?: boolean } = {}): Promise<AccessToken> {
    if (!opts.forceReload && this.cached && this.isUsable(this.cached)) {
      return toAccessToken(this.cached);
    }
    // single-flight: chamadas concorrentes compartilham a mesma leitura
    this.inflight ??= this.reload().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private isUsable(c: Credentials): boolean {
    return c.expiresAt.getTime() - this.leewayMs > this.now();
  }

  private async reload(): Promise<AccessToken> {
    const notes: string[] = [];
    let expiredBest: Credentials | undefined;

    for (const source of this.sources) {
      let result;
      try {
        result = await source.load();
      } catch (e) {
        notes.push(`[${source.id}] erro: ${(e as Error).message}`);
        continue;
      }
      for (const n of result.notes) notes.push(`[${source.id}] ${n}`);

      for (const c of result.credentials) {
        if (this.isUsable(c)) {
          this.cached = c;
          this.log(`token válido de ${c.source}`);
          return toAccessToken(c);
        }
        if (!expiredBest || c.expiresAt > expiredBest.expiresAt) expiredBest = c;
      }
    }

    this.cached = undefined;
    if (expiredBest) throw new TokenExpiredError(expiredBest.expiresAt, expiredBest.source);
    throw new NotLoggedInError(notes);
  }
}
