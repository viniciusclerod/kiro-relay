export interface Credentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  region?: string;
  profileArn?: string;
  /** Raw value of the oauth_flow field, if any (informational only for now). */
  oauthFlow?: string;
  /** Is there an associated OIDC client registration (clientId/clientSecret)? */
  hasClientRegistration: boolean;
  /** Human-readable origin, e.g. "kiro-cli-db:kirocli:social:token". */
  source: string;
}

/**
 * kiro-cli writes RFC 3339 timestamps with nanoseconds (sometimes with too many
 * digits). Date only has milliseconds, so the fraction is truncated to 3 digits.
 */
export function parseTimestamp(value: unknown): Date {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // epoch in seconds (< 1e12) or milliseconds
    return new Date(value < 1e12 ? value * 1000 : value);
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('timestamp missing or of an unexpected type');
  }
  const normalized = value.trim().replace(/(\.\d{3})\d+/, '$1');
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`invalid timestamp: ${value}`);
  }
  return date;
}

/** Reads the first present field among snake_case/camelCase variants. */
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

/** Converts a token JSON object (kiro-cli or Kiro IDE) into Credentials. */
export function parseTokenObject(obj: Record<string, unknown>, source: string): Credentials {
  const accessToken = str(pick(obj, 'access_token', 'accessToken'));
  if (!accessToken) throw new Error('access_token field missing');

  const expiresRaw = pick(obj, 'expires_at', 'expiresAt');
  if (expiresRaw === undefined) throw new Error('expires_at field missing');

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
    throw new Error('value is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('JSON value is not an object');
  }
  return parseTokenObject(parsed as Record<string, unknown>, source);
}

/** Extracts the profile ARN from the value stored in state["api.codewhisperer.profile"]. */
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
    // ignore: unknown format
  }
  return undefined;
}
