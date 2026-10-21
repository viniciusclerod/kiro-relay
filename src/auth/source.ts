import type { Credentials } from './credentials.ts';

export interface LoadResult {
  /** In priority order within the source. */
  credentials: Credentials[];
  /** Human-readable notes (e.g. "database not found at ..."). Never contain secrets. */
  notes: string[];
}

export interface CredentialSource {
  readonly id: string;
  readonly label: string;
  load(): Promise<LoadResult>;
}

export type Logger = (message: string) => void;
