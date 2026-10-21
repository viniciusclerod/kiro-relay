// Atenção: sintaxe apagável apenas (sem enums nem parameter properties),
// para que os testes rodem direto no Node com type stripping.

export class KiroAuthError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'KiroAuthError';
    this.code = code;
  }
}

/** Nenhuma credencial utilizável foi encontrada em nenhuma fonte. */
export class NotLoggedInError extends KiroAuthError {
  readonly details: string[];

  constructor(details: string[]) {
    super(
      'not-logged-in',
      'Nenhuma credencial do kiro-cli encontrada. Rode "kiro-cli login" e tente novamente.',
    );
    this.name = 'NotLoggedInError';
    this.details = details;
  }
}

/**
 * Há credencial, mas o access token venceu (ou está dentro da margem) e o
 * kiro-cli ainda não o renovou. A extensão NÃO renova sozinha: os refresh
 * tokens do Kiro são de uso único, e renovar por fora pode deslogar o kiro-cli.
 */
export class TokenExpiredError extends KiroAuthError {
  readonly expiredAt: Date;
  readonly source: string;

  constructor(expiredAt: Date, source: string) {
    super(
      'token-expired',
      `O token do kiro-cli expirou em ${expiredAt.toISOString()} (fonte: ${source}). ` +
        'Use o kiro-cli (ou rode "kiro-cli login") para renová-lo e tente novamente.',
    );
    this.name = 'TokenExpiredError';
    this.expiredAt = expiredAt;
    this.source = source;
  }
}

/** node:sqlite indisponível no runtime atual. */
export class SqliteUnavailableError extends KiroAuthError {
  constructor(cause: unknown) {
    super(
      'sqlite-unavailable',
      'O módulo node:sqlite não está disponível neste runtime. ' +
        'Use a fonte "sso-cache" ou me avise para adicionarmos o fallback com sql.js.',
      { cause },
    );
    this.name = 'SqliteUnavailableError';
  }
}
