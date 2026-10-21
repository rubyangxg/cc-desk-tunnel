import type { Session, SessionEvent } from '@cc-desk-tunnel/protocol';
import type { ConnectionProfile } from './connections.ts';
import { RequestTimeoutError } from './client.ts';
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

export function transferBlock(
  session: Session,
  events: SessionEvent[],
  allowQueueHandoff = false,
): string | null {
  if (session.activeRun) return '请先等待当前任务结束，再续接到另一台服务器。';
  if (session.messageQueue?.items.length && !(allowQueueHandoff && session.messageQueue.handoff))
    return '请先处理当前会话的排队消息。';
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

export async function completeHistory(
  client: ProxyClient,
  sessionId: string,
  progress: (count: number) => void = () => {},
) {
  const connection = client.state.connectionId;
  const connected = () => {
    if (client.state.status !== 'connected' || client.state.connectionId !== connection)
      throw new Error('连接已改变，未交接。');
  };
  connected();
  if (client.state.selectedId !== sessionId) client.select(sessionId);
  // Retry only a read whose reply timed out, and only on the same connection. No send/stop/continue
  // command is repeated here. Each page has its own timeout, so a long but advancing archive can finish.
  const read = async (before?: number) => {
    for (let attempt = 0; ; attempt++) {
      connected();
      try {
        return await client.fetch(
          before === undefined
            ? { type: 'session.subscribe', sessionId, afterSequence: 0 }
            : { type: 'session.history', sessionId, beforeSequence: before },
        );
      } catch (error) {
        if (!(error instanceof RequestTimeoutError) || attempt >= 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
  };
  const events = new Map<number, SessionEvent>();
  let before: number | undefined;
  let revision: string | undefined;
  for (;;) {
    const page = await read(before);
    connected();
    revision ??= page.session.updatedAt;
    if (
      page.session.id !== sessionId ||
      page.session.updatedAt !== revision ||
      client.state.sessions.find((item) => item.id === sessionId)?.updatedAt !== revision
    )
      throw new Error('读取历史期间会话已改变，未交接。');
    if (
      page.mode !== (before === undefined ? 'replace' : 'prepend') ||
      (before !== undefined && page.firstSequence >= before) ||
      (page.hasEarlier && (page.firstSequence <= 0 || !page.events.length))
    )
      throw new Error('历史分页未前进，未交接。');
    for (const event of page.events) {
      if (event.sessionId !== sessionId || (before !== undefined && event.sequence >= before))
        throw new Error('历史分页范围不一致，未交接。');
      events.set(event.sequence, event);
    }
    progress(events.size);
    if (!page.hasEarlier) return [...events.values()].sort((a, b) => a.sequence - b.sequence);
    before = page.firstSequence;
  }
}
