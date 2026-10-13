import { useEffect, useRef, useState } from 'react';
import type { ProfileControls } from './Connections.tsx';
import type { ProxyClient } from './client.ts';
import { exhausted, fiveHour, handoffFor, poolCandidates, quotaFailure } from './accountPool.ts';
import { isHere } from './device.ts';
import { transcript } from './transcript.ts';

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
  const hasConnected = useRef(false);
  const failedConnectionHandled = useRef(false);
  const resumedSession = useRef<string | null>(null);
  const cancelledRuns = useRef(new Set<string>());
  const markedFailures = useRef(new Set<string>());
  const continuedFailures = useRef(new Set<string>());
  const nextAttempt = useRef(0);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

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
            '账号池已暂停：没有可调度的代理服务。请修复连接后选中该服务重新连接；成功后恢复调度。' +
              (live.profiles.handoff ? '待续接的任务上下文仍保留。' : ''),
          );
          return;
        }
        const handoff = live.profiles.handoff ? { ...live.profiles.handoff, attempted } : undefined;
        await live.close();
        if (!cancelled) await live.profiles.select(next.id, true, handoff);
      } catch (error) {
        if (!cancelled)
          setNotice(
            `账号池已暂停：${error instanceof Error ? error.message : '代理服务检测失败'}。请选中可用服务重新连接。`,
          );
      } finally {
        if (!cancelled) setWorking(false);
      }
    })();
    return () => {
      cancelled = true;
      setWorking(false);
    };
  }, [state.status, state.error, profiles.autoConnect, pool.config.enabled, pool.refresh, id]);

  useEffect(() => {
    pool.observe(id, state.metrics?.rateLimits ?? null);
  }, [state.metrics?.rateLimits, id, pool.observe]);

  useEffect(() => {
    const handoff = profiles.handoff;
    if (!handoff || !pool.config.enabled || state.status !== 'connected' || resuming.current)
      return;
    resuming.current = true;
    setWorking(true);
    setNotice(`已切换到 ${profiles.initial.name}，正在续接 ${handoff.session.title}…`);
    void (async () => {
      try {
        const result = await client.request({
          type: 'session.create',
          title: `${handoff.session.title.slice(0, 110)} · 续接`,
          projectPath: handoff.session.projectPath,
        });
        if (!result.sessionId) throw new Error('续接会话创建失败。');
        const sessionId = result.sessionId;
        resumedSession.current = sessionId;
        current.current.draft(sessionId, handoff.prompt);
        current.current.show(sessionId);
        await client.request({
          type: 'session.configure',
          sessionId,
          permissionMode: handoff.session.permissionMode,
          model: handoff.session.model,
          effort: handoff.session.effort,
        });
        if (!current.current.profiles.pool.config.enabled) throw new Error('账号池自动切换已关闭');
        await client.request({
          type: 'message.send',
          sessionId,
          text: handoff.prompt,
          scenario: 'chat',
        });
        current.current.draft(sessionId, '');
        setNotice(
          `已从 ${handoff.source} 切换到 ${profiles.initial.name}，携带最近上下文继续任务。`,
        );
      } catch (error) {
        current.current.error(
          `自动续接已暂停：${error instanceof Error ? error.message : '请求失败'}。请检查会话和草稿后手动继续，客户端不会重发未确认请求。`,
        );
      } finally {
        setWorking(false);
      }
    })();
  }, [state.status, profiles.handoff, pool.config.enabled, client]);

  useEffect(() => {
    const sessionId = resumedSession.current;
    if (!sessionId || !profiles.handoff) return;
    const event = client.shown(sessionId).findLast((event) => event.payload.type === 'run.status');
    if (event?.payload.type === 'run.status' && event.payload.status === 'completed')
      profiles.completeHandoff();
  }, [state.events, profiles.handoff]);

  // The CLI can wait for hours after a rejection. Stop that wait only after its tools have settled.
  useEffect(() => {
    if (
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
        (event) => event.payload.type === 'run.error' && event.payload.code === 'quota_five_hour',
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
          if (failed && failureKey) continuedFailures.current.add(failureKey);
          const handoff = failed
            ? handoffFor(
                failed.session,
                client.shown(failed.session.id),
                profiles.initial.name,
                attempted,
              )
            : undefined;
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
    working: working || (!!profiles.handoff && pool.config.enabled && !resuming.current),
    notice,
  };
}
