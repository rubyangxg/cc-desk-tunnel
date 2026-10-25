import { useEffect, useRef, useState } from 'react';
import type { ClientState } from './client.ts';
import type { Session } from '@cc-desk-tunnel/protocol';
import type { ConnectionProfile } from './connections.ts';
import {
  otherSessions,
  readCatalog,
  sessionSource,
  sourceKey,
  writeCatalog,
} from './sessionCatalog.ts';
import type { CatalogEntry } from './sessionCatalog.ts';

export function useSessionCatalog(
  active: ConnectionProfile,
  profiles: ConnectionProfile[],
  connected: boolean,
  sessions: Session[],
  live: Record<string, Pick<ClientState, 'status' | 'sessions' | 'error'>> = {},
) {
  const pending = useRef(false);
  const currentProfiles = useRef(profiles);
  currentProfiles.current = profiles;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [failure, setFailure] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const configured = profiles.filter((profile) => {
    try {
      sessionSource(profile);
      return true;
    } catch {
      return false;
    }
  });
  const source = configured.find((profile) => profile.id === active.id);
  const key = source ? sourceKey(sessionSource(source)) : '';
  const known = JSON.stringify(
    configured.map((profile) => [sourceKey(sessionSource(profile)), profile.remember]),
  );
  useEffect(() => {
    let current = true;
    const read = () =>
      void readCatalog().then(
        (value) => {
          if (current) setEntries(value);
        },
        (error) => {
          if (current) setFailure(error.message);
        },
      );
    read();
    window.addEventListener('session-catalog-changed', read);
    const channel =
      typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('cc-session-catalog');
    if (channel) channel.onmessage = read;
    return () => {
      current = false;
      window.removeEventListener('session-catalog-changed', read);
      channel?.close();
    };
  }, []);
  useEffect(() => {
    if (connected && source)
      void writeCatalog(sessionSource(source), sessions).catch((error) =>
        setFailure(error.message),
      );
  }, [connected, key, sessions]);

  async function refresh() {
    if (pending.current || !window.desktop?.profileSessions) return;
    pending.current = true;
    setRefreshing(true);
    setFailure('');
    const failed: string[] = [];
    try {
      // Reading greetings is deliberately sequential and has no device registration or quota query.
      for (const profile of configured) {
        if (
          live[profile.id]?.status === 'connected' ||
          profile.id === active.id ||
          !profile.remember ||
          !profile.token ||
          profile.mode !== 'remote'
        )
          continue;
        const started = Date.now();
        try {
          const result = await window.desktop.profileSessions(profile.id);
          if (!alive.current) return;
          if (
            !currentProfiles.current.some(
              (item) =>
                item.id === profile.id &&
                item.url === profile.url &&
                item.fingerprint === profile.fingerprint,
            )
          )
            continue;
          await writeCatalog(sessionSource(profile), result, started);
        } catch {
          failed.push(profile.name);
        }
      }
      if (alive.current && failed.length)
        setFailure(`${failed.join('、')} 暂时无法同步，保留上次会话列表。`);
    } finally {
      pending.current = false;
      if (alive.current) setRefreshing(false);
    }
  }
  useEffect(() => {
    if (connected) void refresh();
  }, [connected, key, known]);
  return {
    others: source
      ? otherSessions(
          [
            ...entries.filter((entry) => live[entry.source.id]?.status !== 'connected'),
            ...configured.flatMap((profile) =>
              live[profile.id]?.status === 'connected'
                ? [
                    {
                      source: sessionSource(profile),
                      sessions: live[profile.id]!.sessions,
                      checkedAt: Date.now(),
                      live: true,
                    },
                  ]
                : [],
            ),
          ],
          sessionSource(source),
          configured.map(sessionSource),
        )
      : [],
    refreshing,
    failure,
    refresh,
  };
}
