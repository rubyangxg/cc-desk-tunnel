import type { Session, SessionEvent } from '@cc-desk-tunnel/protocol';
import type { ConnectionProfile } from './connections.ts';

export type HistorySegment = {
  key: string;
  service: string;
  account?: string;
  session: Session;
  events: SessionEvent[];
};
export type SharedHistory = {
  segments: HistorySegment[];
  prompt: string;
  forward?: { profileId: string; url: string; sessionId: string };
};
type StoredHistory = Omit<SharedHistory, 'segments'> & {
  storageVersion: 2;
  segments: (Omit<HistorySegment, 'events'> & { chunks: string[] })[];
};
type Archive = SharedHistory | StoredHistory;

// Keep the original database and keys so existing histories remain readable. New records contain
// small references; immutable transcript chunks are shared by pending, source and destination records.
export const historyKey = (profile: ConnectionProfile, sessionId: string) =>
  JSON.stringify([profile.id, profile.url, sessionId]);
const chunkKey = (hash: string) => ['chunk', hash];
const forwardKey = (key: string) => ['forward', key];
const chunkBytes = 512 * 1024;
const chunked = (value: Archive): value is StoredHistory =>
  'storageVersion' in value && value.storageVersion === 2;

function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('cc-shared-conversations', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('history');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function storageError(message: string, cause: unknown) {
  const name = cause instanceof Error ? cause.name : '';
  const reason: Record<string, string> = {
    QuotaExceededError: '本地存储空间不足，请释放磁盘空间后重试',
    AbortError: '本地存储事务被中断',
    UnknownError: '本地存储读写异常',
    InvalidStateError: '本地历史数据库不可用',
    DataError: '本地历史数据不完整，请保留原会话',
  };
  return new Error(`${message}（${reason[name] ?? (name || '未知存储错误')}）`, { cause });
}

export async function sharedHistory(key: string): Promise<SharedHistory | null> {
  let db: IDBDatabase | undefined;
  try {
    db = await database();
    return await new Promise<SharedHistory | null>((resolve, reject) => {
      const tx = db!.transaction('history', 'readonly');
      const store = tx.objectStore('history');
      const request = store.get(key);
      const forward = store.get(forwardKey(key));
      const chunks = new Map<string, IDBRequest>();
      request.onsuccess = () => {
        const value: Archive | undefined = request.result;
        if (value && chunked(value))
          for (const segment of value.segments)
            for (const hash of segment.chunks)
              if (!chunks.has(hash)) chunks.set(hash, store.get(chunkKey(hash)));
      };
      tx.oncomplete = () => {
        try {
          const value: Archive | undefined = request.result;
          if (!value) return resolve(null);
          const segments = chunked(value)
            ? value.segments.map(({ chunks: hashes, ...segment }) => {
                const decoder = new TextDecoder('utf-8', { fatal: true });
                const text = hashes.map((hash) => {
                  const bytes: unknown = chunks.get(hash)?.result;
                  if (!(bytes instanceof Uint8Array))
                    throw new DOMException('Missing history chunk', 'DataError');
                  return decoder.decode(bytes, { stream: true });
                });
                text.push(decoder.decode());
                const events: SessionEvent[] = JSON.parse(text.join(''));
                if (!Array.isArray(events))
                  throw new DOMException('Invalid history chunk', 'DataError');
                return { ...segment, events };
              })
            : value.segments;
          resolve({ segments, prompt: value.prompt, forward: forward.result ?? value.forward });
        } catch (error) {
          reject(error);
        }
      };
      tx.onabort = () => reject(tx.error);
    });
  } catch (error) {
    throw storageError('读取本机会话历史失败', error);
  } finally {
    db?.close();
  }
}

async function pack(value: SharedHistory) {
  const chunks = new Map<string, Uint8Array>();
  const segments: StoredHistory['segments'] = [];
  const encoder = new TextEncoder();
  for (const { events, ...segment } of value.segments) {
    const hashes: string[] = [];
    let buffer = new Uint8Array(chunkBytes);
    let length = 0;
    const flush = async () => {
      const bytes = buffer.slice(0, length);
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
      chunks.set(hash, bytes);
      hashes.push(hash);
      buffer = new Uint8Array(chunkBytes);
      length = 0;
    };
    const append = async (text: string) => {
      const bytes = encoder.encode(text);
      for (let offset = 0; offset < bytes.length;) {
        const count = Math.min(chunkBytes - length, bytes.length - offset);
        buffer.set(bytes.subarray(offset, offset + count), length);
        length += count;
        offset += count;
        if (length === chunkBytes) await flush();
      }
    };
    await append('[');
    for (let index = 0; index < events.length; index++)
      await append(`${index ? ',' : ''}${JSON.stringify(events[index])}`);
    await append(']');
    if (length) await flush();
    segments.push({ ...segment, chunks: hashes });
  }
  return { record: { ...value, storageVersion: 2, segments } satisfies StoredHistory, chunks };
}

async function write(
  key: string,
  value: SharedHistory,
  message: string,
  forward?: NonNullable<SharedHistory['forward']>,
) {
  try {
    // Hashing happens before opening a transaction: yielding to crypto inside IndexedDB callbacks
    // would let the transaction close before all writes have been scheduled.
    const { record, chunks } = await pack(value);
    for (let attempt = 0; ; attempt++) {
      let db: IDBDatabase | undefined;
      try {
        db = await database();
        await new Promise<void>((resolve, reject) => {
          const tx = db!.transaction('history', 'readwrite');
          const store = tx.objectStore('history');
          let failure: unknown;
          const guard = (action: () => void) => {
            try {
              action();
            } catch (error) {
              failure = error;
              tx.abort();
            }
          };
          tx.oncomplete = () => resolve();
          tx.onabort = () =>
            reject(failure ?? tx.error ?? new DOMException('Transaction aborted', 'AbortError'));
          guard(() => {
            for (const [hash, bytes] of chunks) {
              const request = store.getKey(chunkKey(hash));
              request.onsuccess = () =>
                guard(() => {
                  if (request.result === undefined) store.put(bytes, chunkKey(hash));
                });
            }
            store.put(record, key);
            store.delete(forwardKey(key));
            if (forward)
              record.segments.forEach((segment, index) => {
                const previous = store.getKey(segment.key);
                previous.onsuccess = () =>
                  guard(() => {
                    if (previous.result === undefined)
                      store.put(
                        {
                          storageVersion: 2,
                          segments: record.segments.slice(0, index),
                          prompt: '',
                        },
                        segment.key,
                      );
                  });
                // Do not read/rewrite old inline transcripts merely to update their destination.
                store.put(forward, forwardKey(segment.key));
                store.delete(`pending:${segment.key}`);
              });
          });
        });
        return;
      } catch (error) {
        // Only retry an aborted local transaction once. No create/configure/send request is repeated.
        if (
          attempt ||
          !(error instanceof Error) ||
          !['AbortError', 'UnknownError'].includes(error.name)
        )
          throw error;
      } finally {
        db?.close();
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  } catch (error) {
    throw storageError(message, error);
  }
}

export const saveSharedHistory = (key: string, value: SharedHistory) =>
  write(key, value, '本机会话历史保存失败，已暂停接力');

export async function attachSharedHistory(
  profile: ConnectionProfile,
  sessionId: string,
  value: SharedHistory,
) {
  const key = historyKey(profile, sessionId);
  if (value.segments.some((segment) => segment.key === key))
    throw new Error('目标会话已包含在历史中，未交接。');
  await write(key, value, '会话交接记录保存失败，已暂停发送', {
    profileId: profile.id,
    url: profile.url,
    sessionId,
  });
  // Persistence is already committed; a notification failure must not masquerade as a failed save.
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      const channel = new BroadcastChannel('cc-shared-history');
      channel.postMessage('changed');
      channel.close();
    } catch {
      // The current window also receives shared-history-changed from the caller.
    }
  }
}
