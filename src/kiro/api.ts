// Shared pieces of the Kiro HTTP API. Pure module: no vscode.

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/** HTTP error from the Kiro backend. The message never includes headers or the token. */
export class KiroApiError extends Error {
  readonly status: number;
  /** Message from the backend body (e.g. "Invalid token"). */
  readonly detail: string;
  /** Machine-readable reason from the backend body, if any (e.g. "MONTHLY_REQUEST_COUNT"). */
  readonly reason?: string;

  constructor(operation: string, status: number, detail: string, reason?: string) {
    super(`${operation}: HTTP ${status}: ${detail}${reason ? ` (${reason})` : ''}`);
    this.name = 'KiroApiError';
    this.status = status;
    this.detail = detail;
    this.reason = reason;
  }
}

/** Builds a KiroApiError from a non-2xx response, reading `message`/`reason` from the JSON body. */
export async function apiError(operation: string, res: Response): Promise<KiroApiError> {
  let detail = res.statusText || 'unknown error';
  let reason: string | undefined;
  try {
    const body = (await res.json()) as unknown;
    if (typeof body === 'object' && body !== null) {
      const b = body as Record<string, unknown>;
      if (typeof b.message === 'string' && b.message) detail = b.message;
      if (typeof b.reason === 'string' && b.reason && b.reason !== 'null') reason = b.reason;
    }
  } catch {
    // body is not JSON
  }
  return new KiroApiError(operation, res.status, detail, reason);
}

export function regionHost(service: 'management' | 'runtime', region: string): string {
  if (!/^[a-z]+(-[a-z]+)+-\d+$/.test(region)) throw new Error(`invalid region: ${region}`);
  return `https://${service}.${region}.kiro.dev`;
}
