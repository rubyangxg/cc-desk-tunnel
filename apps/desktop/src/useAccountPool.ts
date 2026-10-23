import { useCallback, useEffect, useRef, useState } from 'react';
import type { NativeMetrics, ServerPoolState } from '@cc-desk-tunnel/protocol';
import type { ConnectionProfile } from './connections.ts';
import type { PoolSettings, Quotas } from './accountPool.ts';

const key = 'proxy-account-pool';
const connectionKey = (profile: ConnectionProfile) =>
  JSON.stringify([
    profile.id,
    profile.mode,
    profile.url,
    profile.fingerprint,
    profile.remember,
    profile.token,
  ]);
function settings(): PoolSettings {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '{}');
    return {
      enabled: value.enabled !== false,
      strategy: value.strategy === 'manual' ? 'manual' : 'reset',
      order: Array.isArray(value.order)
        ? value.order.filter((id: unknown) => typeof id === 'string')
        : [],
      disabled: Array.isArray(value.disabled)
        ? value.disabled.filter((id: unknown) => typeof id === 'string')
        : [],
    };
  } catch {
    return { enabled: true, strategy: 'reset', order: [] };
  }
}

export function useAccountPool(profiles: ConnectionProfile[]) {
  const [config, setConfig] = useState(settings);
  const currentConfig = useRef(config);
  currentConfig.current = config;
  const [states, setStates] = useState<Record<string, ServerPoolState | null>>({});
  const [quotas, setQuotas] = useState<Quotas>({});
  const [refreshing, setRefreshing] = useState(false);
  const current = useRef(profiles);
  current.current = profiles;
  const latest = useRef(quotas);
  const pending = useRef<Promise<Quotas> | null>(null);
  const connections = useRef(new Map<string, string>());
  const update = useCallback((next: Quotas) => {
    latest.current = next;
    setQuotas(next);
  }, []);
  const observe = useCallback(
    (id: string, limits: NativeMetrics['rateLimits']) => {
      if (!limits?.available) return;
      const previous = latest.current[id];
      const measured = Date.parse(limits.measuredAt ?? '') || Date.now();
      if (previous && measured <= previous.checkedAt) return;
      update({
        ...latest.current,
        [id]: { limits, checkedAt: measured, blockedUntil: previous?.blockedUntil },
      });
    },
    [update],
  );
  const markLimited = useCallback(
    (id: string, until: number) => {
      update({
        ...latest.current,
        [id]: {
          limits: latest.current[id]?.limits ?? null,
          checkedAt: Date.now(),
          blockedUntil: until,
        },
      });
    },
    [update],
  );
  const configure = useCallback((values: Partial<PoolSettings>) => {
    const next = { ...currentConfig.current, ...values };
    currentConfig.current = next;
    localStorage.setItem(key, JSON.stringify(next));
    setConfig(next);
  }, []);
  const refresh = useCallback(
    (accounts = current.current): Promise<Quotas> => {
      if (pending.current) return pending.current;
      if (!window.desktop?.probeQuota) return Promise.resolve(latest.current);
      setRefreshing(true);
      pending.current = (async () => {
        await Promise.all(
          accounts
            .filter((profile) => profile.mode === 'remote' && profile.remember && profile.token)
            .map(async (profile) => {
              const checkedAt = Date.now();
              const unchanged = () =>
                !current.current.length ||
                current.current.some((item) => connectionKey(item) === connectionKey(profile));
              try {
                let details:
                  Awaited<ReturnType<NonNullable<Window['desktop']>['profilePool']>> | undefined;
                try {
                  details = await window.desktop?.profilePool?.(profile.id);
                } catch (error) {
                  if (!(error instanceof Error) || !error.message.includes('不支持账号池'))
                    throw error;
                }
                const limits = details
                  ? details.limits
                  : await window.desktop!.probeQuota(profile.id);
                if (!unchanged() || (latest.current[profile.id]?.checkedAt ?? 0) > checkedAt)
                  return;
                // A fresh authenticated probe re-enables a recovered endpoint automatically.
                if (limits?.available && currentConfig.current.disabled?.includes(profile.id))
                  configure({
                    disabled: currentConfig.current.disabled.filter((id) => id !== profile.id),
                  });
                setStates((value) => ({ ...value, [profile.id]: details?.state ?? null }));
                update({
                  ...latest.current,
                  [profile.id]: {
                    limits,
                    checkedAt: Date.parse(limits?.measuredAt ?? '') || checkedAt,
                    blockedUntil: latest.current[profile.id]?.blockedUntil,
                  },
                });
              } catch (error) {
                if (!unchanged() || (latest.current[profile.id]?.checkedAt ?? 0) > checkedAt)
                  return;
                update({
                  ...latest.current,
                  [profile.id]: {
                    limits: latest.current[profile.id]?.limits ?? null,
                    checkedAt,
                    error: error instanceof Error ? error.message : '额度查询失败',
                    blockedUntil: latest.current[profile.id]?.blockedUntil,
                  },
                });
              }
            }),
        );
        return latest.current;
      })().finally(() => {
        pending.current = null;
        setRefreshing(false);
      });
      return pending.current;
    },
    [update, configure],
  );
  const accountsKey = profiles.map(connectionKey).join('|');
  useEffect(() => {
    const next = new Map(current.current.map((profile) => [profile.id, connectionKey(profile)]));
    const quotas = { ...latest.current };
    let changed = false;
    for (const [id, signature] of connections.current) {
      if (next.get(id) !== signature) {
        delete quotas[id];
        setStates((value) => {
          const next = { ...value };
          delete next[id];
          return next;
        });
        changed = true;
      }
    }
    connections.current = next;
    if (changed) update(quotas);
    // Startup loads the saved services asynchronously. An empty background probe
    // must not take the pending slot used by startup's real service selection.
    if (!config.enabled || !current.current.length) return;
    let cancelled = false;
    if (pending.current)
      void pending.current.then(() => {
        if (!cancelled) void refresh();
      });
    else void refresh();
    const timer = setInterval(() => void refresh(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [config.enabled, accountsKey, refresh, update]);
  const markUnavailable = useCallback(
    (id: string) => {
      const disabled = currentConfig.current.disabled ?? [];
      if (!disabled.includes(id)) configure({ disabled: [...disabled, id] });
    },
    [configure],
  );
  const markAvailable = useCallback(
    (id: string) => {
      const disabled = currentConfig.current.disabled ?? [];
      if (disabled.includes(id)) configure({ disabled: disabled.filter((item) => item !== id) });
    },
    [configure],
  );
  const command = async (id: string, command: import('./UnifiedAccountPool.tsx').PoolCommand) => {
    const profile = current.current.find((item) => item.id === id);
    if (!profile || !window.desktop?.profilePool) throw new Error('请先连接该服务器管理账号。');
    const result = await window.desktop.profilePool(id, command);
    if (!current.current.some((item) => connectionKey(item) === connectionKey(profile)))
      throw new Error('服务器配置已改变，请重新检测。');
    setStates((value) => ({ ...value, [id]: result.state }));
    update({
      ...latest.current,
      [id]: {
        limits: result.limits,
        checkedAt: Date.now(),
        blockedUntil: latest.current[id]?.blockedUntil,
      },
    });
  };
  return {
    states,
    command,
    config,
    quotas,
    refreshing,
    refresh,
    observe,
    markLimited,
    configure,
    markUnavailable,
    markAvailable,
  };
}
export type AccountPool = ReturnType<typeof useAccountPool>;
