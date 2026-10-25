import { useEffect, useRef, useState } from 'react';
import { WorkspaceVisible } from './ui.tsx';
import { App as Workspace } from './App.tsx';
import type { ConnectionProfile, ConnectionProfiles } from './connections.ts';
import { useAccountPool } from './useAccountPool.ts';
import type { AccountPool } from './useAccountPool.ts';
import type { Handoff } from './accountPool.ts';
import type { ClientState } from './client.ts';
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

function connectionPeer(profile: ConnectionProfile) {
  if (profile.mode !== 'remote' || !profile.token) return null;
  try {
    return JSON.stringify([
      new URL(profile.url).href,
      profile.fingerprint.replaceAll(':', '').toLowerCase(),
      profile.token,
    ]);
  } catch {
    return null;
  }
}

export type ProfileControls = {
  profiles: ConnectionProfile[];
  initial: ConnectionProfile;
  autoConnect: boolean;
  connectRequest?: number;
  persistent?: boolean;
  managing?: boolean;
  completeManagement?: () => void;
  background?: boolean;
  live?: Record<string, Pick<ClientState, 'status' | 'sessions' | 'error'>>;
  report?: (state: Pick<ClientState, 'status' | 'sessions' | 'error'>) => void;
  save: (profile: ConnectionProfile) => Promise<void>;
  select: (
    id: string,
    connect: boolean,
    handoff?: Handoff,
    sessionId?: string,
    accountPage?: boolean,
  ) => Promise<void>;
  focusSession: string | null;
  focusAccount: boolean;
  completeAccountFocus: () => void;
  completeFocus: () => void;
  add: () => Promise<void>;
  remove: () => Promise<void>;
  pool: AccountPool;
  handoff: Handoff | null;
  completeHandoff: () => void;
};

// Workspaces remain mounted: each service retains its socket, SSH execution channel and history.
export function App() {
  const [collection, setCollection] = useState<ConnectionProfiles | null>(null);
  const latest = useRef<ConnectionProfiles | null>(null);
  const writes = useRef(Promise.resolve());
  type View = {
    connect: boolean;
    attempt: number;
    handoff: Handoff | null;
    sessionId: string | null;
    account: boolean;
    managing: boolean;
  };
  const emptyView = (connect = false): View => ({
    connect,
    attempt: 0,
    handoff: null,
    sessionId: null,
    account: false,
    managing: false,
  });
  const [views, setViews] = useState<Record<string, View>>({});
  const viewsRef = useRef(views);
  viewsRef.current = views;
  type Live = Pick<ClientState, 'status' | 'sessions' | 'error'>;
  const [live, setLive] = useState<Record<string, Live>>({});
  const liveRef = useRef(live);
  liveRef.current = live;
  const [opening, setOpening] = useState<string | null>(null);
  const openingRef = useRef<string | null>(null);
  const [openError, setOpenError] = useState('');
  const [activated, setActivated] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
          : { profiles: [blankProfile('default', '默认代理服务')], activeId: 'default' };
        if (window.desktop && !window.desktop.dev)
          next.profiles = next.profiles.map((profile) => ({ ...profile, mode: 'remote' }));
        const auto = next.profiles.some(
          (profile) => profile.autoLogin && profile.remember && !!profile.token,
        );
        if (auto && pool.config.enabled) {
          const quotas = await pool.refresh(next.profiles);
          const preferred = poolCandidates(next.profiles, quotas, pool.config)[0];
          if (preferred) next.activeId = preferred.id;
        }
        if (cancelled) return;
        latest.current = next;
        setCollection(next);
        setViews({ [next.activeId]: emptyView(auto) });
        setActivated(auto);
      } catch {
        if (!cancelled) setError('代理服务配置读取失败，请重启客户端后重试。');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!activated || !collection || !window.desktop) return;
    setViews((current) => {
      const next = { ...current };
      const peers = new Set(
        collection.profiles.filter((profile) => next[profile.id]).map(connectionPeer),
      );
      for (const profile of collection.profiles)
        if (
          !next[profile.id] &&
          profile.mode === 'remote' &&
          profile.remember &&
          profile.token &&
          !peers.has(connectionPeer(profile))
        ) {
          next[profile.id] = emptyView(true);
          peers.add(connectionPeer(profile));
        }
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, [activated, collection]);
  // Background sockets save concurrently. Serialize writes against the latest collection.
  function persist(change: (value: ConnectionProfiles) => ConnectionProfiles) {
    const result = writes.current.then(async () => {
      const next = change(latest.current!);
      if (window.desktop) await window.desktop.saveProfiles(next);
      const retained = {
        ...next,
        profiles: next.profiles.map((profile) =>
          window.desktop && profile.remember
            ? profile
            : { ...profile, token: '', remember: false, autoLogin: false },
        ),
      };
      if (!window.desktop) localStorage.setItem(storageKey, JSON.stringify(retained));
      latest.current = retained;
      setCollection(retained);
    });
    writes.current = result.catch(() => {});
    return result;
  }
  if (!collection)
    return (
      <main className="login-page">
        <p role={error ? 'alert' : 'status'}>{error ?? '读取代理服务配置…'}</p>
      </main>
    );
  function changeView(id: string, values: Partial<View>) {
    const next = {
      ...viewsRef.current,
      [id]: { ...(viewsRef.current[id] ?? emptyView()), ...values },
    };
    viewsRef.current = next;
    setViews(next);
  }
  return (
    <>
      {(opening || openError) && (
        <div className="service-opening" role={openError ? 'alert' : 'status'}>
          {openError || '正在打开会话…'}
          <button
            className="button secondary"
            onClick={() => {
              openingRef.current = null;
              setOpening(null);
              setOpenError('');
            }}
          >
            取消
          </button>
        </div>
      )}
      {collection.profiles
        .filter((profile) => views[profile.id] || profile.id === collection.activeId)
        .map((initial) => {
          const view = views[initial.id] ?? emptyView();
          const foreground = initial.id === collection.activeId;
          const controls: ProfileControls = {
            profiles: collection.profiles,
            initial,
            autoConnect: view.connect,
            connectRequest: view.attempt,
            persistent: true,
            managing: view.managing,
            completeManagement: () => changeView(initial.id, { managing: false }),
            background: !foreground,
            live,
            report: (value) => {
              setLive((current) =>
                current[initial.id]?.status === value.status &&
                current[initial.id]?.sessions === value.sessions &&
                current[initial.id]?.error === value.error
                  ? current
                  : { ...current, [initial.id]: value },
              );
              if (openingRef.current !== initial.id) return;
              if (value.status === 'connected' || value.status === 'reconnecting') {
                openingRef.current = null;
                setOpening(null);
                void persist((current) => ({ ...current, activeId: initial.id })).catch((error) =>
                  setOpenError(error.message),
                );
              } else if (value.status === 'disconnected' && value.error) {
                openingRef.current = null;
                setOpening(null);
                setOpenError('暂时无法打开会话，原任务仍在运行。请稍后重试。');
              }
            },
            pool,
            handoff: view.handoff,
            focusSession: view.sessionId,
            focusAccount: view.account,
            completeAccountFocus: () => changeView(initial.id, { account: false }),
            completeFocus: () => changeView(initial.id, { sessionId: null }),
            completeHandoff: () => changeView(initial.id, { handoff: null }),
            save: async (profile) => {
              await persist((value) => ({
                ...value,
                profiles: value.profiles.map((item) => (item.id === profile.id ? profile : item)),
              }));
              if (profile.token) setActivated(true);
            },
            select: async (id, connect, handoff, sessionId, account) => {
              const requested = latest.current?.profiles.find((profile) => profile.id === id);
              if (requested && connect) {
                const peer = connectionPeer(requested);
                const warm = latest.current?.profiles.find(
                  (profile) =>
                    viewsRef.current[profile.id] &&
                    peer !== null &&
                    connectionPeer(profile) === peer,
                );
                if (warm) id = warm.id;
              }
              if (handoff && viewsRef.current[id]?.handoff)
                throw new Error('已有续接正在处理，请稍后重试。');
              // Navigation waits in the existing workspace until the destination is ready.
              // Background handoffs never steal the foreground conversation.
              if (!handoff || latest.current?.activeId === initial.id) {
                openingRef.current = null;
                setOpening(null);
                setOpenError('');
                if (
                  connect &&
                  !!requested?.token &&
                  liveRef.current[id]?.status !== 'connected' &&
                  liveRef.current[id]?.status !== 'reconnecting'
                ) {
                  openingRef.current = id;
                  setOpening(id);
                } else await persist((value) => ({ ...value, activeId: id }));
              }
              changeView(id, {
                connect,
                attempt: (viewsRef.current[id]?.attempt ?? 0) + 1,
                handoff: handoff ?? null,
                sessionId: sessionId ?? null,
                account: account ?? false,
                managing: !connect && !sessionId,
              });
              if (connect) setActivated(true);
            },
            add: async () => {
              const profile = blankProfile(
                crypto.randomUUID(),
                `代理服务 ${collection.profiles.length + 1}`,
              );
              await persist((value) => ({
                profiles: [...value.profiles, profile],
                activeId: profile.id,
              }));
              changeView(profile.id, emptyView());
            },
            remove: async () => {
              await persist((value) => {
                const profiles = value.profiles.filter((profile) => profile.id !== initial.id);
                return { profiles, activeId: profiles[0]!.id };
              });
              await window.desktop?.disconnectProxy(initial.id);
              setViews((current) => {
                const next = { ...current };
                delete next[initial.id];
                return next;
              });
            },
          };
          return (
            <div
              key={initial.id}
              hidden={!foreground}
              inert={!foreground}
              className="service-workspace"
              data-service={initial.id}
            >
              <WorkspaceVisible.Provider value={foreground}>
                <Workspace profiles={controls} />
              </WorkspaceVisible.Provider>
            </div>
          );
        })}
    </>
  );
}

// Browser sessions stay on their authenticated origin; desktop profiles are never loaded here.
export function BrowserApp({
  browser,
}: {
  browser: { selfSigned: boolean; expired: () => void; logout: () => Promise<void> };
}) {
  const pool = useAccountPool([]);
  const [initial] = useState<ConnectionProfile>(() => ({
    id: 'browser',
    name: '当前服务',
    url: '',
    token: '',
    fingerprint: '',
    mode: 'local',
    remember: false,
    autoLogin: false,
  }));
  const unavailable = async () => {
    throw new Error('请在桌面客户端管理代理服务。');
  };
  const profiles: ProfileControls = {
    profiles: [],
    initial,
    autoConnect: false,
    pool: { ...pool, config: { ...pool.config, enabled: false } },
    handoff: null,
    focusSession: null,
    focusAccount: false,
    completeFocus: () => {},
    completeAccountFocus: () => {},
    completeHandoff: () => {},
    save: async () => {},
    select: unavailable,
    add: unavailable,
    remove: unavailable,
  };
  return <Workspace profiles={profiles} browser={browser} />;
}
