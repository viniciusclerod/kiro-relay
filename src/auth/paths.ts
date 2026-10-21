import * as os from 'node:os';
import * as path from 'node:path';

export const SSO_TOKEN_FILE = 'kiro-auth-token.json';

type Platform = NodeJS.Platform;

/**
 * Locais prováveis do data.sqlite3 do kiro-cli, em ordem de prioridade.
 * Linux/macOS: confirmados por documentação de projetos de terceiros.
 * Windows: palpite (não verificado). Use kirorelay.auth.databasePath se divergir.
 * "amazon-q" é o nome legado do mesmo CLI (antes do Kiro).
 */
export function defaultDatabaseCandidates(
  platform: Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string[] {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const apps = ['kiro-cli', 'amazon-q'];
  let base: string;

  if (platform === 'darwin') {
    base = p.join(home, 'Library', 'Application Support');
  } else if (platform === 'win32') {
    base = env.LOCALAPPDATA ?? p.join(home, 'AppData', 'Local');
  } else {
    base = env.XDG_DATA_HOME || p.join(home, '.local', 'share');
  }
  return apps.map((app) => p.join(base, app, 'data.sqlite3'));
}

export function defaultSsoCacheDir(home: string = os.homedir()): string {
  return path.join(home, '.aws', 'sso', 'cache');
}

export function expandHome(p: string, home: string = os.homedir()): string {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
  return p;
}
