import type { Credentials } from './credentials.ts';

export interface LoadResult {
  /** Em ordem de prioridade dentro da fonte. */
  credentials: Credentials[];
  /** Observações legíveis (ex.: "banco não encontrado em ..."). Nunca contêm segredos. */
  notes: string[];
}

export interface CredentialSource {
  readonly id: string;
  readonly label: string;
  load(): Promise<LoadResult>;
}

export type Logger = (message: string) => void;
