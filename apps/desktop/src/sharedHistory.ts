import type { Session, SessionEvent } from '@cc-desk-tunnel/protocol';
import type { ConnectionProfile } from './connections.ts';
import type { ProxyClient } from './client.ts';

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

// IndexedDB holds the full transcript, not credentials, and does not impose localStorage's small limit.
// Include the endpoint: editing a saved connection must not attach another server's history.
export const historyKey = (profile: ConnectionProfile, sessionId: string) =>
  JSON.stringify([profile.id, profile.url, sessionId]);

async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('cc-shared-conversations', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('history');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('无法打开本机会话历史，未切换服务器。'));
  });
}
export async function sharedHistory(key: string): Promise<SharedHistory | null> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction('history', 'readonly');
      const request = transaction.objectStore('history').get(key);
      transaction.oncomplete = () => resolve(request.result ?? null);
      transaction.onabort = () => reject(new Error('读取本机会话历史失败。'));
    });
  } finally {
    db.close();
  }
}
export async function saveSharedHistory(key: string, value: SharedHistory) {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('history', 'readwrite');
      transaction.objectStore('history').put(value, key);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(new Error('本机会话历史保存失败，已暂停接力。'));
    });
  } finally {
    db.close();
  }
}

// Publish the destination and all old-segment pointers in one local transaction. Reopening an old
// server must lead to the current conversation rather than unknowingly forking the same task.
export async function attachSharedHistory(
  profile: ConnectionProfile,
  sessionId: string,
  value: SharedHistory,
) {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('history', 'readwrite');
      const store = transaction.objectStore('history');
      store.put(value, historyKey(profile, sessionId));
      value.segments.forEach((segment, index) => {
        const request = store.get(segment.key);
        request.onsuccess = () =>
          store.put(
            {
              ...(request.result ?? { segments: value.segments.slice(0, index), prompt: '' }),
              forward: { profileId: profile.id, url: profile.url, sessionId },
            },
            segment.key,
          );
        store.delete(`pending:${segment.key}`);
      });
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(new Error('会话交接记录保存失败，已暂停发送。'));
    });
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel('cc-shared-history');
      channel.postMessage('changed');
      channel.close();
    }
  } finally {
    db.close();
  }
}

// Only rendering uses these namespaced IDs. Commands, telemetry and billing use the live server's IDs.
export function joinedHistory(archive: SharedHistory | null, current: SessionEvent[]) {
  if (!archive) return current;
  const earlier = archive.segments.flatMap((segment) => {
    const namespace = (id: string) => `archive:${segment.key}:${id}`;
    let account: string | undefined;
    const events = segment.events.flatMap((event): SessionEvent[] => {
      const payload = { ...event.payload };
      const fields = payload as unknown as Record<string, unknown>;
      for (const key of ['toolId', 'messageId', 'approvalId']) {
        if (typeof fields[key] === 'string') fields[key] = namespace(fields[key]);
      }
      const mapped = { ...event, runId: namespace(event.runId), payload };
      if (
        payload.type === 'native.session' &&
        payload.accountName &&
        payload.accountName !== account
      ) {
        account = payload.accountName;
        return [
          { ...mapped, payload: { type: 'native.notice', text: `执行账号：${account}` } },
          mapped,
        ];
      }
      return [mapped];
    });
    if (events.length)
      events.unshift({
        ...events[0]!,
        payload: {
          type: 'native.notice',
          text: `执行来源：${segment.service}${segment.account ? ` · 交接时账号：${segment.account}` : ''}`,
        },
      });
    return events;
  });
  let firstMessage = true;
  const live = current.map((event) => {
    if (event.payload.type !== 'message.user' || !firstMessage) return event;
    firstMessage = false;
    return event.payload.text === archive.prompt
      ? { ...event, payload: { ...event.payload, text: 'continue', continued: true } }
      : event;
  });
  return [...earlier, ...live].map((event, index) => ({ ...event, sequence: index + 1 }));
}

export function transferBlock(session: Session, events: SessionEvent[]): string | null {
  if (session.activeRun) return '请先等待当前任务结束，再续接到另一台服务器。';
  if (session.messageQueue?.items.length) return '请先处理当前会话的排队消息。';
  const run = events.findLast((event) => event.payload.type === 'run.status');
  if (!run) return null;
  const current = events.filter((event) => event.runId === run.runId);
  const background = current.findLast((event) => event.payload.type === 'native.tasks');
  if (background?.payload.type === 'native.tasks' && background.payload.tasks.length)
    return '后台任务尚未结束，不能交接。';
  const tools = new Set<string>();
  for (const { payload } of current) {
    if (payload.type === 'tool.requested') tools.add(payload.toolId);
    if (payload.type === 'tool.result') {
      if (payload.status === 'unknown') return '工具结果未确认，请先核实，避免重复执行。';
      tools.delete(payload.toolId);
    }
    if (payload.type === 'message.delivery' && ['unconfirmed', 'not_sent'].includes(payload.status))
      return '消息送达状态未确认，请先核实。';
  }
  return tools.size ? '仍有工具未返回结果，不能交接。' : null;
}

export async function completeHistory(client: ProxyClient, sessionId: string) {
  if (client.state.selectedId !== sessionId) client.select(sessionId);
  await client.request({ type: 'session.subscribe', sessionId, afterSequence: 0 });
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (client.state.status !== 'connected') throw new Error('连接已中断，未交接。');
    if (Date.now() >= deadline) throw new Error('读取完整会话历史超时，未交接。');
    const history = client.state.history[sessionId];
    if (!history || history.loading || history.loadingEarlier) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      continue;
    }
    if (!history.hasEarlier) return client.shown(sessionId);
    await client.loadEarlier(sessionId);
  }
}
