// Per-session ACP state: an in-memory LRU backed by versioned localStorage entries.

import { useCallback, useSyncExternalStore } from "react";
import { lastUserBoundaryIndex } from "../../lib/acpHistoryWindow";
import { emptyAcpState, normaliseTurnState, type AcpState, type BackgroundAgent } from "../../lib/acpTypes";
import {
  STORAGE_KEY_PREFIX,
  STATE_TTL_MS,
  clearQueueCount,
  setQueueCount,
  type PersistedEntry,
} from "../../lib/acpStateStorage";
import { safeSetItem } from "../../lib/safeStorage";

const STATE_CACHE_CAP = 32;
const stateCache = new Map<string, AcpState>();
const stateListeners = new Map<string, Set<() => void>>();

function storageKey(sessionId: string): string {
  return STORAGE_KEY_PREFIX + sessionId;
}

/** A stored entry with a usable timestamp, or null when it is missing or corrupt. */
function parseEntry(raw: string | null): PersistedEntry | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as PersistedEntry | null;
    return parsed && typeof parsed.savedAt === "number" && !Number.isNaN(parsed.savedAt) ? parsed : null;
  } catch {
    return null;
  }
}

function persistedKeys(): string[] {
  const keys: string[] = [];
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i);
    if (k?.startsWith(STORAGE_KEY_PREFIX)) keys.push(k);
  }
  return keys;
}

// Only ever touches `aoe:acp-state:v1:*`: drafts and other keys are authoritative and must survive.
export function evictOldestPersistedAcpState(currentKey: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    let firstCorruptKey: string | null = null;
    for (const k of persistedKeys()) {
      if (k === currentKey) continue;
      const raw = window.localStorage.getItem(k);
      if (raw === null) continue;
      // `savedAt` is the first property `persistState` writes, so read it from the prefix instead of parsing a
      // multi-MB blob per sibling on every quota failure. A non-matching entry counts as corrupt and goes first.
      const m = /^\{"savedAt":(\d+),/.exec(raw);
      if (!m) {
        firstCorruptKey ??= k;
        continue;
      }
      const savedAt = Number(m[1]);
      if (savedAt < oldestTime) {
        oldestTime = savedAt;
        oldestKey = k;
      }
    }
    const victim = firstCorruptKey ?? oldestKey;
    if (!victim) return false;
    window.localStorage.removeItem(victim);
    return true;
  } catch {
    return false;
  }
}

// Optimistic rows and in-flight ids are ephemeral, and attachment bytes would blow the quota
// (text alone would drain a degraded prompt on reload), so none of them are persisted.
function toPersistedState(state: AcpState): AcpState {
  const base: AcpState =
    state.optimisticRows.length > 0 || state.inflightPromptIds.length > 0
      ? { ...state, optimisticRows: [], inflightPromptIds: [] }
      : state;
  if (!base.queuedPrompts.some((q) => q.attachments?.length)) return base;
  return { ...base, queuedPrompts: base.queuedPrompts.filter((q) => !q.attachments?.length) };
}

/** Entries above this are not persisted: they cannot fit the quota beside their siblings, so a write would only
 *  fail, evict, and fail again, and a reload replays from the server anyway. The stale smaller entry is dropped so
 *  a reload never hydrates an old prefix of a session that has moved far past it. */
export const MAX_PERSIST_BYTES = 2 * 1024 * 1024;

export function persistState(sessionId: string, state: AcpState): void {
  const key = storageKey(sessionId);
  const body = JSON.stringify({ savedAt: Date.now(), state: toPersistedState(state) } satisfies PersistedEntry);
  if (body.length > MAX_PERSIST_BYTES) {
    removePersisted(() => [key]);
    setQueueCount(sessionId, state.queuedPrompts.length);
    return;
  }
  // On a quota failure evict one entry and retry once; the cache is best effort.
  if (safeSetItem(key, body) || (evictOldestPersistedAcpState(key) && safeSetItem(key, body))) {
    setQueueCount(sessionId, state.queuedPrompts.length);
  }
}

// Rows with no user prompt and older history pending would open mid-turn. Drop the rows and cursor so replay
// reloads the transcript from the tail; folded control state keeps its own cursor and is untouched.
function reopenState(state: AcpState): AcpState {
  if (state.oldestSeq > 1 && lastUserBoundaryIndex(state.activity) < 0) return { ...state, activity: [], oldestSeq: 0 };
  return state;
}

export function loadPersistedState(sessionId: string): AcpState | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const parsed = parseEntry(window.localStorage.getItem(storageKey(sessionId)));
    if (!parsed || typeof parsed.state !== "object" || parsed.state === null) return undefined;
    const state = parsed.state as Partial<AcpState>;
    if (
      Date.now() - parsed.savedAt > STATE_TTL_MS ||
      typeof state.lastSeq !== "number" ||
      !Array.isArray(state.activity) ||
      !Array.isArray(state.queuedPrompts)
    ) {
      window.localStorage.removeItem(storageKey(sessionId));
      return undefined;
    }
    // Merge over defaults so entries from an older bundle gain newly added fields.
    return reopenState(normaliseTurnState({ ...emptyAcpState(), ...(state as AcpState) }));
  } catch {
    return undefined;
  }
}

function removePersisted(keys: () => string[]): void {
  if (typeof window === "undefined") return;
  try {
    for (const k of keys()) window.localStorage.removeItem(k);
  } catch {
    // Storage unavailable.
  }
}

let sweptStorage = false;
export function sweepExpiredStorage(): void {
  if (sweptStorage) return;
  sweptStorage = true;
  const now = Date.now();
  removePersisted(() =>
    persistedKeys().filter((k) => {
      const parsed = parseEntry(window.localStorage.getItem(k));
      return !parsed || now - parsed.savedAt > STATE_TTL_MS;
    }),
  );
}

function lruInsert(sessionId: string, value: AcpState): void {
  stateCache.delete(sessionId);
  stateCache.set(sessionId, value);
  while (stateCache.size > STATE_CACHE_CAP) {
    const oldest = stateCache.keys().next().value;
    if (oldest === undefined) break;
    stateCache.delete(oldest);
  }
}

export function cacheGet(sessionId: string): AcpState | undefined {
  const memory = stateCache.get(sessionId);
  const value = memory ? reopenState(memory) : loadPersistedState(sessionId);
  if (value === undefined) return undefined;
  lruInsert(sessionId, value);
  // Wake subscribers that rendered before the cache was primed or saw a pre-reset entry; deferred so it never fires mid-render.
  if (value !== memory) queueMicrotask(() => notifyStateListeners(sessionId));
  return value;
}

// `reduced_state` arrives after every event and always yields a fresh state, so `cacheSet` runs at the full event
// rate. Serializing a whole transcript at that rate made multi-GB tabs after a day, so the localStorage mirror is
// debounced: the in-memory cache and listeners stay synchronous, only stringify+write coalesces. `pagehide` flushes
// so the tab-eviction reload this mirror exists for still sees the last state.
const PERSIST_DEBOUNCE_MS = 1_000;
const pendingPersists = new Map<string, AcpState>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;

export function flushPendingPersists(): void {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const entries = [...pendingPersists.entries()];
  pendingPersists.clear();
  for (const [id, state] of entries) persistState(id, state);
}

export function schedulePersist(sessionId: string, state: AcpState): void {
  pendingPersists.set(sessionId, state);
  persistTimer ??= setTimeout(flushPendingPersists, PERSIST_DEBOUNCE_MS);
}

if (typeof window !== "undefined") window.addEventListener("pagehide", flushPendingPersists);

export function cacheSet(sessionId: string, value: AcpState): void {
  lruInsert(sessionId, value);
  schedulePersist(sessionId, value);
  notifyStateListeners(sessionId);
}

function notifyStateListeners(sessionId: string): void {
  for (const cb of stateListeners.get(sessionId) ?? []) cb();
}

function subscribeAcpState(sessionId: string, cb: () => void): () => void {
  let set = stateListeners.get(sessionId);
  if (!set) {
    set = new Set();
    stateListeners.set(sessionId, set);
  }
  set.add(cb);
  return () => {
    const s = stateListeners.get(sessionId);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) stateListeners.delete(sessionId);
  };
}

const EMPTY_BACKGROUND_AGENTS: BackgroundAgent[] = [];

/** Background agents for a session, read from the cache so sibling panels need no second WebSocket. */
export function useBackgroundAgents(sessionId: string | null): BackgroundAgent[] {
  const subscribe = useCallback(
    (cb: () => void) => (sessionId ? subscribeAcpState(sessionId, cb) : () => {}),
    [sessionId],
  );
  const getSnapshot = useCallback(
    () => (sessionId ? stateCache.get(sessionId)?.backgroundAgents : undefined) ?? EMPTY_BACKGROUND_AGENTS,
    [sessionId],
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Drop one session's cached state, or all of it, so a reused id never shows a prior transcript. */
export function clearAcpCache(sessionId?: string): void {
  // Discard any debounced write too, or the flush would resurrect the entry this call drops.
  if (sessionId === undefined) {
    pendingPersists.clear();
    stateCache.clear();
    removePersisted(persistedKeys);
  } else {
    pendingPersists.delete(sessionId);
    stateCache.delete(sessionId);
    removePersisted(() => [storageKey(sessionId)]);
  }
  clearQueueCount(sessionId);
}
