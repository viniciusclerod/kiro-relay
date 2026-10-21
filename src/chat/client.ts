// GenerateAssistantResponse client with the retry rules. Pure module: no vscode.
//
// Retries happen only before any output reaches the caller:
//  - HTTP 403: re-read the kiro-cli credentials and retry once;
//  - HTTP 429/5xx and network errors: back off and retry;
//  - no output within firstOutputTimeoutMs: retry.
// After the first text, reasoning or tool call is yielded, errors propagate and nothing is retried.

import type { AccessToken } from '../auth/tokenProvider.ts';
import { KiroApiError, apiError, regionHost, type FetchFn } from '../kiro/api.ts';
import { decodeEventStream } from './eventstream.ts';
import { parseChatEvents, type ChatEvent } from './response.ts';

export const TARGET = 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse';

export interface ChatRequestOptions {
  getToken: (opts?: { forceReload?: boolean }) => Promise<AccessToken>;
  /** Builds the body; called per attempt because it depends on the token (profile ARN). */
  buildBody: (token: AccessToken) => Record<string, unknown>;
  userAgent: string;
  fetch?: FetchFn;
  signal?: AbortSignal;
  maxAttempts?: number;
  firstOutputTimeoutMs?: number;
  /** Backoff before retry n (1-based). */
  backoffMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (m: string) => void;
}

/** No output arrived in time, on every attempt. */
export class FirstOutputTimeoutError extends Error {
  constructor(ms: number) {
    super(`no output from Kiro within ${Math.round(ms / 1000)} s`);
    this.name = 'FirstOutputTimeoutError';
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Reads the body, but stops as soon as `signal` aborts, whatever the fetch implementation does
 * with its own stream on abort.
 */
async function* abortable(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  aborted.catch(() => {});
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) return;
      yield value;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.cancel().catch(() => {});
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Streams chat events. Returns quietly when `signal` is aborted. */
export async function* streamChat(opts: ChatRequestOptions): AsyncGenerator<ChatEvent> {
  const doFetch = opts.fetch ?? fetch;
  const maxAttempts = opts.maxAttempts ?? 3;
  const firstOutputTimeoutMs = opts.firstOutputTimeoutMs ?? 15_000;
  const backoff = opts.backoffMs ?? ((n) => 1000 * 2 ** (n - 1));
  const sleep = opts.sleep ?? defaultSleep;
  const log = opts.log ?? (() => {});
  let reloaded = false;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts.signal?.aborted) return;
    if (attempt > 1 && lastError !== undefined && !(lastError instanceof KiroApiError && lastError.status === 403)) {
      await sleep(backoff(attempt - 1));
      if (opts.signal?.aborted) return;
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, firstOutputTimeoutMs);
    let started = false;

    try {
      const token = await opts.getToken({ forceReload: reloaded });
      if (!token.region) throw new Error('unknown region: the kiro-cli token does not include a region');
      const res = await doFetch(`${regionHost('runtime', token.region)}/generateAssistantResponse`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token.token}`,
          'Content-Type': 'application/x-amz-json-1.0',
          'x-amz-target': TARGET,
          'x-amzn-kiro-agent-mode': 'vibe',
          'User-Agent': opts.userAgent,
        },
        body: JSON.stringify(opts.buildBody(token)),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = await apiError('GenerateAssistantResponse', res);
        if (err.status === 403 && !reloaded) {
          log('chat: HTTP 403, re-reading credentials and retrying');
          reloaded = true;
          lastError = err;
          continue;
        }
        if (isRetryableStatus(err.status) && attempt < maxAttempts) {
          log(`chat: HTTP ${err.status}, retrying (attempt ${attempt + 1}/${maxAttempts})`);
          lastError = err;
          continue;
        }
        throw err;
      }
      if (!res.body) throw new Error('GenerateAssistantResponse: empty response body');

      const chunks = abortable(res.body as ReadableStream<Uint8Array>, controller.signal);
      for await (const event of parseChatEvents(decodeEventStream(chunks))) {
        if (!started && event.type !== 'end') {
          started = true;
          clearTimeout(timer);
        }
        yield event;
      }
      return;
    } catch (e) {
      if (opts.signal?.aborted) return;
      // Only transient failures are retried: the first-output timeout and network errors (fetch
      // throws TypeError). Auth errors, bad requests and stream exceptions are not.
      if (started || !(timedOut || e instanceof TypeError)) throw e;
      lastError = timedOut ? new FirstOutputTimeoutError(firstOutputTimeoutMs) : e;
      if (attempt >= maxAttempts) throw lastError;
      log(`chat: ${(lastError as Error).message}; retrying (attempt ${attempt + 1}/${maxAttempts})`);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (!started) controller.abort();
    }
  }
  throw lastError ?? new Error('GenerateAssistantResponse failed');
}
