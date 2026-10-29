import { useEffect, useRef, useState } from 'react';
import type { ProfileControls } from './Connections.tsx';
import type { ProxyClient } from './client.ts';
import {
  exhausted,
  fiveHour,
  handoffFor,
  poolCandidates,
  quotaFailure,
  quotaPausedQueue,
} from './accountPool.ts';
import { isHere } from './device.ts';
import { transcript } from './transcript.ts';
import type { Session } from '@cc-desk-tunnel/protocol';
import {
  attachSharedHistory,
  completeHistory,
  historyKey,
  joinedHistory,
  saveSharedHistory,
  sharedHistory,
  transferBlock,
} from './sharedHistory.ts';

function handoffError(reason: string) {
  return new Error(
    reason === '消息送达状态未确认，请先核实。'
      ? '消息送达状态未确认。请展开上一轮记录核实进度，再点击右下角“继续”确认续接。'
      : reason === '后台任务尚未结束，不能交接。'
        ? '历史记录中仍有后台任务。请先核实项目电脑上的任务已结束，再点击右下角“继续”确认交接。重启客户端不会清除此记录。'
        : reason,
  );
}

export function usePoolRotation(options: {
  client: ProxyClient;
  profiles: ProfileControls;
  busy: boolean;
  terminalOpen: boolean;
  close: () => Promise<void>;
  show: (id: string) => void;
  draft: (id: string, text: string) => void;
  error: (text: string) => void;
}) {
  const { client, profiles } = options;
  const { pool } = profiles;
  const id = profiles.initial.id;
  const state = client.state;
  const current = useRef(options);
  current.current = options;
  const mountedAt = useRef(Date.now());
  const rotating = useRef(false);
  const resuming = useRef(false);
  const currentHandoff = useRef(profiles.handoff);
  const hasConnected = useRef(false);
  const failedConnectionHandled = useRef(false);
  const resumedSession = useRef<string | null>(null);
  const claimedQueues = useRef(new Set<string>());
  const cancelledRuns = useRef(new Set<string>());
  const markedFailures = useRef(new Set<string>());
  const continuedFailures = useRef(new Set<string>());
  const nextAttempt = useRef(0);
  const [working, setWorking] = useState(false);
  const [connectionRetry, setConnectionRetry] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  async function prepare(
    session: Session,
    attempted: string[],
    manual = false,
    allowQueueHandoff = false,
  ) {
    if (
      !profiles.persistent &&
      client.state.sessions.some((item) => item.activeRun && isHere(item, client.state.device))
    )
      throw new Error('任务仍在运行，未切换服务器。');
    setNotice('正在读取会话历史，准备续接…');
    let events;
    try {
      events = await completeHistory(
        client,
        session.id,
        (count) => setNotice(`正在准备续接，已就绪 ${count} 条历史记录…`),
        profiles.initial,
      );
    } finally {
      setNotice(null);
    }
    const live = client.state.sessions.find((item) => item.id === session.id);
    if (!live) throw new Error('原会话已不存在。');
    if (allowQueueHandoff && live.messageQueue?.dispatching)
      throw new Error('队列消息正在发送，未交接。');
    // Validate and persist the full history BEFORE freezing an idle queue. A failed history
    // read, receipt check or local write must leave the source editable.
    const checked = allowQueueHandoff ? { ...live, messageQueue: undefined } : live;
    let blocked = transferBlock(checked, events);
    let confirmedMessageIds: string[] = [];
    let confirmedTaskIds: string[] = [];
    if (
      manual &&
      (blocked === '消息送达状态未确认，请先核实。' || blocked === '后台任务尚未结束，不能交接。')
    ) {
      const runId = events.findLast((event) => event.payload.type === 'run.status')?.runId;
      const latest = events.filter((event) => event.runId === runId);
      const ids = latest.flatMap(({ payload }) =>
        payload.type === 'message.delivery' && ['unconfirmed', 'not_sent'].includes(payload.status)
          ? [payload.messageId]
          : [],
      );
      const background = latest.findLast((event) => event.payload.type === 'native.tasks')?.payload;
      const tasks = background?.type === 'native.tasks' ? background.tasks : [];
      const taskIds = tasks.map((task) => task.id);
      // A user may verify historical task lists and receipts, never unknown tool results.
      const remaining = transferBlock(checked, events, false, ids, taskIds);
      if (remaining) throw handoffError(remaining);
      if (tasks.length && !client.state.features.includes('cross-server-task-confirmation'))
        throw new Error('历史记录仍有后台任务；请先升级来源服务端和客户端，再点击“继续”核实交接。');
      const detail = tasks.length
        ? `历史记录中仍有后台任务（重启不会证明它们已结束）：\n${tasks.map((task) => `• ${task.description.slice(0, 120)} [${task.id}]`).join('\n')}\n\n请在项目所在电脑确认这些任务已结束。`
        : '上一轮有消息未确认送达。';
      if (
        window.confirm(
          `${detail}\n请展开任务记录核实进度，并确认没有其他续接会话正在执行。已核实并继续？续接会携带已有进度，要求先检查已完成的操作。`,
        )
      ) {
        confirmedMessageIds = [...new Set(ids)];
        confirmedTaskIds = [...new Set(taskIds)];
        blocked = null;
      }
    }
    if (blocked) throw handoffError(blocked);
    if (
      !profiles.persistent &&
      client.state.sessions.some((item) => item.activeRun && isHere(item, client.state.device))
    )
      throw new Error('其他任务仍在运行，请结束后再切换服务器。');
    const key = historyKey(profiles.initial, session.id);
    const archive = await sharedHistory(key);
    if (archive?.forward) throw new Error('此任务已在其他服务器续接，请前往当前会话。');
    const handoff = handoffFor(
      live,
      joinedHistory(archive, events),
      profiles.initial.name,
      attempted,
    );
    handoff.manual = manual;
    if (confirmedMessageIds.length) handoff.confirmedMessageIds = confirmedMessageIds;
    if (confirmedTaskIds.length) handoff.confirmedTaskIds = confirmedTaskIds;
    if (allowQueueHandoff && live.messageQueue?.items.length)
      handoff.queue = {
        items: live.messageQueue.items,
        paused: live.messageQueue.handoff?.paused ?? live.messageQueue.paused,
      };
    handoff.history = {
      prompt: handoff.prompt,
      segments: [
        ...(archive?.segments ?? []),
        {
          key,
          service: profiles.initial.name,
          account: client.state.pool?.accounts.find((account) => account.id === live.accountId)
            ?.name,
          session: live,
          events: joinedHistory(archive ? { ...archive, segments: [] } : null, events),
        },
      ],
    };
    // Archive the transcript before transferring execution ownership.
    await saveSharedHistory(`pending:${key}`, handoff.history);
    if (
      client.state.sessions.find((item) => item.id === session.id)?.updatedAt !== live.updatedAt ||
      (!profiles.persistent &&
        client.state.sessions.some((item) => item.activeRun && isHere(item, client.state.device)))
    )
      throw new Error('保存历史期间任务状态已改变，未交接。');
    return handoff;
  }

  async function freezeQueue(
    session: Session,
    confirmedMessageIds?: string[],
    confirmedTaskIds?: string[],
  ) {
    const live = client.state.sessions.find((item) => item.id === session.id);
    if (
      !live ||
      JSON.stringify(live.messageQueue?.items ?? []) !==
        JSON.stringify(session.messageQueue?.items ?? [])
    )
      throw new Error('准备期间队列已改变，未交接。');
    if (!live?.messageQueue?.items.length) return;
    if (live.messageQueue.handoff && claimedQueues.current.has(session.id)) return;
    if (!client.state.features.includes('cross-server-queue-handoff'))
      throw new Error('当前服务端不支持携带排队消息接力，请先升级服务端。');
    if (
      confirmedMessageIds?.length &&
      !client.state.features.includes('cross-server-queue-recovery')
    )
      throw new Error('请先升级当前服务端，才能确认未送达消息并携带队列续接。');
    await client.request({
      type: 'session.handoff',
      sessionId: session.id,
      queueIds: live.messageQueue.items.map((item) => item.id),
      ...(confirmedMessageIds?.length ? { confirmedMessageIds } : {}),
      ...(confirmedTaskIds?.length ? { confirmedTaskIds } : {}),
    });
    claimedQueues.current.add(session.id);
  }

  async function sendAfterQuota(
    session: Session,
    text: string,
    scenario: NonNullable<Session['messageQueue']>['items'][number]['scenario'],
    priority = false,
  ) {
    if (
      priority &&
      (!pool.config.enabled ||
        profiles.profiles.length < 2 ||
        options.terminalOpen ||
        text.trimStart().startsWith('/') ||
        text.length > 14500 ||
        session.messageQueue?.items.length ||
        session.messageQueue?.paused ||
        !isHere(session, client.state.device) ||
        client.state.sessions.some((item) => item.activeRun && isHere(item, client.state.device)))
    )
      return false;
    if (text.length > 14500)
      throw new Error('这条消息过长，无法同时携带续接上下文；请缩短后重试，原文保留在草稿中。');
    if (!pool.config.enabled) throw new Error('本服务器额度已耗尽，请开启自动接力或手动续接。');
    if (!isHere(session, client.state.device))
      throw new Error(
        `请在项目所在设备 ${session.device?.name ?? ''} 上发送或续接；当前窗口不能代替该设备跨服交接。`,
      );
    if (rotating.current || working) throw new Error('正在交接，请稍后再试。');
    const connection = client.state.connectionId;
    rotating.current = true;
    setWorking(true);
    try {
      const quotas = await pool.refresh();
      const next = poolCandidates(
        current.current.profiles.profiles,
        quotas,
        current.current.profiles.pool.config,
        priority ? [] : [id],
      )[0];
      if (priority && (!next || next.id === id || !current.current.profiles.pool.config.enabled))
        return false;
      if (!next) throw new Error('暂无可用的其他服务器，消息保留在草稿中。');
      const handoff = await prepare(session, [id], true, true);
      const suffix = `\n\n用户本次新消息：\n${text}`;
      handoff.prompt = handoff.prompt.slice(0, 16000 - suffix.length) + suffix;
      handoff.sourceDraftSessionId = session.id;
      handoff.scenario = scenario;
      if (handoff.history) {
        handoff.history.prompt = handoff.prompt;
        await saveSharedHistory(
          `pending:${historyKey(profiles.initial, session.id)}`,
          handoff.history,
        );
      }
      await freezeQueue(
        handoff.history!.segments.at(-1)!.session,
        handoff.confirmedMessageIds,
        handoff.confirmedTaskIds,
      );
      await current.current.close();
      await current.current.profiles.select(next.id, true, handoff);
      return true;
    } catch (error) {
      // Priority is an optimization. If preparation fails before leaving the source, the caller
      // can still send there once; never fall back after switching or a possibly accepted send.
      if (
        priority &&
        current.current.profiles.pool.config.strategy === 'reset' &&
        client.state.status === 'connected' &&
        client.state.connectionId === connection
      )
        return false;
      throw error;
    } finally {
      rotating.current = false;
      setWorking(false);
    }
  }

  async function transfer(targetId: string, session: Session) {
    if (rotating.current || working || options.busy || options.terminalOpen) return;
    rotating.current = true;
    setWorking(true);
    try {
      const target = profiles.profiles.find((profile) => profile.id === targetId);
      if (!target || target.id === id) throw new Error('请选择另一台服务器。');
      const handoff = await prepare(session, [id], true, true);
      if (
        client.state.status !== 'connected' ||
        client.state.sessions.some((item) => item.activeRun && isHere(item, client.state.device))
      )
        throw new Error('任务状态已改变，未切换服务器。');
      await freezeQueue(
        handoff.history!.segments.at(-1)!.session,
        handoff.confirmedMessageIds,
        handoff.confirmedTaskIds,
      );
      await current.current.close();
      await current.current.profiles.select(targetId, true, handoff);
    } catch (error) {
      current.current.error(error instanceof Error ? error.message : '交接失败。');
    } finally {
      rotating.current = false;
      setWorking(false);
    }
  }

  // A queued send can be rejected before a run exists. This is separate from quotaWaits:
  // the server retained the unsent message, so freeze it before transferring ownership.
  useEffect(() => {
    if (
      !pool.config.enabled ||
      state.status !== 'connected' ||
      working ||
      rotating.current ||
      options.busy ||
      options.terminalOpen ||
      profiles.handoff ||
      !state.features.includes('cross-server-queue-handoff')
    )
      return;
    if (state.sessions.some((item) => item.activeRun && isHere(item, state.device))) return;
    const session = state.sessions.find(
      (item) => isHere(item, state.device) && quotaPausedQueue(item),
    );
    if (!session || Date.now() < nextAttempt.current) return;
    const timer = setTimeout(() => {
      nextAttempt.current = Date.now() + 55_000;
      rotating.current = true;
      setWorking(true);
      setNotice('正在选择可用账号，稍后自动发送…');
      void (async () => {
        try {
          const quotas = await pool.refresh();
          const live = current.current;
          const latest = client.state.sessions.find((item) => item.id === session.id);
          if (
            !live.profiles.pool.config.enabled ||
            live.busy ||
            live.terminalOpen ||
            client.state.status !== 'connected' ||
            !latest ||
            !quotaPausedQueue(latest) ||
            client.state.sessions.some(
              (item) => item.activeRun && isHere(item, client.state.device),
            )
          )
            return;
          const candidates = poolCandidates(
            live.profiles.profiles,
            quotas,
            live.profiles.pool.config,
          );
          if (candidates[0]?.id === id) {
            await client.request({
              type: 'message.queue.pause',
              sessionId: session.id,
              paused: false,
            });
            setNotice(null);
            return;
          }
          const next = candidates[0];
          if (!next) {
            setNotice('等待可用额度，恢复后自动发送。');
            return;
          }
          const handoff = await prepare(latest, [id], false, true);
          // This pause was created by a rejected dispatch, not by the user.
          if (handoff.queue) handoff.queue.paused = false;
          if (!current.current.profiles.pool.config.enabled) return;
          await freezeQueue(handoff.history!.segments.at(-1)!.session);
          await current.current.close();
          await current.current.profiles.select(next.id, true, handoff);
        } catch (error) {
          current.current.error(
            `自动接力暂未完成：${error instanceof Error ? error.message : '请求失败'}`,
          );
        } finally {
          rotating.current = false;
          setWorking(false);
        }
      })();
    }, 150);
    return () => clearTimeout(timer);
  }, [state, pool.quotas, pool.config, options.busy, options.terminalOpen, working]);

  // New services rotate inside their own pool first. Only an explicit quota-wait can be released.
  useEffect(() => {
    if (
      !state.features.includes('cross-server-handoff') ||
      !pool.config.enabled ||
      state.status !== 'connected' ||
      working ||
      options.busy ||
      options.terminalOpen
    )
      return;
    const waits = state.pool?.quotaWaits ?? [];
    const active = state.sessions.filter(
      (session) => session.activeRun && isHere(session, state.device),
    );
    if (!profiles.persistent && active.length !== 1) return;
    const session = active.find((item) => waits.some((wait) => wait.sessionId === item.id));
    if (!session) return;
    const runId = session.activeRun!.id;
    if (cancelledRuns.current.has(runId) || Date.now() < nextAttempt.current) return;
    const timer = setTimeout(() => {
      nextAttempt.current = Date.now() + 55_000;
      setWorking(true);
      void (async () => {
        try {
          const quotas = await pool.refresh();
          const next = poolCandidates(
            current.current.profiles.profiles,
            quotas,
            current.current.profiles.pool.config,
            [id],
          )[0];
          if (!next || !current.current.profiles.pool.config.enabled) return;
          const queued = client.state.sessions.find((item) => item.id === session.id)?.messageQueue;
          if (queued?.items.length && !client.state.features.includes('cross-server-queue-handoff'))
            throw new Error('当前服务端不支持携带排队消息接力，请先升级服务端。');
          // The source is in a confirmed quota wait, but its initial input can still lack a
          // receipt. Check that before run.handoff freezes the queue and ends the wait.
          const events = await completeHistory(client, session.id, undefined, profiles.initial);
          const waiting = client.state.sessions.find((item) => item.id === session.id);
          if (!waiting || waiting.activeRun?.id !== runId)
            throw new Error('任务状态已改变，未交接。');
          const blocked = transferBlock(
            { ...waiting, activeRun: null, messageQueue: undefined },
            events,
          );
          if (blocked) throw handoffError(blocked);
          await client.request({
            type: 'run.handoff',
            sessionId: session.id,
            runId,
            ...(client.state.features.includes('cross-server-queue-handoff')
              ? { queueIds: queued?.items.map((item) => item.id) ?? [] }
              : {}),
          });
          cancelledRuns.current.add(runId);
          if (queued?.items.length) claimedQueues.current.add(session.id);
          // A response confirms acceptance, not process termination. Await the terminal run event too.
          const deadline = Date.now() + 30_000;
          while (client.state.sessions.find((item) => item.id === session.id)?.activeRun) {
            if (client.state.status !== 'connected' || Date.now() > deadline)
              throw new Error('尚未确认旧任务结束，未切换服务器。');
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          const handoff = await prepare(session, [id], false, true);
          if (!current.current.profiles.pool.config.enabled) return;
          await current.current.close();
          await current.current.profiles.select(next.id, true, handoff);
        } catch (error) {
          current.current.error(
            `跨服务器接力已暂停：${error instanceof Error ? error.message : '请求失败'}`,
          );
        } finally {
          setWorking(false);
        }
      })();
    }, 150);
    return () => clearTimeout(timer);
  }, [state, pool.quotas, pool.config.enabled, options.busy, options.terminalOpen]);

  useEffect(() => {
    if (state.status === 'connected') {
      hasConnected.current = true;
      pool.markAvailable(id);
    } else if (
      state.status === 'reconnecting' ||
      (state.status === 'disconnected' && state.error)
    ) {
      pool.markUnavailable(id);
    }
    if (state.status === 'connecting') failedConnectionHandled.current = false;
  }, [state.status, state.error, id, pool.markAvailable, pool.markUnavailable]);

  // Only skip a server before this workspace has connected or submitted any work.
  // Once a session request may have reached it, keep the normal reconnect/no-replay behavior.
  useEffect(() => {
    if (
      profiles.background ||
      !profiles.autoConnect ||
      !pool.config.enabled ||
      state.status !== 'disconnected' ||
      !state.error ||
      hasConnected.current ||
      resuming.current ||
      failedConnectionHandled.current
    )
      return;
    failedConnectionHandled.current = true;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const retryLater = () => {
      retry = setTimeout(() => {
        if (cancelled) return;
        failedConnectionHandled.current = false;
        setConnectionRetry((value) => value + 1);
      }, 60_000);
    };
    setWorking(true);
    setNotice(`${profiles.initial.name} 连接失败，已禁用调度，正在查找其他代理服务…`);
    void (async () => {
      try {
        const quotas = await pool.refresh();
        const live = current.current;
        if (cancelled || !live.profiles.pool.config.enabled) return;
        const attempted = [...new Set([...(live.profiles.handoff?.attempted ?? []), id])];
        const next = poolCandidates(
          live.profiles.profiles,
          quotas,
          live.profiles.pool.config,
          attempted,
        )[0];
        if (!next) {
          setNotice(
            '账号池已暂停：暂时没有可用账号，正在等待连接或额度恢复。' +
              (live.profiles.handoff ? '待续接的任务上下文仍保留。' : ''),
          );
          retryLater();
          return;
        }
        const handoff = live.profiles.handoff ? { ...live.profiles.handoff, attempted } : undefined;
        await live.close();
        if (!cancelled) await live.profiles.select(next.id, true, handoff);
      } catch (error) {
        if (!cancelled)
          setNotice(
            `账号池已暂停：${error instanceof Error ? error.message : '代理服务检测失败'}。稍后自动重试。`,
          );
        if (!cancelled) retryLater();
      } finally {
        if (!cancelled) setWorking(false);
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(retry);
      setWorking(false);
    };
  }, [
    state.status,
    state.error,
    profiles.autoConnect,
    profiles.background,
    pool.config.enabled,
    pool.refresh,
    id,
    connectionRetry,
  ]);

  useEffect(() => {
    if (!state.features.includes('account-pool'))
      pool.observe(id, state.metrics?.rateLimits ?? null);
  }, [state.metrics?.rateLimits, state.features, id, pool.observe]);

  useEffect(() => {
    const handoff = profiles.handoff;
    if (handoff !== currentHandoff.current) {
      currentHandoff.current = handoff;
      resuming.current = false;
      resumedSession.current = null;
    }
    if (!handoff) {
      resuming.current = false;
      resumedSession.current = null;
      return;
    }
    if (
      !handoff ||
      (!handoff.manual && !pool.config.enabled) ||
      state.status !== 'connected' ||
      resuming.current
    )
      return;
    resuming.current = true;
    setWorking(true);
    setNotice(`已切换到 ${profiles.initial.name}，正在续接 ${handoff.session.title}…`);
    void (async () => {
      let historyAttached = false;
      try {
        if (handoff.session.goal && !client.state.features.includes('goal-continuation'))
          throw new Error('目标服务器不支持 /goal 续接，请先升级服务端；目标和原会话仍保留。');
        if (handoff.queue?.items.length && !client.state.features.includes('message-queue'))
          throw new Error('目标服务端不支持消息队列，请升级后恢复；原队列备份仍在来源会话。');
        const result = await client.request({
          type: 'session.create',
          title: handoff.session.title,
          projectPath: handoff.session.projectPath,
        });
        if (!result.sessionId) throw new Error('续接会话创建失败。');
        const sessionId = result.sessionId;
        resumedSession.current = sessionId;
        // Keep a recoverable draft even when the local archive cannot be committed.
        current.current.draft(sessionId, handoff.prompt);
        current.current.show(sessionId);
        if (handoff.history) {
          await attachSharedHistory(profiles.initial, sessionId, handoff.history);
          window.dispatchEvent(new Event('shared-history-changed'));
        }
        historyAttached = true;
        await client.request({
          type: 'session.configure',
          sessionId,
          permissionMode: handoff.session.permissionMode,
          model: handoff.session.model,
          effort: handoff.session.effort,
          ...(handoff.session.goal ? { goal: handoff.session.goal } : {}),
        });
        if (handoff.queue?.items.length) {
          // Restore while paused so no queued message can race ahead of continue.
          await client.request({ type: 'message.queue.pause', sessionId, paused: true });
          for (const item of handoff.queue.items)
            await client.request({
              type: 'message.enqueue',
              sessionId,
              text: item.text,
              scenario: item.scenario,
            });
        }
        if (!handoff.manual && !current.current.profiles.pool.config.enabled)
          throw new Error('账号池自动切换已关闭');
        await client.request({
          type: 'message.send',
          sessionId,
          text: handoff.prompt,
          scenario: handoff.scenario ?? 'chat',
        });
        const ended = client
          .shown(sessionId)
          .findLast((event) => event.payload.type === 'run.status');
        const failed =
          ended?.payload.type === 'run.status' &&
          ['failed', 'cancelled'].includes(ended.payload.status);
        if (handoff.queue?.items.length && !handoff.queue.paused && !failed)
          await client.request({ type: 'message.queue.pause', sessionId, paused: false });
        current.current.draft(sessionId, '');
        if (handoff.sourceDraftSessionId) current.current.draft(handoff.sourceDraftSessionId, '');
        current.current.profiles.completeHandoff();
        setNotice(
          `已从 ${handoff.source} 切换到 ${profiles.initial.name}，携带最近上下文继续任务。`,
        );
      } catch (error) {
        setNotice(null);
        const detail = (error instanceof Error ? error.message : '请求失败').replace(
          /[。.!\s]+$/u,
          '',
        );
        current.current.error(
          `自动续接已暂停：${detail}。${resumedSession.current && !historyAttached ? '续接消息尚未发送，上下文已保留在当前会话草稿中。' : '请检查会话和草稿后手动继续，客户端不会重发未确认请求。'}`,
        );
      } finally {
        setWorking(false);
      }
    })();
  }, [state.status, profiles.handoff, pool.config.enabled, client]);

  useEffect(() => {
    const sessionId = resumedSession.current;
    if (!sessionId || !profiles.handoff || profiles.handoff.queue?.items.length) return;
    const event = client.shown(sessionId).findLast((event) => event.payload.type === 'run.status');
    if (event?.payload.type === 'run.status' && event.payload.status === 'completed')
      profiles.completeHandoff();
  }, [state.events, profiles.handoff]);

  // The CLI can wait for hours after a rejection. Stop that wait only after its tools have settled.
  useEffect(() => {
    if (
      state.features.includes('account-pool') ||
      !pool.config.enabled ||
      state.status !== 'connected' ||
      options.busy ||
      options.terminalOpen ||
      working
    )
      return;
    for (const session of state.sessions) {
      const run = session.activeRun;
      if (
        !run ||
        run.surface === 'terminal' ||
        !isHere(session, state.device) ||
        cancelledRuns.current.has(run.id)
      )
        continue;
      const events = client.shown(session.id).filter((event) => event.runId === run.id);
      const rejection = events.findLast(
        (event) =>
          event.payload.type === 'run.error' &&
          (event.payload.code === 'quota_five_hour' || event.payload.code === 'quota_weekly'),
      );
      if (!rejection || Date.parse(rejection.createdAt) < mountedAt.current) continue;
      if (transcript(events).some((item) => item.kind === 'tool' && !item.resolved)) continue;
      cancelledRuns.current.add(run.id);
      setNotice('当前账号额度已耗尽，正在结束额度等待，随后切换账号…');
      void client
        .request({ type: 'run.cancel', sessionId: session.id, runId: run.id })
        .catch(() => {
          if (
            client.state.sessions.find((item) => item.id === session.id)?.activeRun?.id === run.id
          )
            setNotice('无法确认额度等待已结束，请先停止当前任务；客户端不会重复发送停止请求。');
        });
    }
  }, [state, pool.config.enabled, options.busy, options.terminalOpen, working]);

  useEffect(() => {
    if (
      state.features.includes('cross-server-handoff') ||
      !pool.config.enabled ||
      state.status !== 'connected' ||
      options.busy ||
      options.terminalOpen ||
      working ||
      rotating.current
    )
      return;
    // Never tear down another task or a terminal to rotate an exhausted account.
    if (state.sessions.some((session) => session.activeRun && isHere(session, state.device)))
      return;
    const failures = state.sessions
      .filter((session) => isHere(session, state.device))
      .map((session) => ({ session, event: quotaFailure(client.shown(session.id)) }))
      .filter(
        ({ event }) =>
          event &&
          Date.parse(event.createdAt) >= mountedAt.current &&
          event.payload.type === 'run.error' &&
          (event.payload.code === 'quota_five_hour' ||
            event.payload.code === 'quota_weekly' ||
            (exhausted(pool.quotas[id]) &&
              /hit your limit|usage limit|rate.?limit|额度.*(?:耗尽|用完)/i.test(
                event.payload.message,
              ))),
      );
    if (failures.length > 1) {
      setNotice(
        '多个会话因额度耗尽而暂停，请先选择需要续接的任务并手动切换账号。原会话记录已保留。',
      );
      return;
    }
    const failed = failures[0];
    if (state.features.includes('account-pool') && !failed) return;
    const failureKey = failed?.event ? `${failed.session.id}:${failed.event.runId}` : null;
    if (failureKey && continuedFailures.current.has(failureKey)) return;
    if (!failed && !exhausted(pool.quotas[id])) return;
    if (Date.now() < nextAttempt.current) return;
    const timer = setTimeout(() => {
      nextAttempt.current = Date.now() + 55_000;
      rotating.current = true;
      setWorking(true);
      setNotice('当前账号额度已耗尽，正在查找可用账号…');
      void (async () => {
        try {
          const reset =
            failed?.event?.payload.type === 'run.error' ? failed.event.payload.resetsAt : null;
          if (failureKey && !markedFailures.current.has(failureKey)) {
            markedFailures.current.add(failureKey);
            pool.markLimited(
              id,
              Date.parse(reset ?? fiveHour(pool.quotas[id])?.resetsAt ?? '') ||
                Date.now() + 300_000,
            );
          }
          const quotas = await pool.refresh();
          const attempted = [...new Set([...(profiles.handoff?.attempted ?? []), id])];
          // A previously tried account can return after its quota resets and fresh telemetry confirms it.
          const live = current.current;
          const next = poolCandidates(live.profiles.profiles, quotas, live.profiles.pool.config, [
            id,
          ])[0];
          if (
            !live.profiles.pool.config.enabled ||
            live.busy ||
            live.terminalOpen ||
            client.state.status !== 'connected' ||
            client.state.sessions.some(
              (session) => session.activeRun && isHere(session, client.state.device),
            )
          )
            return;
          if (!next) {
            if (
              failed &&
              failureKey &&
              poolCandidates(profiles.profiles, quotas, pool.config).some(
                (profile) => profile.id === id,
              )
            ) {
              continuedFailures.current.add(failureKey);
              await client.request({ type: 'run.continue', sessionId: failed.session.id });
              setNotice('当前账号额度已重置，已在原会话继续任务。');
            } else {
              setNotice('账号池已暂停：没有可用的其他账号。每分钟重新查询额度，重置后自动继续。');
            }
            return;
          }
          const handoff = failed ? await prepare(failed.session, attempted) : undefined;
          if (failed && failureKey) continuedFailures.current.add(failureKey);
          await live.close();
          await live.profiles.select(next.id, true, handoff);
        } catch (error) {
          setNotice(
            `账号池已暂停：${error instanceof Error ? error.message : '连接失败'}。请检查当前会话后手动继续。`,
          );
        } finally {
          rotating.current = false;
          setWorking(false);
        }
      })();
    }, 150);
    return () => clearTimeout(timer);
  }, [state, pool.quotas, pool.config, options.busy, options.terminalOpen]);
  return {
    transfer,
    sendAfterQuota,
    working:
      working ||
      (!!profiles.handoff &&
        (pool.config.enabled || profiles.handoff.manual === true) &&
        !resuming.current),
    notice,
    dismissNotice: () => setNotice(null),
  };
}
