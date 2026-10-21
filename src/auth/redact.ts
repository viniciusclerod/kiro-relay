import { createHash } from 'node:crypto';

/** Identificador curto e não reversível do token, útil para ver se ele rotacionou. */
export function fingerprint(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 8);
}

export function formatDuration(ms: number): string {
  const abs = Math.abs(ms);
  const totalMin = Math.floor(abs / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const text = h > 0 ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
  return ms < 0 ? `expirado há ${text}` : `expira em ${text}`;
}
