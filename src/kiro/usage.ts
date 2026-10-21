// Credit usage (GetUsageLimits). Pure module: no vscode.
//
// GET https://management.{region}.kiro.dev/getUsageLimits?origin=AI_EDITOR&profileArn=…
// (the same control plane host as ListAvailableModels). Shape observed on 2026-10-21:
//   { subscriptionInfo: { subscriptionTitle: "KIRO PRO", ... }, nextDateReset: <epoch seconds>,
//     overageConfiguration: { overageStatus: "DISABLED" },
//     usageBreakdownList: [{ resourceType: "CREDIT", displayName: "Credit", displayNamePlural: "Credits",
//       currentUsage: 8, currentUsageWithPrecision: 8.69, usageLimit: 1000, usageLimitWithPrecision: 1000,
//       bonuses: [], freeTrialInfo: null, ... }],
// Bonus and free trial rules mirror the Kiro IDE (extension kiro.kiro-agent, 2026-10).
//     userInfo: { ... } }   <- identifies the user: never logged or stored.

import type { AccessToken } from '../auth/tokenProvider.ts';
import { apiError, regionHost, type FetchFn } from './api.ts';

export interface UsageItem {
  resourceType: string;
  /** Plural display name, e.g. "Credits". */
  name: string;
  used: number;
  /** Undefined when the plan has no limit (Kiro treats limits >= 999999 as unlimited). */
  limit?: number;
  /** 0..100, rounded down like the Kiro IDE; only when there is a limit. */
  percentUsed?: number;
}

/** A bonus or the welcome free trial; listed separately, it does not change the main limit. */
export interface UsageBonus {
  name: string;
  used: number;
  total: number;
  expiresAt?: Date;
}

export interface UsageSummary {
  plan?: string;
  resetsAt?: Date;
  overagesEnabled: boolean;
  items: UsageItem[];
  bonuses: UsageBonus[];
}

/** Kiro IDE threshold for "no limit". */
const UNLIMITED = 999_999;

function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function num(...values: unknown[]): number | undefined {
  for (const v of values) if (typeof v === 'number' && Number.isFinite(v)) return v;
  return undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** Epoch seconds, epoch milliseconds or an ISO string. */
function date(v: unknown): Date | undefined {
  let d: Date | undefined;
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) d = new Date(v < 1e12 ? v * 1000 : v);
  else if (typeof v === 'string' && v) d = new Date(v);
  return d && !Number.isNaN(d.getTime()) ? d : undefined;
}

/** Same rules as the Kiro IDE: an ACTIVE free trial, and bonuses that are ACTIVE or EXHAUSTED. */
function bonusesOf(item: Record<string, unknown>): UsageBonus[] {
  const out: UsageBonus[] = [];
  const trial = obj(item.freeTrialInfo);
  if (trial && str(trial.freeTrialStatus) === 'ACTIVE') {
    out.push({
      name: 'Welcome bonus',
      used: num(trial.currentUsageWithPrecision, trial.currentUsage) ?? 0,
      total: num(trial.usageLimitWithPrecision, trial.usageLimit) ?? 0,
      expiresAt: date(trial.freeTrialExpiry),
    });
  }
  for (const b of Array.isArray(item.bonuses) ? item.bonuses : []) {
    const bonus = obj(b);
    const status = str(bonus?.status);
    if (!bonus || (status !== 'ACTIVE' && status !== 'EXHAUSTED')) continue;
    out.push({
      name: str(bonus.displayName) ?? 'Bonus',
      used: num(bonus.currentUsage) ?? 0,
      total: num(bonus.usageLimit) ?? 0,
      expiresAt: date(bonus.expiresAt),
    });
  }
  return out;
}

export function parseUsage(raw: unknown): UsageSummary {
  const body = obj(raw) ?? {};
  const items: UsageItem[] = [];
  const bonuses: UsageBonus[] = [];
  let resetsAt = date(body.nextDateReset);
  for (const entry of Array.isArray(body.usageBreakdownList) ? body.usageBreakdownList : []) {
    const item = obj(entry);
    if (!item) continue;
    const resourceType = str(item.resourceType) ?? 'UNKNOWN';
    const rawLimit = num(item.usageLimitWithPrecision, item.usageLimit) ?? 0;
    const limit = rawLimit > 0 && rawLimit < UNLIMITED ? rawLimit : undefined;
    const used = num(item.currentUsageWithPrecision, item.currentUsage) ?? 0;
    items.push({
      resourceType,
      name: str(item.displayNamePlural) ?? str(item.displayName) ?? resourceType,
      used,
      limit,
      percentUsed: limit ? Math.min(100, Math.floor((used / limit) * 100)) : undefined,
    });
    bonuses.push(...bonusesOf(item));
    resetsAt ??= date(item.nextDateReset);
  }
  return {
    plan: str(obj(body.subscriptionInfo)?.subscriptionTitle),
    resetsAt,
    overagesEnabled: str(obj(body.overageConfiguration)?.overageStatus) === 'ENABLED',
    items,
    bonuses,
  };
}

export async function getUsageLimits(opts: {
  token: AccessToken;
  userAgent: string;
  fetch?: FetchFn;
  signal?: AbortSignal;
}): Promise<UsageSummary> {
  const { token } = opts;
  if (!token.region) throw new Error('unknown region: the kiro-cli token does not include a region');
  const q = new URLSearchParams({ origin: 'AI_EDITOR' });
  if (token.profileArn) q.set('profileArn', token.profileArn);
  const res = await (opts.fetch ?? fetch)(`${regionHost('management', token.region)}/getUsageLimits?${q}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token.token}`, Accept: 'application/json', 'User-Agent': opts.userAgent },
    signal: opts.signal,
  });
  if (!res.ok) throw await apiError('GetUsageLimits', res);
  return parseUsage(await res.json());
}

/**
 * Percentage for display, never overstating usage: one decimal below 10% (0.869% -> "0.8"), whole
 * numbers above (19.9% -> "19"). The Kiro IDE shows whole numbers only, which stays at 0% for the
 * first 1% of the plan.
 */
export function formatPercent(item: UsageItem, locale?: string): string | undefined {
  if (item.limit === undefined) return undefined;
  const exact = Math.min(100, (item.used / item.limit) * 100);
  const value = exact < 10 ? Math.floor(exact * 10) / 10 : Math.floor(exact);
  return value.toLocaleString(locale, { maximumFractionDigits: 1 });
}

/** The credit item, when the plan has one (the usual case). */
export function creditItem(u: UsageSummary): UsageItem | undefined {
  return u.items.find((i) => i.resourceType === 'CREDIT') ?? u.items[0];
}

/** Text progress bar, e.g. "▰▰▱▱▱▱▱▱▱▱" for 20%. */
export function progressBar(percent: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

export interface UsageTrackerOptions {
  getToken: () => Promise<AccessToken>;
  userAgent: string;
  ttlMs?: number;
  fetch?: FetchFn;
  now?: () => number;
  log?: (m: string) => void;
  /** Called after every successful refresh. */
  onChange?: (u: UsageSummary) => void;
}

/** Cached usage: refreshed when older than the TTL; on failure the last good value is kept. */
export class UsageTracker {
  private readonly opts: UsageTrackerOptions;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private cached: { usage: UsageSummary; at: number } | undefined;
  private inflight: Promise<UsageSummary | undefined> | undefined;
  /** Message of the last failure, cleared by the next success. */
  lastError: string | undefined;

  constructor(opts: UsageTrackerOptions) {
    this.opts = opts;
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  /** Last known usage, without fetching. */
  get current(): UsageSummary | undefined {
    return this.cached?.usage;
  }

  /** Fetches when stale (or `force`). Never throws: returns the last good value, or undefined. */
  refresh(opts: { force?: boolean } = {}): Promise<UsageSummary | undefined> {
    if (!opts.force && this.cached && this.now() - this.cached.at < this.ttlMs) {
      return Promise.resolve(this.cached.usage);
    }
    this.inflight ??= this.fetchOnce().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async fetchOnce(): Promise<UsageSummary | undefined> {
    try {
      const usage = await getUsageLimits({
        token: await this.opts.getToken(),
        userAgent: this.opts.userAgent,
        fetch: this.opts.fetch,
      });
      this.cached = { usage, at: this.now() };
      this.lastError = undefined;
      const credit = creditItem(usage);
      this.opts.log?.(
        `usage: ${usage.plan ?? 'unknown plan'}, ` +
          (credit ? `${credit.used} of ${credit.limit ?? 'unlimited'} ${credit.name.toLowerCase()}` : 'no usage items'),
      );
      this.opts.onChange?.(usage);
      return usage;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.opts.log?.(`usage: refresh failed: ${this.lastError}`);
      return this.cached?.usage;
    }
  }
}
