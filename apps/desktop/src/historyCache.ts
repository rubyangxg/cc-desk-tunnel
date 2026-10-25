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
export async function saveHistoryCache(
  key: string,
  service: string,
  events: SessionEvent[],
  hasEarlier: boolean,
  replace = false,
) {
  if (!events.length) return;
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('records', 'readwrite');
      const store = tx.objectStore('records');
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
        if (previous && !overlap) return;
        const write = (merge: boolean) => {
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
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

// One batch per five seconds; only newly recorded events are written. Stream fragments and pending
// tools are never fabricated as complete records. Cache failures do not stop a running task.
export function useHistoryCache(client: ProxyClient, profile: ConnectionProfile, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    let pending = false;
    let stopped = false;
    const saved = new Map<string, string>();
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
            await saveHistoryCache(cacheKey(profile, id), service, events, history.hasEarlier);
            saved.set(id, signature);
          } catch {
            /* Rebuild from the source if local storage is full or unavailable. */
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
  }, [client, profile.id, profile.url, profile.fingerprint, enabled]);
}
