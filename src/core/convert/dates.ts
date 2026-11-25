function localParts(ms: number, timeZone: string): { year: string; month: string; day: string; time: string } | undefined {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms));
    const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
    return { year: get('year'), month: get('month'), day: get('day'), time: `${get('hour')}:${get('minute')}:${get('second')}` };
  } catch {
    return undefined;
  }
}

/**
 * The calendar day a Quip date value stands for, as YYYY-MM-DD, or undefined when the value is not a timestamp.
 *
 * Quip stores a date-only value as local midnight in the author's time zone. If the instant is
 * midnight in the reader's zone (a personal account is usually written and read in one zone), that
 * is the date. Otherwise the nearest UTC midnight recovers the day for authors between UTC-12 and
 * UTC+11:59; authors further east, read from a different zone, can still be one day off, which `onGuess` reports.
 */
export function dayFromEpoch(value: unknown, timeZone = 'UTC', onGuess?: (date: string) => void): string | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  if (!Number.isFinite(n)) return undefined;
  const local = localParts(n, timeZone);
  if (local && local.time === '00:00:00') return `${local.year}-${local.month}-${local.day}`;
  const day = 86_400_000;
  const date = new Date(Math.round(n / day) * day).toISOString().slice(0, 10);
  // Neither the reader's midnight nor UTC midnight: the day is the nearest guess, which the caller can flag.
  if (n % day !== 0) onGuess?.(date);
  return date;
}
