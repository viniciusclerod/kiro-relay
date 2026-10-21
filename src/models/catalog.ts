// Catálogo de modelos do Kiro (ListAvailableModels). Módulo puro: sem vscode.
// Formato observado em 2026-10-21 no host management.{region}.kiro.dev; NÃO é contrato oficial.

import type { AccessToken } from '../auth/tokenProvider.ts';
import { effortConfigurationSchema, parseEffortSupport, type EffortSupport } from './effort.ts';

/** Teto de páginas, igual ao do Kiro IDE segundo o kirogo. */
export const MAX_PAGES = 10;
const DEFAULT_MAX_INPUT_TOKENS = 200_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 64_000;

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface KiroModel {
  id: string;
  name: string;
  description?: string;
  rateMultiplier?: number;
  rateUnit?: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  supportsImages: boolean;
  /** JSON Schema de additionalModelRequestFields (esforço de raciocínio etc.). */
  requestFieldsSchema?: Record<string, unknown>;
  effort?: EffortSupport;
}

export interface ModelList {
  models: KiroModel[];
  defaultModelId?: string;
}

/** Erro HTTP do backend do Kiro. A mensagem nunca inclui headers nem o token. */
export class KiroApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'KiroApiError';
    this.status = status;
  }
}

export interface ListOptions {
  token: AccessToken;
  userAgent: string;
  fetch?: FetchFn;
  signal?: AbortSignal;
}

function managementHost(region: string): string {
  if (!/^[a-z]+(-[a-z]+)+-\d+$/.test(region)) throw new Error(`região inválida: ${region}`);
  return `https://management.${region}.kiro.dev`;
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

/** Converte uma entrada de `models[]`. Retorna undefined se não houver modelId. */
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

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = obj(await res.json());
    const msg = str(body?.message);
    if (msg) return msg;
  } catch {
    // corpo não é JSON
  }
  return res.statusText || 'erro desconhecido';
}

/** GET /ListAvailableModels, seguindo nextToken até MAX_PAGES páginas. */
export async function listAvailableModels(opts: ListOptions): Promise<ModelList> {
  const doFetch = opts.fetch ?? fetch;
  const { token } = opts;
  if (!token.region) throw new Error('região desconhecida: o token do kiro-cli não informa a região');
  const base = `${managementHost(token.region)}/ListAvailableModels`;

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
      throw new KiroApiError(res.status, `ListAvailableModels: HTTP ${res.status}: ${await errorMessage(res)}`);
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
// Conversão para o formato do VS Code (estrutural: LanguageModelChatInformation).
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
   * API PROPOSTA (ausente do @types/vscode 1.140): o VS Code 1.142 aceita este campo sem exigir
   * enabledApiProposals e mostra as opções no seletor de modelos. Se deixar de funcionar, vale a
   * setting kirorelay.reasoningEffort.
   */
  configurationSchema?: Record<string, unknown>;
}

function formatRate(m: KiroModel): string | undefined {
  if (m.rateMultiplier === undefined) return undefined;
  const unit = m.rateUnit?.toLowerCase() === 'credit' ? 'credits' : (m.rateUnit ?? '');
  return `${m.rateMultiplier}x ${unit}`.trim();
}

export function toChatModelInfo(m: KiroModel, defaultModelId?: string): ChatModelInfo {
  const rate = formatRate(m);
  const tooltip = [m.description, m.id === defaultModelId ? 'Modelo padrão do Kiro.' : undefined]
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
// Cache com TTL. Em falha, mantém a última lista boa.
// ---------------------------------------------------------------------------

export interface CatalogOptions {
  /** forceReload: relê as credenciais do kiro-cli (usado após um 403). */
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
   * Devolve a lista em cache se estiver fresca; senão busca de novo.
   * Se a busca falhar e houver lista anterior, devolve a anterior e registra o erro.
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

  /** 403 costuma ser token vencido ou renovado pelo kiro-cli: relê as credenciais e tenta uma vez. */
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
      this.opts.log?.('catálogo: HTTP 403, relendo credenciais e tentando de novo');
      return call(true);
    }
  }

  private async fetchList(): Promise<ModelList> {
    try {
      const list = await this.listWithRetryOn403();
      if (list.models.length === 0) throw new Error('o catálogo de modelos veio vazio');
      this.cached = { list, at: this.now() };
      this.opts.log?.(`catálogo: ${list.models.length} modelos (padrão: ${list.defaultModelId ?? '?'})`);
      return list;
    } catch (e) {
      if (this.cached) {
        this.opts.log?.(`catálogo: falha ao atualizar, mantendo lista anterior: ${(e as Error).message}`);
        return this.cached.list;
      }
      throw e;
    }
  }
}
