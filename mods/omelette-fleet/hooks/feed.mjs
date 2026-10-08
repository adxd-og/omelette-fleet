/**
 * omelette-fleet :: mods/omelette-fleet/hooks/feed.mjs
 * The status feed as the pane reads it (1.7.0): which files of the fleet home
 * are unit snapshots, and one snapshot's text (schema 2, docs/STATUS-FEED.md)
 * as the model's `feed` event takes it. Pure: register.tsx lists and reads
 * the files, this only looks at names and text.
 */
import { UNITS } from './model.mjs';

/**
 * @typedef {{ id: string, tool: string, model: string|null, effort: string|null, startedAt: number }} FleetFeedCall
 * @typedef {{ unit: string, pid: number, active: FleetFeedCall[], updatedAt: number, lastEndedAt?: number, isStale: boolean }} FleetSnapshot
 */

/**
 * The feed has no heartbeat: a snapshot is rewritten on events only, so a live
 * call keeps the `updatedAt` of its start. 2 hours is above the longest default
 * run (a deep research takes about 36 minutes); a call still listed after that
 * is left by a process that is gone.
 */
const STALE_MS = 2 * 60 * 60 * 1000;
const SNAPSHOT_NAME = new RegExp(`^status-(?:${UNITS.join('|')})-\\d+\\.json$`);

/**
 * The names that are a unit's per-process snapshot, `status-<unit>-<pid>.json`,
 * in the order given; anything else (the log, a temp file, a schema-1
 * `status-<unit>.json`, another program's file) is dropped.
 * @param {string[]} names
 * @returns {string[]}
 */
export function snapshotNames(names) {
  return (Array.isArray(names) ? names : []).filter((name) => typeof name === 'string' && SNAPSHOT_NAME.test(name));
}

/** An ISO time in ms, or undefined when it is not one. */
function msOf(value) {
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

const stringOrNull = (value) => (typeof value === 'string' ? value : null);

/** One `active[]` entry, or null when it has no tool or no start time. */
function callOf(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.tool !== 'string') return null;
  const startedAt = msOf(entry.startedAt);
  if (startedAt === undefined) return null;
  return { id: String(entry.id ?? ''), tool: entry.tool, model: stringOrNull(entry.model), effort: stringOrNull(entry.effort), startedAt };
}

/**
 * One snapshot file's text. Null for text that is not JSON, not an object,
 * `schema !== 2`, a unit outside UNITS, or an `updatedAt` that is not a time.
 * A snapshot with calls in `active` and an `updatedAt` more than 30 minutes
 * before `now` is stale: its `active` is returned empty.
 * @param {string} text
 * @param {number} now
 * @returns {FleetSnapshot | null}
 */
export function parseSnapshot(text, now) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.schema !== 2 || !UNITS.includes(raw.unit)) return null;
  const updatedAt = msOf(raw.updatedAt);
  if (updatedAt === undefined) return null;
  const active = (Array.isArray(raw.active) ? raw.active : []).map(callOf).filter(Boolean);
  const isStale = active.length > 0 && now - updatedAt > STALE_MS;
  const lastEndedAt = msOf(raw.lastEvent?.endedAt);
  return {
    unit: raw.unit,
    pid: raw.pid,
    active: isStale ? [] : active,
    updatedAt,
    ...(lastEndedAt !== undefined && { lastEndedAt }),
    isStale,
  };
}
