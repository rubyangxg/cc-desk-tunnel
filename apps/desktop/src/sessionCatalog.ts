import type { Session } from '@cc-desk-tunnel/protocol';
import type { ConnectionProfile } from './connections.ts';

// Only routing metadata and session titles are cached. Never store a connection token here.
export type SessionSource = Pick<ConnectionProfile, 'id' | 'url' | 'fingerprint' | 'name'>;
export type CatalogEntry = { source: SessionSource; sessions: Session[]; checkedAt: number };
export type OtherSession = { source: SessionSource; session: Session; display: Session };
export const sessionSource = (profile: ConnectionProfile): SessionSource => ({
  id: profile.id,
  url: new URL(profile.url).toString(),
  fingerprint: profile.fingerprint.replaceAll(':', '').toLowerCase(),
  name: profile.name,
});
export const sourceKey = (source: SessionSource) =>
  JSON.stringify([source.id, source.url, source.fingerprint]);
const endpoint = (source: SessionSource) => JSON.stringify([source.url, source.fingerprint]);

export function otherSessions(
  entries: CatalogEntry[],
  active: SessionSource,
  configured: SessionSource[],
) {
  const seen = new Set<string>();
  const servers = new Set([endpoint(active)]);
  const result: OtherSession[] = [];
  // Aliases of one endpoint share a catalog; a newer empty list must win over an older alias.
  for (const entry of [...entries].sort((a, b) => b.checkedAt - a.checkedAt)) {
    const source = configured.find((source) => sourceKey(source) === sourceKey(entry.source));
    if (!source || servers.has(endpoint(source))) continue;
    servers.add(endpoint(source));
    for (const session of entry.sessions) {
      const identity = JSON.stringify([endpoint(source), session.id]);
      if (seen.has(identity)) continue;
      seen.add(identity);
      result.push({
        source,
        session,
        // These IDs belong to the sidebar only and must never be sent to a server.
        display: { ...session, id: `catalog:${identity}`, activeRun: null },
      });
    }
  }
  return result.sort((a, b) => b.session.updatedAt.localeCompare(a.session.updatedAt));
}

async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('cc-session-catalog', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('sources');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('无法读取本机会话列表。'));
  });
}
export async function readCatalog(): Promise<CatalogEntry[]> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction('sources', 'readonly');
      const request = transaction.objectStore('sources').getAll();
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(new Error('读取本机会话列表失败。'));
    });
  } finally {
    db.close();
  }
}
export async function writeCatalog(
  source: SessionSource,
  sessions: Session[],
  checkedAt = Date.now(),
) {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('sources', 'readwrite');
      // A successful empty list removes deleted sessions. Failures never overwrite the previous list.
      const store = transaction.objectStore('sources');
      const previous = store.get(sourceKey(source));
      previous.onsuccess = () => {
        if ((previous.result?.checkedAt ?? 0) <= checkedAt)
          store.put(
            {
              source,
              sessions: sessions.map(
                ({
                  id,
                  title,
                  autoTitle,
                  projectPath,
                  device,
                  model,
                  effort,
                  permissionMode,
                  createdAt,
                  updatedAt,
                }) => ({
                  id,
                  title,
                  autoTitle,
                  projectPath,
                  device,
                  model,
                  effort,
                  permissionMode,
                  createdAt,
                  updatedAt,
                  activeRun: null,
                }),
              ),
              checkedAt,
            },
            sourceKey(source),
          );
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(new Error('保存本机会话列表失败。'));
    });
    window.dispatchEvent(new Event('session-catalog-changed'));
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel('cc-session-catalog');
      channel.postMessage('changed');
      channel.close();
    }
  } finally {
    db.close();
  }
}
