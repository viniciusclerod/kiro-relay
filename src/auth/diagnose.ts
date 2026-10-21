import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { KiroAuthError, NotLoggedInError } from './errors.ts';
import { inspectDatabase, firstExisting, type DbInspection } from './kiroCliDb.ts';
import { inspectSsoCache } from './ssoCache.ts';
import { fingerprint, formatDuration } from './redact.ts';
import { loadNodeSqlite } from './sqliteSnapshot.ts';
import type { KiroCliTokenProvider } from './tokenProvider.ts';

const execFileAsync = promisify(execFile);

export interface DiagnoseInput {
  cliPath: string;
  databaseCandidates: string[];
  ssoCacheDir: string;
  /** Informações do host (versão do VS Code etc.). */
  host: Record<string, string>;
  provider: KiroCliTokenProvider;
  now?: () => number;
}

function section(lines: string[], title: string): void {
  lines.push('', `## ${title}`);
}

function remaining(iso: string | undefined, nowMs: number): string {
  if (!iso) return '?';
  return `${iso} (${formatDuration(Date.parse(iso) - nowMs)})`;
}

function formatDb(lines: string[], d: DbInspection, nowMs: number): void {
  lines.push(`- caminho: ${d.path}`);
  lines.push(`- tamanho: ${d.sizeBytes} bytes, modificado em ${d.mtime}`);
  lines.push(`- arquivo -wal: ${d.walSizeBytes === undefined ? 'ausente' : `${d.walSizeBytes} bytes`}`);
  if (d.error) lines.push(`- ERRO ao inspecionar: ${d.error}`);
  lines.push(`- tabelas: ${d.tables.join(', ') || '(nenhuma)'}`);
  lines.push(`- chaves em auth_kv: ${d.authKvKeys.join(', ') || '(nenhuma)'}`);
  for (const e of d.entries) {
    lines.push(`- entrada "${e.key}"`);
    lines.push(`    campos: ${e.fields.join(', ') || '(nenhum)'}`);
    if (e.token) {
      lines.push(
        `    access token: fingerprint=${e.token.fingerprint}, ` +
          `expira=${remaining(e.token.expiresAt, nowMs)}`,
      );
      lines.push(
        `    refresh token: ${e.token.refreshFingerprint ? `fingerprint=${e.token.refreshFingerprint}` : 'ausente'}`,
      );
    }
    if (e.registration) {
      lines.push(`    client_id: fingerprint=${e.registration.clientIdFingerprint}`);
      const secretExp = e.registration.clientSecretExpiresAt;
      lines.push(
        `    client_secret_expires_at: ${secretExp ? remaining(secretExp, nowMs) : '(ausente)'}`,
      );
    }
    if (e.error) lines.push(`    aviso: ${e.error}`);
  }
}

/** Gera um relatório de diagnóstico SEM segredos (só nomes de campos e fingerprints). */
export async function runDiagnostics(input: DiagnoseInput): Promise<string> {
  const now = input.now ?? Date.now;
  const lines: string[] = ['# Kiro Relay: diagnóstico de autenticação'];
  lines.push('', `agora: ${new Date(now()).toISOString()}`);

  section(lines, 'Ambiente');
  for (const [k, v] of Object.entries(input.host)) lines.push(`- ${k}: ${v}`);
  lines.push(`- node: ${process.versions.node}`);
  lines.push(`- electron: ${process.versions.electron ?? '(não é Electron)'}`);
  lines.push(`- plataforma: ${process.platform}/${process.arch}`);
  try {
    await loadNodeSqlite();
    lines.push('- node:sqlite: disponível');
  } catch (e) {
    lines.push(`- node:sqlite: INDISPONÍVEL (${(e as Error).message})`);
  }

  section(lines, 'kiro-cli');
  try {
    const { stdout } = await execFileAsync(input.cliPath, ['--version'], { timeout: 5000 });
    lines.push(`- ${input.cliPath} --version: ${stdout.trim()}`);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    lines.push(
      err.code === 'ENOENT'
        ? `- executável não encontrado: ${input.cliPath} (ajuste kirorelay.cli.path)`
        : `- falha ao executar ${input.cliPath} --version: ${err.message}`,
    );
  }

  section(lines, 'Banco SQLite do kiro-cli');
  for (const c of input.databaseCandidates) {
    lines.push(`- candidato: ${c}`);
  }
  const dbPath = await firstExisting(input.databaseCandidates);
  if (!dbPath) lines.push('- nenhum candidato existe');
  else formatDb(lines, await inspectDatabase(dbPath), now());

  section(lines, 'Cache SSO');
  const sso = await inspectSsoCache(input.ssoCacheDir);
  lines.push(`- diretório: ${sso.dir} (${sso.exists ? 'existe' : 'não existe'})`);
  if (sso.exists) lines.push(`- arquivos: ${sso.files.join(', ') || '(vazio)'}`);
  if (sso.token) {
    lines.push(`- kiro-auth-token.json, campos: ${sso.token.fields.join(', ') || '(nenhum)'}`);
    if (sso.token.expiresAt) {
      lines.push(
        `    token: fingerprint=${sso.token.fingerprint}, expira=${sso.token.expiresAt}`,
      );
    }
    if (sso.token.error) lines.push(`    aviso: ${sso.token.error}`);
  }

  section(lines, 'Resultado do provedor de token');
  try {
    const t = await input.provider.getAccessToken({ forceReload: true });
    lines.push('- OK: token válido obtido');
    lines.push(`- fonte: ${t.source}`);
    lines.push(`- fingerprint: ${fingerprint(t.token)}`);
    lines.push(`- ${formatDuration(t.expiresAt.getTime() - now())} (${t.expiresAt.toISOString()})`);
    lines.push(`- região: ${t.region ?? '(desconhecida)'}`);
    lines.push(`- profile ARN: ${t.profileArn ? 'presente' : 'ausente'}`);
    lines.push(`- oauth_flow: ${t.oauthFlow ?? '(ausente)'}`);
    lines.push(`- registro de cliente OIDC: ${t.hasClientRegistration ? 'sim' : 'não'}`);
  } catch (e) {
    if (e instanceof KiroAuthError) {
      lines.push(`- FALHA [${e.code}]: ${e.message}`);
      if (e instanceof NotLoggedInError) for (const d of e.details) lines.push(`    ${d}`);
    } else {
      lines.push(`- ERRO inesperado: ${(e as Error).message}`);
    }
  }
  return lines.join('\n');
}
