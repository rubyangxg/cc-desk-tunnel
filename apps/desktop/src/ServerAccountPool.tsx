import { useEffect, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  Clock3,
  ExternalLink,
  LogIn,
  LogOut,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  ListOrdered,
} from 'lucide-react';
import type {
  ServerPoolAccount,
  ServerPoolSettings,
  ServerPoolState,
  UsageSummary,
} from '@cc-desk-tunnel/protocol';
import UsagePanel, { dollars } from './UsagePanel.tsx';
import type { ProxyClient } from './client.ts';
import { IconButton, Modal, Switch } from './ui.tsx';
import { copyText } from './copy.tsx';

function status(account: ServerPoolAccount, now: number) {
  if (!account.enabled) return { text: '已停用', kind: 'muted' };
  if (account.login) return { text: '等待授权', kind: 'warning' };
  if (account.loggedIn === false) return { text: '需要登录', kind: 'warning' };
  if (account.error) return { text: '暂停调度', kind: 'warning' };
  if (
    (account.blockedUntil ?? 0) > now ||
    account.limits?.windows.some(
      (window) =>
        ['five_hour', 'seven_day'].includes(window.name) && (window.utilization ?? 0) >= 100,
    )
  )
    return { text: '等待重置', kind: 'warning' };
  if (
    account.loggedIn !== true ||
    !account.limits?.available ||
    account.checkedAt === null ||
    now - account.checkedAt >= 120_000 ||
    typeof account.limits.windows.find((window) => window.name === 'five_hour')?.utilization !==
      'number'
  )
    return { text: '待检测', kind: 'muted' };
  return { text: '可调度', kind: 'ready' };
}
function resetTime(value: string | null | undefined, now: number) {
  const time = Date.parse(value ?? '');
  if (!Number.isFinite(time)) return '重置时间未知';
  if (time <= now) return '等待确认重置';
  const minutes = Math.ceil((time - now) / 60000);
  return `${minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ` : ''}${minutes % 60} 分钟后重置`;
}
function Quota({
  account,
  name,
  label,
  now,
}: {
  account: ServerPoolAccount;
  name: string;
  label: string;
  now: number;
}) {
  const window = account.limits?.windows.find((item) => item.name === name);
  const usage = account.usage?.find((item) => item.name === name);
  const remaining =
    typeof window?.utilization === 'number'
      ? Math.max(0, Math.min(100, 100 - window.utilization))
      : null;
  return (
    <div className="server-quota">
      <div>
        <span>{label}</span>
        <strong>
          {remaining === null ? '—' : `${Math.round(remaining)}%`}
          <small> 剩余</small>
        </strong>
      </div>
      <div
        className={`quota-track ${remaining !== null && remaining < 15 ? 'low' : ''}`}
        role="meter"
        aria-label={`${label}剩余额度`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={remaining ?? undefined}
        aria-valuetext={remaining === null ? '尚未读取' : `${Math.round(remaining)}%`}
      >
        <i style={{ width: `${remaining ?? 0}%` }} />
      </div>
      <small>
        <Clock3 />
        {resetTime(window?.resetsAt, now)}
        <span
          className="pool-quota-cost"
          title="本服务记录的本周期调用，按 API 价格估算，非订阅账单"
        >
          等价 {usage ? dollars(usage.costUsd) : '—'}
        </span>
      </small>
    </div>
  );
}

export default function ServerAccountPool({
  client,
  pool,
  connected,
  serviceName,
}: {
  client: ProxyClient;
  pool: ServerPoolState | null;
  connected: boolean;
  serviceName: string;
}) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ id?: string; name: string } | null>(null);
  const [logout, setLogout] = useState<ServerPoolAccount | null>(null);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [, setTick] = useState(0);
  const offset = useMemo(
    () => (pool?.serverTime ? pool.serverTime - Date.now() : 0),
    [pool?.serverTime],
  );
  const now = Date.now() + offset;
  const [log, setLog] = useState(false);
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (log) void client.fetch({ type: 'usage.summary' }).then(setSummary, () => {});
  }, [log, client]);
  async function act(command: Parameters<ProxyClient['request']>[0]) {
    if (!connected || working) return false;
    setWorking(true);
    setError(null);
    try {
      await client.request(command);
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : '操作失败，请重试。');
      return false;
    } finally {
      setWorking(false);
    }
  }
  const disabled = working || !connected;
  const configure = (values: Partial<ServerPoolSettings>) =>
    void act({ type: 'pool.configure', values });
  const order = pool
    ? [...new Set([...pool.settings.order, ...pool.accounts.map((account) => account.id)])]
    : [];
  const accounts = order.flatMap((id) => pool?.accounts.find((account) => account.id === id) ?? []);
  const ready = accounts.filter((account) => status(account, now).kind === 'ready').length;
  const waits = pool?.quotaWaits ?? [];
  const scheduled = waits.filter((wait) => wait.at !== null).sort((a, b) => a.at! - b.at!)[0];
  const reset = waits.length ? scheduled : ready === 0 ? pool?.nextReset : null;
  const seconds = reset?.at != null ? Math.max(0, Math.ceil((reset.at - now) / 1000)) : null;
  const countdown =
    seconds === null
      ? '等待重置时间'
      : seconds === 0
        ? '正在确认额度恢复…'
        : [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
            .map((value) => String(value).padStart(2, '0'))
            .join(':');
  const resetAccount = accounts.find((account) => account.id === reset?.accountId);
  const move = (at: number, by: number) => {
    const next = [...order];
    [next[at], next[at + by]] = [next[at + by]!, next[at]!];
    configure({ strategy: 'order', order: next });
  };
  if (log)
    return (
      <UsagePanel client={client} summary={summary} initial="today" back={() => setLog(false)} />
    );
  return (
    <section className="server-pool-page" aria-label="Claude 账号池">
      <header className="server-pool-hero">
        <div className="pool-service-tag">
          <Server />
          {serviceName}
        </div>
        <div className="pool-title-row">
          <h1>Claude 账号池</h1>
          <button
            className="button primary"
            disabled={disabled || !pool || accounts.length >= 10}
            onClick={() => setEdit({ name: '' })}
          >
            <Plus />
            添加 Claude 账号
          </button>
        </div>
        <div className="pool-summary-grid">
          <div>
            <span>可调度</span>
            <strong>
              {ready}
              <small> / {accounts.length}</small>
            </strong>
          </div>
          <div>
            <span>已登录</span>
            <strong>{accounts.filter((account) => account.loggedIn).length}</strong>
          </div>
        </div>
        {(waits.length > 0 || reset) && (
          <div className="pool-reset-banner" aria-label="额度重置倒计时">
            <Clock3 />
            <span>{waits.length ? '自动继续' : '最早重置'}</span>
            <strong role="timer" aria-label="距额度重置">
              {connected ? countdown : '等待重新连接'}
            </strong>
            {resetAccount && <span className="pool-reset-account">{resetAccount.name}</span>}
            <small>
              {!connected
                ? '重新连接后确认等待状态'
                : waits.length
                  ? `恢复后自动发送 continue · ${waits.length} 个任务等待`
                  : pool?.quotaWaits === undefined
                    ? '更新服务端以查看待续任务'
                    : '暂无待续任务'}
            </small>
          </div>
        )}
      </header>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {!connected && (
        <p className="pool-status-message" role="status">
          连接已中断，恢复后可管理账号。
        </p>
      )}
      {!pool ? (
        <div className="pool-status-message" role="status">
          正在读取服务端账号池…
          <button
            className="button"
            disabled={disabled}
            onClick={() => void act({ type: 'pool.status' })}
          >
            重新读取
          </button>
        </div>
      ) : (
        <>
          <div className="pool-policy-card">
            <div className="pool-policy-heading">
              <h2 title="额度耗尽后接力；全部账号耗尽时等待重置">自动接力</h2>
              <Switch
                label="启用服务端账号池"
                checked={pool.settings.enabled}
                disabled={disabled}
                onChange={(enabled) => configure({ enabled })}
              />
            </div>
            <div className="pool-policy-fields">
              <label>
                优先顺序
                <select
                  aria-label="服务端账号优先顺序"
                  value={pool.settings.strategy}
                  disabled={disabled}
                  onChange={(event) =>
                    configure({ strategy: event.target.value as 'reset' | 'order' })
                  }
                >
                  <option value="reset">5 小时额度最快重置</option>
                  <option value="order">自定义顺序</option>
                </select>
              </label>
              <label>
                固定账号
                <select
                  aria-label="默认 Claude 账号"
                  value={pool.settings.preferredId}
                  disabled={disabled}
                  onChange={(event) => configure({ preferredId: event.target.value })}
                >
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
          <div className="pool-list-heading">
            <h2>
              账号 <span>{accounts.length}</span>
            </h2>
            <div className="pool-toolbar">
              <button className="button secondary" disabled={disabled} onClick={() => setLog(true)}>
                <ListOrdered />
                调用记录
              </button>
              <button
                className="button secondary"
                disabled={disabled || pool.refreshing}
                onClick={() => void act({ type: 'pool.status', refresh: true })}
              >
                <RefreshCw className={pool.refreshing ? 'spinning' : ''} />
                {pool.refreshing ? '正在检测…' : '检测全部账号'}
              </button>
            </div>
          </div>
          <div className="server-account-grid">
            {accounts.map((account, index) => {
              const state = status(account, now);
              return (
                <article
                  className={`server-account-card ${!account.enabled ? 'account-disabled' : ''}`}
                  key={account.id}
                  aria-label={`Claude 账号 · ${account.name}`}
                >
                  <div className="pool-account-top">
                    <span className="pool-account-avatar">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <div className="pool-account-identity">
                      <h3>{account.name}</h3>
                      {account.email && account.email !== account.name && <p>{account.email}</p>}
                    </div>
                    <span className={`pool-state ${state.kind}`}>{state.text}</span>
                  </div>
                  <div className="pool-account-tags">
                    <span>{account.subscriptionType ?? 'Claude Code'}</span>
                    {account.busy && <span className="account-running">任务运行中</span>}
                    {account.id === pool.settings.preferredId && <span>默认账号</span>}
                  </div>
                  <Quota account={account} name="five_hour" label="5 小时额度" now={now} />
                  <Quota account={account} name="seven_day" label="每周额度" now={now} />
                  {account.error && <p className="pool-account-error">{account.error}</p>}
                  {account.login && (
                    <form
                      className="pool-login-form"
                      aria-label={`授权 ${account.name}`}
                      onSubmit={(event) => {
                        event.preventDefault();
                        void act({
                          type: 'pool.account.code',
                          accountId: account.id,
                          code: codes[account.id]?.trim() ?? '',
                        }).then((ok) => {
                          if (ok) setCodes((value) => ({ ...value, [account.id]: '' }));
                        });
                      }}
                    >
                      <p>打开官方授权页，登录这个账号，再粘贴授权码。</p>
                      <div>
                        <button
                          type="button"
                          className="button secondary"
                          onClick={() => {
                            if (window.desktop)
                              void window.desktop
                                .openExternal(account.login!.url)
                                .catch(() => setError('打开浏览器失败，请复制授权链接。'));
                            else window.open(account.login!.url, '_blank', 'noopener');
                          }}
                        >
                          <ExternalLink />
                          打开授权页
                        </button>
                        <button
                          type="button"
                          className="button secondary"
                          onClick={() =>
                            void copyText(account.login!.url).catch(() =>
                              setError('复制失败，请重试。'),
                            )
                          }
                        >
                          复制链接
                        </button>
                      </div>
                      <label>
                        授权码
                        <input
                          aria-label={`${account.name} 的授权码`}
                          autoComplete="off"
                          value={codes[account.id] ?? ''}
                          onChange={(event) =>
                            setCodes((value) => ({ ...value, [account.id]: event.target.value }))
                          }
                          required
                        />
                      </label>
                      <div>
                        <button
                          className="button primary"
                          disabled={disabled || !codes[account.id]?.trim()}
                        >
                          <Check />
                          完成登录
                        </button>
                        <button
                          type="button"
                          className="button secondary"
                          disabled={disabled}
                          onClick={() =>
                            void act({ type: 'pool.account.cancel', accountId: account.id })
                          }
                        >
                          取消授权
                        </button>
                      </div>
                    </form>
                  )}
                  <footer className="pool-account-actions">
                    <div>
                      {!account.login && (
                        <button
                          className="button secondary"
                          disabled={disabled || account.busy || pool.refreshing}
                          onClick={() =>
                            account.loggedIn
                              ? setLogout(account)
                              : void act({ type: 'pool.account.login', accountId: account.id })
                          }
                        >
                          {account.loggedIn ? <LogOut /> : <LogIn />}
                          {account.loggedIn ? '退出登录' : '登录账号'}
                        </button>
                      )}
                      <IconButton
                        title={`重命名 ${account.name}`}
                        disabled={disabled}
                        onClick={() => setEdit({ id: account.id, name: account.name })}
                      >
                        <Pencil />
                      </IconButton>
                      {pool.settings.strategy === 'order' && (
                        <>
                          <IconButton
                            title={`上移 ${account.name}`}
                            disabled={disabled || index === 0}
                            onClick={() => move(index, -1)}
                          >
                            <ArrowUp />
                          </IconButton>
                          <IconButton
                            title={`下移 ${account.name}`}
                            disabled={disabled || index === accounts.length - 1}
                            onClick={() => move(index, 1)}
                          >
                            <ArrowDown />
                          </IconButton>
                        </>
                      )}
                    </div>
                    <label className="pool-enable-label">
                      参与调度
                      <Switch
                        label={`启用 ${account.name}`}
                        checked={account.enabled}
                        disabled={disabled}
                        onChange={(enabled) =>
                          void act({ type: 'pool.account.update', accountId: account.id, enabled })
                        }
                      />
                    </label>
                  </footer>
                  <small className="pool-checked">
                    {account.checkedAt
                      ? `上次检测 ${new Date(account.checkedAt).toLocaleTimeString('zh-CN')}`
                      : '登录后自动检测额度'}
                  </small>
                </article>
              );
            })}
          </div>
        </>
      )}
      {edit && (
        <Modal
          title={edit.id ? '修改账号名称' : '添加 Claude 账号'}
          onClose={() => !working && setEdit(null)}
        >
          <form
            className="pool-edit-form"
            onSubmit={(event) => {
              event.preventDefault();
              void act(
                edit.id
                  ? { type: 'pool.account.update', accountId: edit.id, name: edit.name.trim() }
                  : { type: 'pool.add', name: edit.name.trim() },
              ).then((ok) => {
                if (ok) setEdit(null);
              });
            }}
          >
            <label>
              账号名称
              <input
                autoFocus
                aria-label="Claude 账号名称"
                value={edit.name}
                maxLength={80}
                required
                onChange={(event) => setEdit({ ...edit, name: event.target.value })}
                placeholder="例如：主力账号"
              />
            </label>
            {error && (
              <p role="alert" className="error-text">
                {error}
              </p>
            )}
            <div className="pool-modal-actions">
              <button
                type="button"
                className="button"
                disabled={working}
                onClick={() => setEdit(null)}
              >
                取消
              </button>
              <button className="button primary" disabled={disabled || !edit.name.trim()}>
                {edit.id ? '保存名称' : '添加账号'}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {logout && (
        <Modal title={`退出 ${logout.name}`} onClose={() => setLogout(null)}>
          <div className="pool-edit-form">
            <p>退出后需要重新授权才能使用这个账号。已有项目和会话记录保留。</p>
            <div className="pool-modal-actions">
              <button className="button" disabled={working} onClick={() => setLogout(null)}>
                取消
              </button>
              <button
                className="button danger"
                disabled={disabled}
                onClick={() =>
                  void act({ type: 'pool.account.logout', accountId: logout.id }).then((ok) => {
                    if (ok) setLogout(null);
                  })
                }
              >
                确认退出
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
