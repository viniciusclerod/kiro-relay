import { KiroCliDbSource } from './kiroCliDb.ts';
import { KiroCliRenewer } from './renewer.ts';
import { defaultDatabaseCandidates, defaultSsoCacheDir, expandHome } from './paths.ts';
import type { Logger } from './source.ts';
import { SsoCacheSource } from './ssoCache.ts';
import { KiroCliTokenProvider } from './tokenProvider.ts';

export type SourceId = 'kiro-cli-db' | 'sso-cache';

export interface AuthConfig {
  sources: SourceId[];
  databasePath?: string;
  ssoCachePath?: string;
  leewaySeconds: number;
  /** kiro-cli executable, used for renewal. */
  cliPath: string;
  /** kiro-cli arguments that renew the token (e.g. ["whoami"]); empty disables renewal. */
  renewCommand: string[];
}

export function createAuth(cfg: AuthConfig, log: Logger) {
  const databaseCandidates = cfg.databasePath
    ? [expandHome(cfg.databasePath)]
    : defaultDatabaseCandidates();
  const ssoCacheDir = cfg.ssoCachePath ? expandHome(cfg.ssoCachePath) : defaultSsoCacheDir();

  const sources = cfg.sources.map((id) =>
    id === 'kiro-cli-db'
      ? new KiroCliDbSource(databaseCandidates, log)
      : new SsoCacheSource(ssoCacheDir, log),
  );

  const renewer = new KiroCliRenewer({ cliPath: cfg.cliPath, args: cfg.renewCommand, log });
  const provider = new KiroCliTokenProvider({
    sources,
    leewayMs: cfg.leewaySeconds * 1000,
    log,
    renew: () => renewer.renew(),
  });
  return { provider, renewer, databaseCandidates, ssoCacheDir };
}
