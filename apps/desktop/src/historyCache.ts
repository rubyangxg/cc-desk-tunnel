import { useEffect } from 'react';
import type { SessionEvent } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import type { ConnectionProfile } from './connections.ts';

// Separate from the permanent cross-service archive. This cache can always be rebuilt from the source.
type Meta = { service: string; first: number; last: number; hasEarlier: boolean };
const namespace = (key: string) => `incremental:${key}`;
const range = (key: string, first = 0, last = Number.MAX_SAFE_INTEGER) =>
  IDBKeyRange.bound([namespace(key), first], [namespace(key), last]);
export const cacheKey = (profile: ConnectionProfile, sessionId: string) =>
  JSON.stringify([profile.id, profile.url, profile.fingerprint, sessionId]);
function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('cc-incremental-history', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('records');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function readHistoryCache(key: string, service: string) {
  const db = await database();
  try {
    return await new Promise<{ events: SessionEvent[]; hasEarlier: boolean } | null>(
      (resolve, reject) => {
        const tx = db.transaction('records', 'readonly');
        const store = tx.objectStore('records');
        const metadata = store.get(key);
        let result: { events: SessionEvent[]; hasEarlier: boolean } | null = null;
        metadata.onsuccess = () => {
          const meta: Meta | undefined = metadata.result;
          if (!meta || meta.service !== service) return;
          const records = store.getAll(range(key, meta.first, meta.last));
          records.onsuccess = () => {
            const events: SessionEvent[] = records.result;
            if (events[0]?.sequence === meta.first && events.at(-1)?.sequence === meta.last)
              result = { events, hasEarlier: meta.hasEarlier };
          };
        };
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(tx.error);
      },
    );
  } finally {
    db.close();
  }
}
export const progressKey = (profile: ConnectionProfile, sessionId: string) =>
  `progress:${cacheKey(profile, sessionId)}`;

export async function saveHistoryCache(
  key: string,
  service: string,
  events: SessionEvent[],
  hasEarlier: boolean,
  replace = false,
  resetOnGap = false,
) {
  if (!events.length) return false;
  const db = await database();
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction('records', 'readwrite');
      const store = tx.objectStore('records');
      let written = false;
      const request = store.get(key);
      request.onsuccess = () => {
        const old: Meta | undefined = request.result;
        const first = events[0]!.sequence;
        const last = events.at(-1)!.sequence;
        const previous = !replace && old?.service === service ? old : undefined;
        const overlap =
          previous &&
          events.find((e) => e.sequence >= previous.first && e.sequence <= previous.last);
        // A missing middle stays a missing middle. The handoff reader will fetch it explicitly.
        if (previous && !overlap && !resetOnGap) return;
        const write = (merge: boolean) => {
          written = true;
          if (!merge) store.delete(range(key));
          for (const event of events)
            if (
              !merge ||
              !previous ||
              event.sequence < previous.first ||
              event.sequence > previous.last
            )
              store.put(event, [namespace(key), event.sequence]);
          store.put(
            {
              service,
              first: merge ? Math.min(first, previous!.first) : first,
              last: merge ? Math.max(last, previous!.last) : last,
              hasEarlier: merge ? hasEarlier && previous!.hasEarlier : hasEarlier,
            } satisfies Meta,
            key,
          );
        };
        if (!overlap) {
          write(false);
          return;
        }
        const check = store.get([namespace(key), overlap.sequence]);
        check.onsuccess = () => write(JSON.stringify(check.result) === JSON.stringify(overlap));
      };
      tx.oncomplete = () => resolve(written);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function deleteHistoryCache(key: string) {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('records', 'readwrite');
      const store = tx.objectStore('records');
      store.delete(key);
      store.delete(range(key));
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
export const clearHistoryProgress = (profile: ConnectionProfile, sessionId: string) =>
  deleteHistoryCache(progressKey(profile, sessionId));

const foregroundReads = new WeakMap<ProxyClient, number>();
export function holdHistoryWarmup(client: ProxyClient) {
  foregroundReads.set(client, (foregroundReads.get(client) ?? 0) + 1);
  return () => foregroundReads.set(client, Math.max(0, (foregroundReads.get(client) ?? 1) - 1));
}

async function metadata(key: string, service: string) {
  const db = await database();
  try {
    return await new Promise<Meta | null>((resolve, reject) => {
      const tx = db.transaction('records', 'readonly');
      const request = tx.objectStore('records').get(key);
      tx.oncomplete = () => resolve(request.result?.service === service ? request.result : null);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

// Only the requested cursor can extend this contiguous range. Another page or a foreground
// replacement that wins the transaction makes this reply stale; never splice it into a new range.
async function prependCache(
  key: string,
  service: string,
  before: number,
  events: SessionEvent[],
  hasEarlier: boolean,
) {
  const db = await database();
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction('records', 'readwrite');
      const store = tx.objectStore('records');
      const request = store.get(key);
      let written = false;
      request.onsuccess = () => {
        const meta: Meta | undefined = request.result;
        if (!meta || meta.service !== service || meta.first !== before || !meta.hasEarlier) return;
        for (const event of events) store.put(event, [namespace(key), event.sequence]);
        store.put(
          { ...meta, first: events[0]?.sequence ?? before, hasEarlier } satisfies Meta,
          key,
        );
        written = true;
      };
      tx.oncomplete = () => resolve(written);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

// A single low-priority page across all live services. Never subscribe/select: that would replace
// the active session's event stream. Callers pace pages and back off after failures.
let warming = false;
export async function warmHistoryCache(
  client: ProxyClient,
  profile: ConnectionProfile,
  cancelled = () => false,
) {
  const { selectedId: id, connectionId, service } = client.state;
  const session = client.state.sessions.find((s) => s.id === id);
  const idle = () => {
    const history = id && client.state.history[id];
    return (
      !cancelled() &&
      !foregroundReads.get(client) &&
      client.state.status === 'connected' &&
      client.state.connectionId === connectionId &&
      client.state.service === service &&
      client.state.selectedId === id &&
      !!history &&
      !history.loading &&
      !history.loadingEarlier &&
      !client.state.sessions.some((s) => s.activeRun) &&
      client.state.sessions.find((s) => s.id === id)?.updatedAt === session?.updatedAt
    );
  };
  if (warming) return 'busy' as const;
  if (!id || !service || !session || !idle()) return false;
  warming = true;
  try {
    const key = cacheKey(profile, id);
    const meta = await metadata(key, service);
    if (!meta?.hasEarlier || !idle()) return false;
    const page = await client.fetch({
      type: 'session.history',
      sessionId: id,
      beforeSequence: meta.first,
    });
    if (!idle()) return false;
    if (
      page.session.id !== id ||
      page.session.updatedAt !== session.updatedAt ||
      page.mode !== 'prepend' ||
      page.firstSequence !== (page.events[0]?.sequence ?? 0) ||
      page.lastSequence !== (page.events.at(-1)?.sequence ?? 0) ||
      (page.hasEarlier && !page.events.length) ||
      page.events.some(
        (event, index) =>
          event.sessionId !== id ||
          event.sequence >= meta.first ||
          (index > 0 && event.sequence <= page.events[index - 1]!.sequence),
      )
    )
      throw new Error('后台历史分页不一致。');
    return await prependCache(key, service, meta.first, page.events, page.hasEarlier);
  } finally {
    warming = false;
  }
}

// One batch per five seconds; only newly recorded events are written. Stream fragments and pending
// tools are never fabricated as complete records. Cache failures do not stop a running task.
export function startHistoryCache(client: ProxyClient, profile: ConnectionProfile) {
  let pending = false;
  let stopped = false;
  const saved = new Map<string, string>();
  let nextWarmup = Date.now() + 10000;
  const flush = async () => {
    if (pending || client.state.status !== 'connected' || !client.state.service) return;
    pending = true;
    try {
      for (const [id, events] of Object.entries(client.state.events)) {
        if (stopped) break;
        if (id !== client.state.selectedId) continue;
        const history = client.state.history[id];
        if (
          !history ||
          history.loading ||
          history.loadingEarlier ||
          !events.length ||
          events[0]!.sequence !== history.firstSequence ||
          events.at(-1)!.sequence !== history.lastSequence
        )
          continue;
        const service = client.state.service!;
        const signature = JSON.stringify([
          service,
          history.firstSequence,
          history.lastSequence,
          history.hasEarlier,
        ]);
        if (saved.get(id) === signature) continue;
        try {
          if (await saveHistoryCache(cacheKey(profile, id), service, events, history.hasEarlier))
            saved.set(id, signature);
        } catch {
          /* Rebuild from the source if local storage is full or unavailable. */
        }
      }
      if (!stopped && Date.now() >= nextWarmup) {
        nextWarmup = Date.now() + 10000;
        try {
          const result = await warmHistoryCache(client, profile, () => stopped);
          // Stagger busy clients so one service cannot monopolize every timer tick.
          nextWarmup = Date.now() + (result === 'busy' ? 5000 : 10000);
        } catch {
          // A cache miss/failure cannot interrupt work or cause a retry storm.
          nextWarmup = Date.now() + 60000;
        }
      }
    } finally {
      pending = false;
    }
  };
  const timer = setInterval(() => void flush(), 5000);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export function useHistoryCache(client: ProxyClient, profile: ConnectionProfile, enabled = true) {
  useEffect(
    () => (enabled ? startHistoryCache(client, profile) : undefined),
    [client, profile.id, profile.url, profile.fingerprint, enabled],
  );
}
