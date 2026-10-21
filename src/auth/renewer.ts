// Asks kiro-cli to renew its own token by running a cheap command. Pure module: no vscode.
//
// Observed on 2026-10-21 (kiro-cli 2.33.0, IdC): `kiro-cli whoami` renews the access token once it
// has expired (or is about to), writes it to kiro-cli's database, and leaves it alone while it is
// still valid. The extension never touches the refresh token: kiro-cli does the renewal.

import { execFile } from 'node:child_process';

export type RunFn = (
  file: string,
  args: string[],
  opts: { timeout: number },
) => Promise<{ exitCode: number }>;

export interface RenewerOptions {
  cliPath: string;
  /** Arguments for kiro-cli, e.g. ["whoami"]. Empty disables renewal. */
  args: string[];
  timeoutMs?: number;
  /** Minimum time between two runs, so an ended session does not spawn kiro-cli on every call. */
  minIntervalMs?: number;
  run?: RunFn;
  now?: () => number;
  log?: (m: string) => void;
}

export type RenewOutcome =
  | { status: 'ran'; exitCode: number; durationMs: number }
  | { status: 'skipped'; reason: 'disabled' | 'too-soon' }
  | { status: 'failed'; error: string; durationMs: number };

/** Runs a command without a shell. Output is discarded: it may contain the user's e-mail. */
export const defaultRun: RunFn = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: opts.timeout, windowsHide: true }, (error) => {
      if (!error) return resolve({ exitCode: 0 });
      const e = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
      if (typeof e.code === 'number' && !e.killed) return resolve({ exitCode: e.code });
      reject(error);
    });
  });

export class KiroCliRenewer {
  private readonly opts: Required<Omit<RenewerOptions, 'log'>> & { log: (m: string) => void };
  private lastRunAt: number | undefined;
  private inflight: Promise<RenewOutcome> | undefined;
  /** Last outcome, for diagnostics. */
  last: (RenewOutcome & { at: number }) | undefined;

  constructor(opts: RenewerOptions) {
    this.opts = {
      timeoutMs: 20_000,
      minIntervalMs: 60_000,
      run: defaultRun,
      now: Date.now,
      log: () => {},
      ...opts,
    };
  }

  get enabled(): boolean {
    return this.opts.args.length > 0;
  }

  get commandLine(): string {
    return [this.opts.cliPath, ...this.opts.args].join(' ');
  }

  /** Single-flight and rate-limited. Never throws. */
  renew(): Promise<RenewOutcome> {
    if (!this.enabled) return Promise.resolve({ status: 'skipped', reason: 'disabled' });
    if (this.inflight) return this.inflight;
    const now = this.opts.now();
    if (this.lastRunAt !== undefined && now - this.lastRunAt < this.opts.minIntervalMs) {
      return Promise.resolve({ status: 'skipped', reason: 'too-soon' });
    }
    this.lastRunAt = now;
    this.inflight = this.runOnce().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async runOnce(): Promise<RenewOutcome> {
    const started = this.opts.now();
    let outcome: RenewOutcome;
    try {
      const { exitCode } = await this.opts.run(this.opts.cliPath, this.opts.args, { timeout: this.opts.timeoutMs });
      outcome = { status: 'ran', exitCode, durationMs: this.opts.now() - started };
      this.opts.log(`renewal: ran "${this.commandLine}" (exit ${exitCode}, ${outcome.durationMs} ms)`);
    } catch (e) {
      // Never use err.message: for a failed command it includes kiro-cli's stderr.
      const err = e as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
      const error =
        err.code === 'ENOENT'
          ? `executable not found: ${this.opts.cliPath}`
          : err.killed
            ? `timed out after ${this.opts.timeoutMs} ms`
            : `failed (${err.code ?? err.signal ?? 'unknown error'})`;
      outcome = { status: 'failed', error, durationMs: this.opts.now() - started };
      this.opts.log(`renewal: "${this.commandLine}" failed: ${error}`);
    }
    this.last = { ...outcome, at: started };
    return outcome;
  }
}
