import { useEffect, useState } from 'react';
import { RefreshCw, Unplug } from 'lucide-react';
import type { ClientState } from './client.ts';

export default function ReconnectNotice({
  retry,
  restarting,
  error,
  retryNow,
  disconnect,
}: {
  retry: ClientState['retry'];
  restarting: boolean;
  error: string | null;
  retryNow: () => void;
  disconnect: () => void;
}) {
  const [, tick] = useState(0);
  const nextAt = retry?.nextAt;
  useEffect(() => {
    if (nextAt == null) return;
    const timer = setInterval(() => tick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [nextAt]);
  const waiting = nextAt != null;
  return (
    <div className="connection-banner reconnect-notice">
      <Unplug aria-hidden="true" />
      <div className="reconnect-copy">
        <div role="status">
          <strong>{restarting ? '服务端重启中，正在自动重连' : '连接中断，正在自动重连'}</strong>
          <span>
            {waiting
              ? `${Math.max(0, Math.ceil((nextAt - Date.now()) / 1000))} 秒后重试`
              : `正在进行第 ${retry?.attempt ?? 1} 次重试`}
          </span>
        </div>
        <p>连上后自动同步历史和任务状态；服务端重启可能中断任务。</p>
        {error && (
          <details>
            <summary>连接详情</summary>
            <p>{error}</p>
          </details>
        )}
      </div>
      <button type="button" className="button" disabled={!waiting} onClick={retryNow}>
        <RefreshCw aria-hidden="true" className={waiting ? undefined : 'spinning'} />
        {waiting ? '立即重试' : '连接中…'}
      </button>
      <button type="button" className="button" onClick={disconnect}>
        断开并回到登录页
      </button>
    </div>
  );
}
