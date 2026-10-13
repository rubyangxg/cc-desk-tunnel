import { ArrowDown, ArrowUp, RefreshCw } from 'lucide-react';
import type { ConnectionProfile } from './connections.ts';
import type { AccountPool } from './useAccountPool.ts';
import { exhausted, fiveHour } from './accountPool.ts';
import { IconButton, Switch } from './ui.tsx';

export default function AccountPoolPanel({
  pool,
  profiles,
  activeId,
}: {
  pool: AccountPool;
  profiles: ConnectionProfile[];
  activeId: string;
}) {
  const order = [
    ...new Set([...pool.config.order, ...profiles.map((profile) => profile.id)]),
  ].filter((id) => profiles.some((profile) => profile.id === id));
  const move = (id: string, by: number) => {
    const next = [...order];
    const at = next.indexOf(id);
    [next[at], next[at + by]] = [next[at + by]!, next[at]!];
    pool.configure({ order: next });
  };
  return (
    <section className="account-pool" aria-label="账号池">
      <div className="pool-heading">
        <h2>账号池</h2>
        <Switch
          label="启用账号池自动切换"
          checked={pool.config.enabled}
          disabled={!window.desktop}
          onChange={(enabled) => pool.configure({ enabled })}
        />
      </div>
      <p className="profile-hint">
        5
        小时额度耗尽后，自动切换到可用账号，在同一项目新建会话并携带最近上下文继续。每个账号需保存服务凭据。所有账号都不可用时暂停。
      </p>
      <label>
        账号池使用顺序
        <select
          aria-label="账号池使用顺序"
          value={pool.config.strategy}
          onChange={(event) =>
            pool.configure({ strategy: event.target.value as 'reset' | 'manual' })
          }
        >
          <option value="reset">5 小时额度快重置的优先</option>
          <option value="manual">自定义顺序</option>
        </select>
      </label>
      <button
        type="button"
        className="button"
        disabled={pool.refreshing || !window.desktop?.probeQuota}
        onClick={() => void pool.refresh()}
      >
        <RefreshCw />
        {pool.refreshing ? '查询额度中…' : '刷新全部额度'}
      </button>
      <ol className="pool-accounts">
        {order.map((id, index) => {
          const profile = profiles.find((profile) => profile.id === id)!;
          const quota = pool.quotas[id];
          const window = fiveHour(quota);
          const reset = window?.resetsAt && Date.parse(window.resetsAt);
          return (
            <li key={id}>
              <div>
                <strong>
                  {profile.name}
                  {id === activeId ? ' · 当前' : ''}
                </strong>
                <small>
                  {!profile.remember || !profile.token
                    ? '需记住凭据才能自动切换'
                    : (quota?.error ??
                      (exhausted(quota)
                        ? '额度已用完'
                        : window?.utilization != null
                          ? `5 小时剩余 ${Math.max(0, 100 - window.utilization)}%`
                          : '额度未知，查询成功后可自动使用'))}
                </small>
                {reset ? <small>重置：{new Date(reset).toLocaleString('zh-CN')}</small> : null}
              </div>
              {pool.config.strategy === 'manual' && (
                <div className="pool-order">
                  <IconButton
                    title={`上移 ${profile.name}`}
                    disabled={index === 0}
                    onClick={() => move(id, -1)}
                  >
                    <ArrowUp />
                  </IconButton>
                  <IconButton
                    title={`下移 ${profile.name}`}
                    disabled={index === order.length - 1}
                    onClick={() => move(id, 1)}
                  >
                    <ArrowDown />
                  </IconButton>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <p className="profile-hint">
        每分钟刷新额度。查询失败或额度未知的账号暂不自动使用；浏览器模拟模式只支持手动切换。
      </p>
    </section>
  );
}
