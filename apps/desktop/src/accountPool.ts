import type { NativeMetrics, Session, SessionEvent } from '@cc-desk-tunnel/protocol';
import type { ConnectionProfile } from './connections.ts';
import { transcript } from './transcript.ts';
import type { SharedHistory } from './sharedHistory.ts';

export type PoolSettings = {
  enabled: boolean;
  strategy: 'reset' | 'manual';
  order: string[];
  // A connection failure is excluded until a fresh authenticated probe succeeds.
  disabled?: string[];
};
export type QuotaSnapshot = {
  limits: NativeMetrics['rateLimits'];
  checkedAt: number;
  error?: string;
  blockedUntil?: number;
};
export type Quotas = Record<string, QuotaSnapshot>;
export type Handoff = {
  source: string;
  session: Pick<Session, 'title' | 'projectPath' | 'permissionMode' | 'model' | 'effort'>;
  prompt: string;
  attempted: string[];
  history?: SharedHistory;
  manual?: boolean;
  queue?: Session['messageQueue'];
  sourceDraftSessionId?: string;
  scenario?: NonNullable<Session['messageQueue']>['items'][number]['scenario'];
};
export const quotaFreshMs = 120_000;

export function fiveHour(snapshot?: QuotaSnapshot) {
  return snapshot?.limits?.windows.find((window) => window.name === 'five_hour');
}
export function exhausted(snapshot: QuotaSnapshot | undefined, now = Date.now()) {
  if (!snapshot) return false;
  if (snapshot.blockedUntil && snapshot.blockedUntil > now) return true;
  // An account-wide weekly cap also makes an account unavailable. Per-model windows are not account-wide.
  return (
    snapshot.limits?.windows.some((window) => {
      const reset = Date.parse(window.resetsAt ?? '');
      return (
        ['five_hour', 'seven_day'].includes(window.name) &&
        (window.utilization ?? 0) >= 100 &&
        (Number.isFinite(reset) ? reset > now : snapshot.checkedAt + quotaFreshMs > now)
      );
    }) ?? false
  );
}
export function poolCandidates(
  profiles: ConnectionProfile[],
  quotas: Quotas,
  settings: PoolSettings,
  excluded: string[] = [],
  now = Date.now(),
) {
  const order = [...new Set([...settings.order, ...profiles.map((profile) => profile.id)])];
  const reset = (id: string) => {
    const end = Date.parse(fiveHour(quotas[id])?.resetsAt ?? '');
    return end > now ? end : Infinity;
  };
  return profiles
    .filter((profile) => {
      const quota = quotas[profile.id];
      return (
        profile.mode === 'remote' &&
        profile.remember &&
        !!profile.token &&
        !excluded.includes(profile.id) &&
        !settings.disabled?.includes(profile.id) &&
        !!quota?.limits?.available &&
        typeof fiveHour(quota)?.utilization === 'number' &&
        fiveHour(quota)!.utilization! < 100 &&
        !quota.error &&
        quota.checkedAt + quotaFreshMs > now &&
        !exhausted(quota, now)
      );
    })
    .sort(
      (a, b) =>
        (settings.strategy === 'reset' ? reset(a.id) - reset(b.id) : 0) ||
        order.indexOf(a.id) - order.indexOf(b.id),
    );
}

// Older protocol-20 services supplied only this exact reason. Never infer auto-resume from
// a generic failure, a user pause, a stopped run or an unconfirmed dispatch.
export function quotaPausedQueue(session: Session) {
  const queue = session.messageQueue;
  return !!(
    !session.activeRun &&
    queue?.items.length &&
    queue.paused &&
    !queue.dispatching &&
    !queue.handoff &&
    (queue.reasonCode === 'pool_unavailable' ||
      (!queue.reasonCode && queue.reason === '账号池暂无可用额度，请检测账号或等待额度重置。'))
  );
}

export function quotaFailure(events: SessionEvent[]) {
  const ended = events.findLast((event) => event.payload.type === 'run.status');
  if (
    !ended ||
    ended.payload.type !== 'run.status' ||
    !['failed', 'cancelled'].includes(ended.payload.status)
  )
    return null;
  return (
    events.findLast(
      (event) =>
        event.runId === ended.runId &&
        event.payload.type === 'run.error' &&
        event.payload.code === 'quota_five_hour',
    ) ??
    (ended.payload.status === 'failed'
      ? events.findLast(
          (event) => event.runId === ended.runId && event.payload.type === 'run.error',
        )
      : null) ??
    null
  );
}

export function handoffFor(
  session: Session,
  events: SessionEvent[],
  source: string,
  attempted: string[],
): Handoff {
  const items = transcript(events).filter((item) => item.kind !== 'thinking');
  const lastQuestion = items.findLast((item) => item.kind === 'user' && !item.continued);
  const recent = items
    .map((item) =>
      item.kind === 'tool'
        ? `工具 ${item.name} [${item.state}]\n输入：${item.input}\n结果：${item.output ?? item.liveOutput ?? '结果未确认'}`
        : `${item.kind}：${item.text}`,
    )
    .join('\n\n')
    .slice(-10500);
  const prompt = [
    'continue',
    '跨服务器续接：这是同一本机项目的新原生会话，下面是最近上下文的文本摘录，不是原生会话恢复。',
    '继续用户原任务。先检查项目当前状态；已完成的修改和命令不要重复执行。标为未知或结果未确认的操作先核实结果。若摘录缺少必要信息，请询问用户。',
    `最近用户任务：\n${lastQuestion && 'text' in lastQuestion ? lastQuestion.text.slice(0, 2500) : '根据以下上下文继续未完成的任务。'}`,
    `最近对话与执行进度（长记录只保留末尾）：\n${recent}`,
  ].join('\n\n');
  return {
    source,
    session: {
      title: session.title,
      projectPath: session.projectPath,
      permissionMode: session.permissionMode,
      model: session.model,
      effort: session.effort,
    },
    prompt,
    attempted,
  };
}
