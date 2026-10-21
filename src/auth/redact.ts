import { createHash } from 'node:crypto';

/** Short, non-reversible identifier of a secret, useful to see whether it rotated. */
export function fingerprint(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 8);
}

/** "1 h 05 min" or "42 min" for the absolute value of `ms`. The units read the same in English and Portuguese. */
export function formatHoursMinutes(ms: number): string {
  const totalMin = Math.floor(Math.abs(ms) / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
}

export function formatDuration(ms: number): string {
  const text = formatHoursMinutes(ms);
  return ms < 0 ? `expired ${text} ago` : `expires in ${text}`;
}
