import { useEffect, useState } from 'react';
import { Activity, Clock3, Database } from 'lucide-react';
import type { NativeMetrics } from '@cc-desk-tunnel/protocol';
import ContextMeter from './ContextMeter.tsx';
import { usePrefs } from './prefs.ts';
import type { ProxyClient } from './client.ts';
import { barText, sessionFields, type SessionField, type SessionStats } from './sessionStats.ts';
import { usePopover } from './usePopover.ts';

type AccountQuota = {
  name: string;
  limits: NativeMetrics['rateLimits'];
  error?: string;
};

function QuotaPart({ quota, openAccount }: { quota: AccountQuota; openAccount: () => void }) {
  const figures = [
    ['five_hour', '5 小时'],
    ['seven_day', '周'],
  ].map(([name, label]) => {
    const window = quota.limits?.windows.find((item) => item.name === name);
    const remaining =
      !quota.error && quota.limits?.available && typeof window?.utilization === 'number'
        ? Math.round(Math.max(0, Math.min(100, 100 - window.utilization)))
        : null;
    return { label, remaining, resetsAt: window?.resetsAt };
  });
  return (
    <div className="session-bar-part account-quota">
      <button
        type="button"
        aria-label="当前账号剩余额度"
        title={[
          quota.name,
          quota.error,
          ...figures.map(({ label, remaining, resetsAt }) =>
            remaining === null
              ? `${label}额度尚未读取`
              : `${label}剩余 ${remaining}%${
                  resetsAt && Number.isFinite(Date.parse(resetsAt))
                    ? `，${new Date(resetsAt).toLocaleString('zh-CN')} 重置`
                    : ''
                }`,
          ),
          '点击查看账号与额度',
        ]
          .filter(Boolean)
          .join('\n')}
        onClick={openAccount}
      >
        <Clock3 aria-hidden="true" />
        {figures.map(({ label, remaining }, index) => (
          <span key={label}>
            {index > 0 && <span className="quota-separator"> · </span>}
            <span
              className={
                remaining === null ? '' : remaining <= 10 ? 'danger' : remaining <= 30 ? 'warn' : ''
              }
            >
              {label}剩余 {remaining === null ? '—' : `${remaining}%`}
            </span>
          </span>
        ))}
      </button>
    </div>
  );
}

// One part of the bar: a button with the figures switched on that opens a card with all of them.
function Part({
  group,
  stats,
  chosen,
  title,
  icon,
  note,
}: {
  group: SessionField['group'];
  stats: SessionStats;
  chosen: Record<string, boolean>;
  title: string;
  icon: React.ReactNode;
  note?: string;
}) {
  const { open, setOpen, container, card } = usePopover();
  const rows = sessionFields.flatMap((field) => {
    const value = field.group === group ? field.value(stats) : null;
    return value == null ? [] : [{ field, value }];
  });
  if (rows.length === 0) return null;
  const headline = rows.find(({ field }) => field.key === 'tokens' || field.key === 'turns');
  return (
    <div className={`session-bar-part ${group}`} ref={container}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {icon}
        <span>{barText(group, stats, chosen) || title}</span>
      </button>
      {open && (
        <div className="turn-stats-card" role="dialog" aria-label={title} ref={card}>
          <header>
            {icon}
            <strong>{title}</strong>
            {headline && <b>{headline.value}</b>}
          </header>
          <dl>
            {rows
              .filter((row) => row !== headline)
              .map(({ field, value }) => (
                <div key={field.key}>
                  <dt>{field.label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
          </dl>
          {note && <p>{note}</p>}
        </div>
      )}
    </div>
  );
}

// The strip under the input box, centred: what the whole session has done and used, and how full the context
// window is. It asks the service again whenever a turn's report arrives, `refresh` counting them.
export default function SessionBar({
  client,
  sessionId,
  refresh,
  metrics,
  native,
  accountQuota,
  openAccount,
}: {
  client: ProxyClient;
  sessionId: string;
  refresh: number;
  metrics: NativeMetrics | null;
  native: boolean;
  accountQuota: AccountQuota;
  openAccount: () => void;
}) {
  const { sessionBar } = usePrefs();
  const [stats, setStats] = useState<SessionStats | null>(null);
  useEffect(() => {
    if (!sessionBar.enabled || (client.state.serviceProtocol ?? 0) < 19) return;
    let current = true;
    client.fetch({ type: 'session.stats', sessionId }).then(
      (result) => current && setStats(result),
      () => current && setStats(null),
    );
    return () => {
      current = false;
    };
  }, [client, sessionId, refresh, sessionBar.enabled, client.state.serviceProtocol]);
  if (!sessionBar.enabled) return null;
  const shown = !!stats && stats.sessionId === sessionId && stats.requests > 0;
  if (!shown && !native) return null;
  // The call log is pruned, so a session older than its oldest record is counted from there.
  const since = stats?.firstRecordAt
    ? `调用记录最早从 ${new Date(stats.firstRecordAt).toLocaleDateString('zh-CN')} 起，更早的请求不在统计内。`
    : undefined;
  return (
    <div className="session-bar">
      {shown && stats && (
        <>
          <Part
            group="session"
            stats={stats}
            chosen={sessionBar.summary}
            title="会话统计"
            icon={<Activity />}
            note={since}
          />
          <Part
            group="tokens"
            stats={stats}
            chosen={sessionBar.summary}
            title="Token 用量"
            icon={<Database />}
            note={since}
          />
        </>
      )}
      {native && <ContextMeter metrics={metrics} withPercent />}
      {native && <QuotaPart quota={accountQuota} openAccount={openAccount} />}
    </div>
  );
}
