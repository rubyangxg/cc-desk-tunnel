import { useEffect, useState } from 'react';
import { App as Workspace } from './App.tsx';
import type { ConnectionProfile, ConnectionProfiles } from './connections.ts';
import { useAccountPool } from './useAccountPool.ts';
import type { AccountPool } from './useAccountPool.ts';
import type { Handoff } from './accountPool.ts';
import { poolCandidates } from './accountPool.ts';

const storageKey = 'proxy-connection-profiles';
function blankProfile(id: string, name: string): ConnectionProfile {
  return {
    id,
    name,
    url: id === 'default' ? (localStorage.getItem('proxy-url') ?? 'ws://127.0.0.1:8787/ws') : '',
    fingerprint: '',
    token: '',
    mode: window.desktop ? 'remote' : 'local',
    remember: false,
    autoLogin: false,
  };
}

export type ProfileControls = {
  profiles: ConnectionProfile[];
  initial: ConnectionProfile;
  autoConnect: boolean;
  save: (profile: ConnectionProfile) => Promise<void>;
  select: (id: string, connect: boolean, handoff?: Handoff) => Promise<void>;
  add: () => Promise<void>;
  remove: () => Promise<void>;
  pool: AccountPool;
  handoff: Handoff | null;
  completeHandoff: () => void;
};

// Replacing the workspace on a switch drops its client, navigation and in-memory account data together.
export function App() {
  const [collection, setCollection] = useState<ConnectionProfiles | null>(null);
  const [autoConnect, setAutoConnect] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const pool = useAccountPool(collection?.profiles ?? []);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const saved: ConnectionProfiles | null = window.desktop
          ? await window.desktop.loadProfiles()
          : JSON.parse(localStorage.getItem(storageKey) ?? 'null');
        const next = saved?.profiles.length
          ? saved
          : { profiles: [blankProfile('default', '默认账号')], activeId: 'default' };
        if (window.desktop && !window.desktop.dev)
          next.profiles = next.profiles.map((profile) => ({ ...profile, mode: 'remote' }));
        const auto =
          next.profiles.find((profile) => profile.id === next.activeId)?.autoLogin ?? false;
        let shouldConnect = auto;
        if (auto && pool.config.enabled) {
          const quotas = await pool.refresh(next.profiles);
          const preferred = poolCandidates(next.profiles, quotas, pool.config)[0];
          shouldConnect = !!preferred;
          if (preferred) {
            next.activeId = preferred.id;
            await window.desktop?.saveProfiles(next);
          }
        }
        if (cancelled) return;
        setCollection(next);
        setAutoConnect(shouldConnect);
      } catch {
        if (!cancelled) setError('账号配置读取失败，请重启客户端后重试。');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!collection)
    return (
      <main className="login-page">
        <p role={error ? 'alert' : 'status'}>{error ?? '读取账号配置…'}</p>
      </main>
    );
  const initial =
    collection.profiles.find((profile) => profile.id === collection.activeId) ??
    collection.profiles[0]!;
  async function persist(next: ConnectionProfiles) {
    if (window.desktop) await window.desktop.saveProfiles(next);
    // Browser simulation saves addresses and labels only. Tokens never enter browser storage.
    const retained = {
      ...next,
      profiles: next.profiles.map((profile) =>
        window.desktop && profile.remember
          ? profile
          : { ...profile, token: '', remember: false, autoLogin: false },
      ),
    };
    if (!window.desktop) localStorage.setItem(storageKey, JSON.stringify(retained));
    setCollection(retained);
  }
  const controls: ProfileControls = {
    profiles: collection.profiles,
    initial,
    autoConnect,
    pool,
    handoff,
    completeHandoff: () => setHandoff(null),
    save: async (profile) => {
      await persist({
        ...collection,
        profiles: collection.profiles.map((item) => (item.id === profile.id ? profile : item)),
      });
    },
    select: async (id, connect, nextHandoff) => {
      await persist({ ...collection, activeId: id });
      setAutoConnect(connect);
      setHandoff(nextHandoff ?? null);
    },
    add: async () => {
      const profile = blankProfile(crypto.randomUUID(), `账号 ${collection.profiles.length + 1}`);
      await persist({ profiles: [...collection.profiles, profile], activeId: profile.id });
      setAutoConnect(false);
      setHandoff(null);
    },
    remove: async () => {
      const profiles = collection.profiles.filter((profile) => profile.id !== initial.id);
      await persist({ profiles, activeId: profiles[0]!.id });
      setAutoConnect(false);
      setHandoff(null);
    },
  };
  return <Workspace key={initial.id} profiles={controls} />;
}
