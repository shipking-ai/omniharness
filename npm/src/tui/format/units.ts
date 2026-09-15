/**
 * Number and duration formatting for a single terminal row.
 *
 * Every function here returns `undefined` rather than a placeholder when there
 * is nothing to say. That is deliberate: the calling views render a field only
 * when it is defined, so an unmeasured cost disappears instead of reading as
 * free, and an unmeasured latency disappears instead of reading as instant.
 */

import { activeGlyphs } from '../theme/tokens.js';

/** Tokens read the way they are spoken: exact while small, then thousands. */
export function tokens(n: number | undefined): string | undefined {
  if (n === undefined || !Number.isFinite(n) || n <= 0) return undefined;
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
  }
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Cost to four places under a cent, two above. Sub-cent spend is the ordinary
 * case for one turn, and "$0.00" reports every one of them as free.
 */
export function cost(usd: number | undefined): string | undefined {
  if (usd === undefined || !Number.isFinite(usd) || usd <= 0) return undefined;
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/** Latency in the unit that reads: milliseconds under a second, then seconds. */
export function millis(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return undefined;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  return `${Math.floor(ms / 60_000)}m${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}s`;
}

/** Elapsed wall time for a running task: always shown, so always a string. */
export function elapsed(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < 60_000) return `${Math.floor(safe / 1000)}s`;
  const minutes = Math.floor(safe / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1000);
  if (minutes < 60) return `${minutes}:${String(seconds).padStart(2, '0')}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * An age at a glance: the largest unit that still says something, one deep.
 * Anything under a minute is "now" — a snapshot saved seconds ago reading as
 * "0m ago" looks like a bug.
 */
export function since(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 52) return `${weeks}w ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/**
 * Shorten a path from the left, keeping the end. The tail identifies the
 * project; the head is usually a home directory nobody needs to read again.
 */
export function shortPath(value: string, width: number): string {
  if (width <= 1) return value.slice(-Math.max(1, width));
  if (value.length <= width) return value;
  const mark = activeGlyphs().ellipsis;
  return `${mark}${value.slice(-Math.max(1, width - mark.length))}`;
}
