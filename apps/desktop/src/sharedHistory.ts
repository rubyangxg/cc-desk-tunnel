import type { Session, SessionEvent } from '@cc-desk-tunnel/protocol';
import type { ConnectionProfile } from './connections.ts';
import { RequestTimeoutError, RequestRejectedError } from './client.ts';
import type { ProxyClient } from './client.ts';
import {
  cacheKey,
  progressKey,
  clearHistoryProgress,
  holdHistoryWarmup,
  readHistoryCache,
  saveHistoryCache,
} from './historyCache.ts';

import type { SharedHistory } from './sharedHistoryStore.ts';
export type { HistorySegment, SharedHistory } from './sharedHistoryStore.ts';
export {
  historyKey,
  sharedHistory,
  saveSharedHistory,
  attachSharedHistory,
} from './sharedHistoryStore.ts';

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

// Keep one archive checkpoint per live connection. A retry can reuse pages already verified,
// without retaining every conversation or adding full transcripts to the visible React state.
type HistoryCheckpoint = {
  sessionId: string;
  connection: string | null;
  events: SessionEvent[];
  hasEarlier: boolean;
};
const checkpoints = new WeakMap<ProxyClient, HistoryCheckpoint>();

export async function completeHistory(
  client: ProxyClient,
  sessionId: string,
  progress: (count: number) => void = () => {},
  profile?: ConnectionProfile,
) {
  const release = holdHistoryWarmup(client);
  try {
    return await readCompleteHistory(client, sessionId, progress, profile);
  } finally {
    release();
  }
}

async function readCompleteHistory(
  client: ProxyClient,
  sessionId: string,
  progress: (count: number) => void,
  profile?: ConnectionProfile,
) {
  const connection = client.state.connectionId;
  const connected = () => {
    if (client.state.status !== 'connected' || client.state.connectionId !== connection)
      throw new Error('连接已改变，未交接。');
  };
  connected();
  if (client.state.selectedId !== sessionId) client.select(sessionId);
  const candidates: HistoryCheckpoint[] = [];
  if (profile && client.state.service) {
    const snapshots = await Promise.allSettled([
      readHistoryCache(cacheKey(profile, sessionId), client.state.service),
      readHistoryCache(progressKey(profile, sessionId), client.state.service),
    ]);
    for (const snapshot of snapshots)
      if (snapshot.status === 'fulfilled' && snapshot.value?.events.length)
        candidates.push({ ...snapshot.value, sessionId, connection });
    connected();
  }
  const visible = client.state.events[sessionId] ?? [];
  const history = client.state.history[sessionId];
  const previous = checkpoints.get(client);
  if (
    previous?.connection === connection &&
    previous.sessionId === sessionId &&
    previous.events.length
  )
    candidates.push(previous);
  if (
    history &&
    !history.loading &&
    !history.loadingEarlier &&
    visible.length &&
    visible[0]!.sequence === history.firstSequence &&
    visible.at(-1)!.sequence === history.lastSequence
  )
    candidates.push({
      sessionId,
      connection,
      events: [...visible],
      hasEarlier: history.hasEarlier,
    });
  // Resume the newest tail even when an older complete cache contains more records. Keep the
  // older ranges until a downloaded page proves the missing middle connects to them.
  candidates.sort(
    (a, b) =>
      b.events.at(-1)!.sequence - a.events.at(-1)!.sequence ||
      a.events[0]!.sequence - b.events[0]!.sequence,
  );
  let cached: HistoryCheckpoint | undefined = candidates[0];
  let afterSequence = cached?.events.at(-1)?.sequence ?? 0;
  let replaceCache = false;
  let progressReplaced = false;
  // Retry only a read whose reply timed out, and only on the same connection. No send/stop/continue
  // command is repeated here. Each page has its own timeout, so a long but advancing archive can finish.
  const read = async (before?: number) => {
    for (let attempt = 0; ; attempt++) {
      connected();
      try {
        return await client.fetch(
          before === undefined
            ? { type: 'session.subscribe', sessionId, afterSequence }
            : { type: 'session.history', sessionId, beforeSequence: before },
        );
      } catch (error) {
        if (
          before === undefined &&
          afterSequence &&
          error instanceof RequestRejectedError &&
          error.code === 'invalid_cursor'
        ) {
          cached = undefined;
          candidates.length = 0;
          replaceCache = true;
          afterSequence = 0;
          checkpoints.delete(client);
          continue;
        }
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
      (before === undefined
        ? !['replace', ...(afterSequence ? ['append'] : [])].includes(page.mode)
        : page.mode !== 'prepend') ||
      (before !== undefined && page.firstSequence >= before) ||
      (page.hasEarlier && (page.firstSequence <= 0 || !page.events.length))
    )
      throw new Error('历史分页未前进，未交接。');
    for (const event of page.events) {
      if (
        event.sessionId !== sessionId ||
        (before !== undefined && event.sequence >= before) ||
        (page.mode === 'append' && event.sequence <= afterSequence)
      )
        throw new Error('历史分页范围不一致，未交接。');
      events.set(event.sequence, event);
    }
    if (cached && page.mode === 'replace' && !page.hasEarlier) replaceCache = true;
    let hasEarlier = page.hasEarlier;
    let first = page.firstSequence;
    if (page.mode === 'append') {
      if (
        !cached ||
        page.lastSequence < afterSequence ||
        page.hasEarlier ||
        (page.events.at(-1)?.sequence ?? afterSequence) !== page.lastSequence
      )
        throw new Error('历史增量范围不一致，未交接。');
      for (const event of cached.events) events.set(event.sequence, event);
      first = cached.events[0]!.sequence;
      hasEarlier = cached.hasEarlier;
    }
    for (let index = 0; hasEarlier && index < candidates.length; index++) {
      const candidate = candidates[index]!;
      // Sequence numbers may have gaps, so only verified overlap proves continuity.
      const overlap = candidate.events.filter((event) => events.has(event.sequence));
      if (!overlap.length) continue;
      if (
        overlap.every(
          (event) => JSON.stringify(events.get(event.sequence)) === JSON.stringify(event),
        )
      ) {
        for (const event of candidate.events) events.set(event.sequence, event);
        first = Math.min(first, candidate.events[0]!.sequence);
        hasEarlier = candidate.hasEarlier;
      } else {
        if (cached === candidate) cached = undefined;
        replaceCache = true;
      }
      candidates.splice(index--, 1);
    }
    const ordered = [...events.values()].sort((a, b) => a.sequence - b.sequence);
    checkpoints.set(client, { sessionId, connection, events: ordered, hasEarlier });
    progress(events.size);
    if (profile && client.state.service) {
      try {
        // Commit every validated page independently, before requesting the next one. A restarted
        // app can continue from this range even if the preceding attempt never completed.
        await saveHistoryCache(
          progressKey(profile, sessionId),
          client.state.service,
          ordered,
          hasEarlier,
          replaceCache && !progressReplaced,
          true,
        );
        progressReplaced ||= replaceCache;
      } catch {
        /* Progress is optional; the permanent archive is still mandatory. */
      }
      connected();
    }
    if (!hasEarlier) {
      if (profile && client.state.service) {
        try {
          if (
            await saveHistoryCache(
              cacheKey(profile, sessionId),
              client.state.service,
              ordered,
              false,
              replaceCache,
              true,
            )
          )
            await clearHistoryProgress(profile, sessionId);
        } catch {
          /* The permanent handoff archive is still required below. */
        }
        connected();
      }
      return ordered;
    }
    before = first;
  }
}
