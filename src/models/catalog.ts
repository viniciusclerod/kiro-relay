// Kiro model catalog (ListAvailableModels). Pure module: no vscode.
// Format observed on 2026-10-21 on the management.{region}.kiro.dev host; NOT an official contract.

import type { AccessToken } from '../auth/tokenProvider.ts';
import { KiroApiError, apiError, regionHost, type FetchFn } from '../kiro/api.ts';
import { effortConfigurationSchema, parseEffortSupport, type EffortSupport } from './effort.ts';

export { KiroApiError, type FetchFn };

/** Page cap, the same as the Kiro IDE's according to kirogo. */
export const MAX_PAGES = 10;
const DEFAULT_MAX_INPUT_TOKENS = 200_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 64_000;

export interface KiroModel {
  id: string;
  name: string;
  description?: string;
  rateMultiplier?: number;
  rateUnit?: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  supportsImages: boolean;
  /** JSON Schema of additionalModelRequestFields (reasoning effort etc.). */
  requestFieldsSchema?: Record<string, unknown>;
  effort?: EffortSupport;
}

export interface ModelList {
  models: KiroModel[];
  defaultModelId?: string;
}

export interface ListOptions {
  token: AccessToken;
  userAgent: string;
  fetch?: FetchFn;
  signal?: AbortSignal;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/** Converts an entry of `models[]`. Returns undefined when there is no modelId. */
export function parseModel(raw: unknown): KiroModel | undefined {
  const m = obj(raw);
  const id = str(m?.modelId);
  if (!m || !id) return undefined;
  const limits = obj(m.tokenLimits);
  const inputs = Array.isArray(m.supportedInputTypes) ? m.supportedInputTypes : [];
  return {
    id,
    name: str(m.modelName) ?? id,
    description: str(m.description),
    rateMultiplier: num(m.rateMultiplier),
    rateUnit: str(m.rateUnit),
    maxInputTokens: num(limits?.maxInputTokens) ?? DEFAULT_MAX_INPUT_TOKENS,
    maxOutputTokens: num(limits?.maxOutputTokens) ?? DEFAULT_MAX_OUTPUT_TOKENS,
    supportsImages: inputs.includes('IMAGE'),
    requestFieldsSchema: obj(m.additionalModelRequestFieldsSchema),
    effort: parseEffortSupport(obj(m.additionalModelRequestFieldsSchema)),
  };
}

/** GET /ListAvailableModels, following nextToken for up to MAX_PAGES pages. */
export async function listAvailableModels(opts: ListOptions): Promise<ModelList> {
  const doFetch = opts.fetch ?? fetch;
  const { token } = opts;
  if (!token.region) throw new Error('unknown region: the kiro-cli token does not include a region');
  const base = `${regionHost('management', token.region)}/ListAvailableModels`;

  const models: KiroModel[] = [];
  const seen = new Set<string>();
  let defaultModelId: string | undefined;
  let nextToken: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const q = new URLSearchParams({ origin: 'AI_EDITOR' });
    if (token.profileArn) q.set('profileArn', token.profileArn);
    if (nextToken) q.set('nextToken', nextToken);

    const res = await doFetch(`${base}?${q}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token.token}`,
        Accept: 'application/json',
        'User-Agent': opts.userAgent,
      },
      signal: opts.signal,
    });
    if (!res.ok) {
      throw await apiError('ListAvailableModels', res);
    }
    const body = obj(await res.json()) ?? {};
    for (const raw of Array.isArray(body.models) ? body.models : []) {
      const m = parseModel(raw);
      if (m && !seen.has(m.id)) {
        seen.add(m.id);
        models.push(m);
      }
    }
    defaultModelId ??= str(obj(body.defaultModel)?.modelId);
    nextToken = str(body.nextToken);
    if (!nextToken) break;
  }
  return { models, defaultModelId };
}

// ---------------------------------------------------------------------------
// Conversion to the VS Code format (structural: LanguageModelChatInformation).
// ---------------------------------------------------------------------------

export interface ChatModelInfo {
  id: string;
  name: string;
  family: string;
  version: string;
  tooltip?: string;
  detail?: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  capabilities: { imageInput: boolean; toolCalling: boolean };
  /**
   * PROPOSED API (not in @types/vscode 1.140): VS Code 1.142 accepts this field without
   * enabledApiProposals and shows the options in the model picker. If it stops working, the
   * kirorelay.reasoningEffort setting still applies.
   */
  configurationSchema?: Record<string, unknown>;
}

function formatRate(m: KiroModel): string | undefined {
  if (m.rateMultiplier === undefined) return undefined;
  const unit = m.rateUnit?.toLowerCase() === 'credit' ? 'credits' : (m.rateUnit ?? '');
  return `${m.rateMultiplier}x ${unit}`.trim();
}

/** `defaultModelNote` is appended to the tooltip of the default model (localized by the caller). */
export function toChatModelInfo(
  m: KiroModel,
  defaultModelId?: string,
  defaultModelNote = 'Default Kiro model.',
): ChatModelInfo {
  const rate = formatRate(m);
  const tooltip = [m.description, m.id === defaultModelId ? defaultModelNote : undefined]
    .filter(Boolean)
    .join('\n');
  return {
    id: m.id,
    name: m.name,
    family: m.id,
    version: m.id,
    tooltip: tooltip || undefined,
    detail: rate,
    maxInputTokens: m.maxInputTokens,
    maxOutputTokens: m.maxOutputTokens,
    capabilities: { imageInput: m.supportsImages, toolCalling: true },
    ...(m.effort ? { configurationSchema: effortConfigurationSchema(m.effort) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Cache with a TTL. On failure, keeps the last good list.
// ---------------------------------------------------------------------------

export interface CatalogOptions {
  /** forceReload: re-reads the kiro-cli credentials (used after a 403). */
  getToken: (opts?: { forceReload?: boolean }) => Promise<AccessToken>;
  userAgent: string;
  ttlMs?: number;
  fetch?: FetchFn;
  now?: () => number;
  log?: (m: string) => void;
}

export class ModelCatalog {
  private readonly opts: CatalogOptions;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private cached: { list: ModelList; at: number } | undefined;
  private inflight: Promise<ModelList> | undefined;

  constructor(opts: CatalogOptions) {
    this.opts = opts;
    this.ttlMs = opts.ttlMs ?? 3_600_000;
    this.now = opts.now ?? Date.now;
  }

  invalidate(): void {
    this.cached = undefined;
  }

  /**
   * Returns the cached list if it is fresh; otherwise fetches it again.
   * If the fetch fails and there is a previous list, returns that one and logs the error.
   */
  async get(opts: { force?: boolean } = {}): Promise<ModelList> {
    if (!opts.force && this.cached && this.now() - this.cached.at < this.ttlMs) {
      return this.cached.list;
    }
    this.inflight ??= this.fetchList().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  /** A 403 usually means the token expired or kiro-cli renewed it: re-read credentials and retry once. */
  private async listWithRetryOn403(): Promise<ModelList> {
    const call = async (forceReload: boolean) =>
      listAvailableModels({
        token: await this.opts.getToken({ forceReload }),
        userAgent: this.opts.userAgent,
        fetch: this.opts.fetch,
      });
    try {
      return await call(false);
    } catch (e) {
      if (!(e instanceof KiroApiError) || e.status !== 403) throw e;
      this.opts.log?.('catalog: HTTP 403, re-reading credentials and retrying');
      return call(true);
    }
  }

  private async fetchList(): Promise<ModelList> {
    try {
      const list = await this.listWithRetryOn403();
      if (list.models.length === 0) throw new Error('the model catalog came back empty');
      this.cached = { list, at: this.now() };
      this.opts.log?.(`catalog: ${list.models.length} models (default: ${list.defaultModelId ?? '?'})`);
      return list;
    } catch (e) {
      if (this.cached) {
        this.opts.log?.(`catalog: refresh failed, keeping the previous list: ${(e as Error).message}`);
        return this.cached.list;
      }
      throw e;
    }
  }
}
