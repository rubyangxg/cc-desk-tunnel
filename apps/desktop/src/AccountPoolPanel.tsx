import { ArrowDown, ArrowUp, RefreshCw } from 'lucide-react';
import type { ConnectionProfile } from './connections.ts';
import type { AccountPool } from './useAccountPool.ts';
import { exhausted, fiveHour, poolCandidates } from './accountPool.ts';
import { IconButton, Switch } from './ui.tsx';

export default function AccountPoolPanel({
  pool,
  profiles,
  activeId,
  legacyService = false,
  connected = false,
}: {
  pool: AccountPool;
  profiles: ConnectionProfile[];
  activeId: string;
  legacyService?: boolean;
  connected?: boolean;
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
  const available = new Set(
    poolCandidates(profiles, pool.quotas, pool.config).map((profile) => profile.id),
  );
  return (
    <section className="account-pool" aria-label="账号池">
      <div className="pool-heading">
        <h2>跨服务器接力</h2>
        <Switch
          label="启用账号池自动切换"
          checked={pool.config.enabled}
          disabled={!window.desktop}
          onChange={(enabled) => pool.configure({ enabled })}
        />
      </div>
      <p className="profile-hint">
        本服务器额度耗尽后，连接可用服务器自动继续；聊天历史保留在本机。各服务需保存凭据。
      </p>
      {legacyService && (
        <p role="status" className="profile-hint">
          当前连接的是旧版服务端，可查询额度和手动切换。旧版缺少明确的额度耗尽通知，自动续接可能无法触发；请升级服务端以完整使用账号池。
        </p>
      )}
      <label>
        账号池使用顺序
        <select
          aria-label="账号池使用顺序"
          value={pool.config.strategy}
          onChange={(event) =>
            pool.configure({ strategy: event.target.value as 'reset' | 'manual' })
          }
        >
          <option value="reset">周额度即将重置优先</option>
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
        {pool.refreshing ? '正在检测服务与额度…' : '检测全部服务与额度'}
      </button>
      <ol className="pool-accounts">
        {order.map((id, index) => {
          const profile = profiles.find((profile) => profile.id === id)!;
          const quota = pool.quotas[id];
          const window = fiveHour(quota);
          const reset = window?.resetsAt && Date.parse(window.resetsAt);
          const disabled = pool.config.disabled?.includes(id);
          return (
            <li key={id}>
              <div>
                <strong>
                  {profile.name}
                  {id === activeId ? (connected ? ' · 已连接' : ' · 已选中') : ''}
                </strong>
                <small>
                  {disabled
                    ? '连接失败 · 已禁用调度'
                    : quota?.error
                      ? '检测失败 · 已暂停调度'
                      : !profile.remember || !profile.token
                        ? '需记住凭据才能自动切换'
                        : exhausted(quota)
                          ? '额度已用完'
                          : available.has(id)
                            ? `可调度 · 5 小时剩余 ${Math.max(0, 100 - window!.utilization!)}%`
                            : '待检测 · 暂不参与调度'}
                </small>
                {disabled && <small>正在后台检测，连接恢复后自动参与调度。</small>}
                {quota?.error && <small>{quota.error}</small>}
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
        检测不会切换当前服务。启用账号池后每分钟后台检测，检测失败或额度未知的服务暂停调度，检测恢复后重新参与。实际连接失败的服务会保持禁用，须重新连接成功后恢复；浏览器模拟模式只支持手动切换。
      </p>
    </section>
  );
}
