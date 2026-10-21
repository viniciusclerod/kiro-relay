export interface Credentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  region?: string;
  profileArn?: string;
  /** Valor bruto do campo oauth_flow, se existir (só informativo por enquanto). */
  oauthFlow?: string;
  /** Existe um registro de cliente OIDC (clientId/clientSecret) associado? */
  hasClientRegistration: boolean;
  /** Origem legível, ex.: "kiro-cli-db:kirocli:social:token". */
  source: string;
}

/**
 * O kiro-cli grava timestamps RFC3339 com nanossegundos (às vezes com dígitos
 * demais). Date só tem milissegundos, então truncamos a fração em 3 dígitos.
 */
export function parseTimestamp(value: unknown): Date {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // epoch em segundos (< 1e12) ou milissegundos
    return new Date(value < 1e12 ? value * 1000 : value);
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('timestamp ausente ou com tipo inesperado');
  }
  const normalized = value.trim().replace(/(\.\d{3})\d+/, '$1');
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`timestamp inválido: ${value}`);
  }
  return date;
}

/** Lê o primeiro campo existente entre variações snake_case/camelCase. */
export function pick(obj: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    const v = obj[name];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

export function regionFromArn(arn: string | undefined): string | undefined {
  if (!arn || !arn.startsWith('arn:')) return undefined;
  return str(arn.split(':')[3]);
}

/** Converte o objeto JSON de um token (kiro-cli ou Kiro IDE) em Credentials. */
export function parseTokenObject(obj: Record<string, unknown>, source: string): Credentials {
  const accessToken = str(pick(obj, 'access_token', 'accessToken'));
  if (!accessToken) throw new Error('campo access_token ausente');

  const expiresRaw = pick(obj, 'expires_at', 'expiresAt');
  if (expiresRaw === undefined) throw new Error('campo expires_at ausente');

  const profileArn = str(pick(obj, 'profile_arn', 'profileArn'));
  const region = str(pick(obj, 'region')) ?? regionFromArn(profileArn);

  return {
    accessToken,
    refreshToken: str(pick(obj, 'refresh_token', 'refreshToken')),
    expiresAt: parseTimestamp(expiresRaw),
    region,
    profileArn,
    oauthFlow: str(pick(obj, 'oauth_flow', 'oauthFlow')),
    hasClientRegistration: false,
    source,
  };
}

export function parseTokenRecord(raw: string, source: string): Credentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('valor não é JSON válido');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('valor JSON não é um objeto');
  }
  return parseTokenObject(parsed as Record<string, unknown>, source);
}

/** Extrai o ARN do perfil do valor gravado em state["api.codewhisperer.profile"]. */
export function extractProfileArn(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.startsWith('arn:')) return trimmed;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'string') return parsed.startsWith('arn:') ? parsed : undefined;
    if (typeof parsed === 'object' && parsed !== null) {
      return str(pick(parsed as Record<string, unknown>, 'arn', 'profile_arn', 'profileArn'));
    }
  } catch {
    // ignora: formato desconhecido
  }
  return undefined;
}
