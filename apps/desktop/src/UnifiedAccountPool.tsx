import { useEffect, useState } from 'react';
import type { Command, NativeMetrics, ServerPoolState } from '@cc-desk-tunnel/protocol';
import type { ProfileControls } from './Connections.tsx';
import type { ProxyClient } from './client.ts';
import ServerAccountPool, { Quota, status } from './ServerAccountPool.tsx';
import { ArrowUp, ArrowDown } from 'lucide-react';
import { sessionSource } from './sessionCatalog.ts';
import { Switch, IconButton } from './ui.tsx';

export type PoolCommand =
  | Omit<Extract<Command, { type: 'pool.status' }>, 'requestId'>
  | Omit<Extract<Command, { type: 'pool.configure' }>, 'requestId'>
  | Omit<Extract<Command, { type: 'pool.account.update' }>, 'requestId'>;
export type PoolSnapshot = { state: ServerPoolState; limits: NativeMetrics['rateLimits'] };

export default function UnifiedAccountPool({
  client,
  state,
  profiles,
  connected,
  select,
}: {
  client: ProxyClient;
  state: ServerPoolState | null;
  profiles: ProfileControls;
  connected: boolean;
  select: (id: string) => void;
}) {
  const { pool, initial, profiles: configured } = profiles;
  const endpoint = (profile: typeof initial) => {
    try {
      const { url, fingerprint } = sessionSource(profile);
      return JSON.stringify([url, fingerprint]);
    } catch {
      return profile.id;
    }
  };
  const seen = new Set([endpoint(initial)]);
  const others = configured.filter((profile) => {
    const key = endpoint(profile);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const order = [
    ...new Set([...pool.config.order, ...configured.map((profile) => profile.id)]),
  ].filter((id) => configured.some((profile) => profile.id === id));
  const move = (index: number, delta: number) => {
    const next = [...order];
    [next[index], next[index + delta]] = [next[index + delta]!, next[index]!];
    pool.configure({ order: next });
  };
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    void pool.refresh();
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    const polling = setInterval(() => void pool.refresh(), 60_000);
    return () => {
      clearInterval(timer);
      clearInterval(polling);
    };
  }, [pool.refresh]);
  const entries = others.flatMap((profile) =>
    (pool.states[profile.id]?.accounts ?? []).map((account) => ({ profile, account })),
  );
  const enabled = !!state?.settings.enabled && (!others.length || pool.config.enabled);
  const eligible = (id: string, accountId: string) => {
    const remote = pool.states[id];
    return (
      !pool.quotas[id]?.error &&
      !pool.config.disabled?.includes(id) &&
      !!remote &&
      (remote.settings.enabled || remote.settings.preferredId === accountId)
    );
  };
  async function act(action: () => Promise<unknown>) {
    if (working) return;
    setWorking(true);
    setError('');
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : '操作失败');
    } finally {
      setWorking(false);
    }
  }
  async function configure(values: { enabled?: boolean; strategy?: 'reset' | 'order' }) {
    // Every endpoint acknowledges its policy before the local cross-service policy is enabled.
    // Failures are surfaced individually: the user can retry without assuming remote settings changed.
    if (values.enabled === false) pool.configure({ enabled: false });
    const failures: string[] = [];
    try {
      await client.request({ type: 'pool.configure', values });
    } catch (error) {
      failures.push(`${initial.name}：${String(error)}`);
    }
    for (const profile of others) {
      try {
        await pool.command(profile.id, { type: 'pool.configure', values });
      } catch (error) {
        failures.push(`${profile.name}：${error instanceof Error ? error.message : '配置失败'}`);
      }
    }
    if (failures.length) throw new Error(failures.join('；'));
    pool.configure({
      ...(values.enabled === undefined ? {} : { enabled: values.enabled }),
      ...(values.strategy ? { strategy: values.strategy === 'reset' ? 'reset' : 'manual' } : {}),
    });
  }
  if (!others.length)
    return (
      <ServerAccountPool
        client={client}
        pool={state}
        connected={connected}
        serviceName={initial.name}
      />
    );
  return (
    <ServerAccountPool
      client={client}
      pool={state}
      connected={connected}
      serviceName={initial.name}
      unified={{
        count: entries.length,
        loggedIn: entries.filter(({ account }) => account.loggedIn).length,
        ready: entries.filter(
          ({ profile, account }) =>
            eligible(profile.id, account.id) && status(account, now).kind === 'ready',
        ).length,
        nextReset: enabled
          ? others
              .flatMap((profile) => {
                const remote = pool.states[profile.id];
                const reset = remote?.nextReset;
                return remote && reset?.at && eligible(profile.id, reset.accountId)
                  ? [
                      {
                        at: reset.at,
                        name: `${profile.name} · ${remote.accounts.find((account) => account.id === reset.accountId)?.name ?? '账号'}`,
                      },
                    ]
                  : [];
              })
              .sort((a, b) => a.at - b.at)[0]
          : undefined,
        refreshing: pool.refreshing,
        refresh: () => void pool.refresh(),
        picker: (
          <label className="pool-service-picker">
            管理服务器
            <select
              aria-label="管理服务器"
              value={initial.id}
              onChange={(event) => select(event.target.value)}
            >
              {configured.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </label>
        ),
        policy: (
          <>
            <div className="pool-policy-card">
              <div className="pool-policy-heading">
                <h2>自动接力</h2>
                <Switch
                  label="启用统一账号池"
                  checked={enabled}
                  disabled={working || !connected || !state}
                  onChange={(enabled) => void act(() => configure({ enabled }))}
                />
              </div>
              <div className="pool-policy-fields">
                <label>
                  优先顺序
                  <select
                    aria-label="统一账号优先顺序"
                    disabled={working || !connected || !state}
                    value={pool.config.strategy === 'manual' ? 'order' : 'reset'}
                    onChange={(event) =>
                      void act(() =>
                        configure({ strategy: event.target.value as 'reset' | 'order' }),
                      )
                    }
                  >
                    <option value="reset">周额度即将重置优先</option>
                    <option value="order">配置顺序</option>
                  </select>
                </label>
                <label>
                  当前服务器固定账号
                  <select
                    aria-label="默认 Claude 账号"
                    value={state?.settings.preferredId ?? ''}
                    disabled={working || !connected}
                    onChange={(event) =>
                      void act(() =>
                        client.request({
                          type: 'pool.configure',
                          values: { preferredId: event.target.value },
                        }),
                      )
                    }
                  >
                    {state?.accounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
            {pool.config.strategy === 'manual' && (
              <details className="pool-server-order">
                <summary>服务器顺序</summary>
                {order.map((id, index) => (
                  <div key={id}>
                    <span>{configured.find((profile) => profile.id === id)?.name}</span>
                    <IconButton
                      title={`上移服务器 ${configured.find((profile) => profile.id === id)?.name}`}
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                    >
                      <ArrowUp />
                    </IconButton>
                    <IconButton
                      title={`下移服务器 ${configured.find((profile) => profile.id === id)?.name}`}
                      disabled={index === order.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      <ArrowDown />
                    </IconButton>
                  </div>
                ))}
              </details>
            )}
            {!enabled &&
              (state?.settings.enabled ||
                others.some((profile) => pool.states[profile.id]?.settings.enabled)) && (
                <p className="pool-status-message">
                  部分服务器已开启内部接力；开启统一开关后启用跨服务器接力。
                </p>
              )}
            {error && (
              <p role="alert" className="error-text">
                {error}
              </p>
            )}
            {others.map((profile) => {
              const remote = pool.states[profile.id];
              const issue =
                pool.quotas[profile.id]?.error ??
                (!remote
                  ? pool.states[profile.id] === null
                    ? '此服务不支持账号池，请升级服务端'
                    : profile.remember && profile.token
                      ? '正在读取账号…'
                      : '保存连接凭据后自动读取账号'
                  : pool.config.disabled?.includes(profile.id)
                    ? '连接暂不可用，正在自动检测恢复'
                    : enabled && !remote.settings.enabled
                      ? '此服务器自动接力未开启，请重新开启统一开关'
                      : null);
              return issue ? (
                <p className="pool-status-message" key={profile.id}>
                  {profile.name}：{issue}{' '}
                  <button className="button secondary" onClick={() => select(profile.id)}>
                    连接管理
                  </button>
                </p>
              ) : null;
            })}
          </>
        ),
        cards: entries.map(({ profile, account }) => {
          const fresh = status(account, now);
          const badge =
            !eligible(profile.id, account.id) && fresh.kind === 'ready'
              ? {
                  text: pool.quotas[profile.id]?.error ? '离线 · 上次数据' : '未参与调度',
                  kind: 'muted',
                }
              : fresh;
          return (
            <article
              key={`${profile.id}:${account.id}`}
              className={`server-account-card ${!account.enabled ? 'account-disabled' : ''}`}
              aria-label={`Claude 账号 · ${profile.name} · ${account.name}`}
            >
              <div className="pool-account-top">
                <div className="pool-account-identity">
                  <h3>{account.name}</h3>
                  {account.email && account.email !== account.name && <p>{account.email}</p>}
                </div>
                <span className={`pool-state ${badge.kind}`}>{badge.text}</span>
              </div>
              <div className="pool-account-tags">
                <span className="pool-service-badge">{profile.name}</span>
                <span>{account.subscriptionType ?? 'Claude Code'}</span>
                {account.busy && <span className="account-running">任务运行中</span>}
              </div>
              <Quota account={account} name="five_hour" label="5 小时额度" now={now} />
              <Quota account={account} name="seven_day" label="每周额度" now={now} />
              {account.error && <p className="pool-account-error">{account.error}</p>}
              <footer className="pool-account-actions">
                <button className="button secondary" onClick={() => select(profile.id)}>
                  连接管理
                </button>
                <label className="pool-enable-label">
                  参与调度
                  <Switch
                    label={`启用 ${profile.name} · ${account.name}`}
                    checked={account.enabled}
                    disabled={working || !!pool.quotas[profile.id]?.error}
                    onChange={(enabled) =>
                      void act(() =>
                        pool.command(profile.id, {
                          type: 'pool.account.update',
                          accountId: account.id,
                          enabled,
                        }),
                      )
                    }
                  />
                </label>
              </footer>
              <small className="pool-checked">
                {account.checkedAt
                  ? `上次检测 ${new Date(account.checkedAt).toLocaleTimeString('zh-CN')}`
                  : '尚未检测'}
              </small>
            </article>
          );
        }),
      }}
    />
  );
}
