import { useHistoryCache } from './historyCache.ts';
import { RequestRejectedError } from './client.ts';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  CircleHelp,
  Download,
  FileDown,
  FolderInput,
  FolderOpen,
  FolderSymlink,
  GitFork,
  Laptop,
  LogOut,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  ScrollText,
  Settings,
  SquareTerminal,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import { GithubMark, openProject, project } from './project.tsx';
import type {
  Effort,
  EventPayload,
  PermissionMode,
  Session,
  SessionEvent,
} from '@cc-desk-tunnel/protocol';
import { browserSession, browserSocket, watchActivity } from './browser-api.ts';
import { CertificateWarning } from './WebGate.tsx';
import { hostCapabilities } from './host-capabilities.ts';
import AccountPanel from './AccountPanel.tsx';
import UnifiedAccountPool from './UnifiedAccountPool.tsx';
import { ProxyClient, RequestInterruptedError } from './client.ts';
import Composer from './Composer.tsx';
import SessionBar from './SessionBar.tsx';
import { isHere, thisDevice } from './device.ts';
import { isMac, selfUpdating } from './platform.ts';
import { useDrafts } from './drafts.ts';
import SchedulePanel from './SchedulePanel.tsx';
import { taskMessage, useSchedules } from './schedules.ts';
import type { Scenario } from './Composer.tsx';
import Conversation from './Conversation.tsx';
import ReconnectNotice from './ReconnectNotice.tsx';
import LoginPage from './LoginPage.tsx';
import type { ConnectionForm } from './LoginPage.tsx';
import type { ProfileControls } from './Connections.tsx';
import { validateConnection } from './connections.ts';
import { loadProjects, saveProjects } from './projects.ts';
import type { ConnectionProfile } from './connections.ts';
import AccountPoolPanel from './AccountPoolPanel.tsx';
import { usePoolRotation } from './usePoolRotation.ts';
import { exportSession } from './exportSession.ts';
import { historyKey, joinedHistory, sharedHistory } from './sharedHistory.ts';
import type { SharedHistory } from './sharedHistory.ts';
import { onSharedChange, saveShared, shared, useShared } from './shared.ts';
import { useNotifications } from './notifications.ts';
import { folderName, isInside, isNewer, pathKey, withProject } from './paths.ts';
import { getPrefs, setPrefs, toggled, usePrefs } from './prefs.ts';
import { actions, comboOf, keyFor, show as comboText } from './shortcuts.ts';
import type { Action } from './shortcuts.ts';
import Rail from './Rail.tsx';
import type { Page } from './Rail.tsx';
import {
  AddProjectDialog,
  DeleteSessionDialog,
  RenameProjectDialog,
  RenameSessionDialog,
} from './SessionDialogs.tsx';
import SettingsPage from './SettingsPage.tsx';
import type { Section } from './SettingsPage.tsx';
import Sidebar from './Sidebar.tsx';
import { useSessionCatalog } from './useSessionCatalog.ts';
import TitleBar from './TitleBar.tsx';
import type { BarMenu } from './TitleBar.tsx';
import { IconButton, Menu } from './ui.tsx';
import type { MenuItem, MenuPosition } from './ui.tsx';

const NativeTerminal = lazy(() => import('./NativeTerminal.tsx'));
// The notes of every version so far are read only when asked for, and stay out of what the window starts with.
const ReleaseNotes = lazy(() => import('./ReleaseNotes.tsx'));

// The newest event of a kind is the session's current native state.
function latest<T extends EventPayload['type']>(events: SessionEvent[], type: T) {
  return (events.findLast((event) => event.payload.type === type)?.payload ?? null) as Extract<
    EventPayload,
    { type: T }
  > | null;
}
// Where the window is: a page, the settings section when that page is open, and the session being read.
type Place = { page: Page; section: Section; sessionId: string | null };
// Which menu is open. Its items are built while rendering, so they follow the state as it changes.
type OpenMenu = MenuPosition &
  (
    | { kind: 'session'; sessionId: string }
    | { kind: 'project'; path: string }
    | { kind: 'move'; sessionId: string }
    | { kind: 'settings' }
    | { kind: 'update' }
    | { kind: 'bar'; label: string }
  );
const narrow = () => matchMedia('(max-width: 700px)').matches;
// Prefer the computer-wide list, retaining migration of all legacy service profiles.
function savedProjects(value: unknown = shared('projects')): string[] {
  return loadProjects(localStorage, value);
}

// Owns the connection, the selection and every request; the components below render and report user intent.
export function App({
  profiles,
  browser,
}: {
  profiles: ProfileControls;
  browser?: { selfSigned: boolean; expired: () => void; logout: () => Promise<void> };
}) {
  const profileId = profiles.initial.id;
  const foreground = !profiles.background;
  const host = hostCapabilities(!!browser);
  const [client] = useState(() => new ProxyClient());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!browser) return;
    client.connectBrowser(
      browserSocket(),
      browser.expired,
      async () => (await browserSession()).authenticated,
    );
    return () => client.disconnect();
  }, [client, browser?.expired]);
  const inBrowser = !!browser;
  useEffect(
    () => (inBrowser ? watchActivity(() => client.markActive()) : undefined),
    [client, inBrowser],
  );
  const [clock] = useState(() => ({ now: client.serviceNow, activityAt: client.activityAt }));
  // The version whose notes are shown, over whichever page is up.
  const [notes, setNotes] = useState<string | null>(null);
  const notesDialog = notes && (
    <Suspense fallback={null}>
      <ReleaseNotes version={notes} onClose={() => setNotes(null)} />
    </Suspense>
  );
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
  useEffect(() => {
    profiles.report?.({ status: state.status, sessions: state.sessions, error: state.error });
  }, [state.status, state.sessions, state.error]);
  const serverPool = !browser && state.features.includes('account-pool');
  const [form, setForm] = useState<ConnectionProfile>(profiles.initial);
  useHistoryCache(client, form, !browser);
  const [profileNotice, setProfileNotice] = useState<string | null>(null);
  const changeForm = useCallback(
    (values: Partial<ConnectionForm>) => setForm((current) => ({ ...current, ...values })),
    [],
  );
  const [proxyConnecting, setProxyConnecting] = useState(false);
  const [error, setError] = useState<string | RequestInterruptedError | null>(null);
  // One request at a time from this window; `refreshing` is the slower native status read.
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [findRequest, setFindRequest] = useState(0);
  // Which of this computer's settings is open on the login page.
  const [localSettings, setLocalSettings] = useState<Section | null>(null);
  useEffect(() => {
    if (state.status !== 'disconnected' && state.status !== 'connecting') setLocalSettings(null);
  }, [state.status]);
  const refreshed = useRef(new Set<string>());
  const [projects, setProjects] = useState(() => savedProjects());
  // The folders that hold sessions without a project; new ones are made in the first.
  const [workspaceRoots, setWorkspaceRoots] = useState<string[]>([]);
  const [drafts, setDraft] = useDrafts(profileId);
  const [scenario, setScenario] = useState<Scenario>('chat');
  const [slashOpen, setSlashOpen] = useState(false);
  // The side column is shown beside the page on a wide window and laid over it on a narrow one.
  const [sideOpen, setSideOpen] = useState(() => !narrow());
  const closeSide = useCallback(() => {
    if (narrow()) setSideOpen(false);
  }, []);
  // Crossing between the two layouts starts from each one's usual state.
  useEffect(() => {
    const query = matchMedia('(max-width: 700px)');
    const follow = () => setSideOpen(!query.matches);
    query.addEventListener('change', follow);
    return () => query.removeEventListener('change', follow);
  }, []);
  const [place, setPlace] = useState<Place>({
    page: 'chat',
    section: browser ? 'general' : 'account',
    sessionId: null,
  });
  // Places visited, for the title bar's way back and forward.
  const trail = useRef<{ places: Place[]; at: number }>({ places: [place], at: 0 });
  const [, setTrailAt] = useState(0);
  const accountOpen = place.page === 'settings' && place.section === 'account';
  const prefs = usePrefs();
  const [version, setVersion] = useState('');
  useEffect(() => {
    void window.desktop?.version().then(setVersion);
  }, []);
  const [terminalSessionId, setTerminalSessionId] = useState<string | null>(null);
  const closeTerminal = useCallback(() => setTerminalSessionId(null), []);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteSession, setDeleteSession] = useState<Session | null>(null);
  const [renameSession, setRenameSession] = useState<Session | null>(null);
  const [renameProject, setRenameProject] = useState<string | null>(null);
  const [repointProject, setRepointProject] = useState<string | null>(null);
  useEffect(() => {
    if (foreground) return;
    setMenu(null);
    setNotes(null);
    setCreateOpen(false);
    setDeleteSession(null);
    setRenameSession(null);
    setRenameProject(null);
    setRepointProject(null);
  }, [foreground]);

  const nativeMode = state.adapter === 'claude-code';
  const connected = state.status === 'connected';
  const selfSigned = !!browser && (state.browser?.selfSigned ?? browser.selfSigned);
  const othersBusy = useShared('busy');
  const selected = state.sessions.find((session) => session.id === state.selectedId);
  // What is listed and managed here is what is on this computer. Sessions on the user's other computers are
  // shown apart: they can be read, worked on from here while their computer is connected, and taken over or
  // forked into a directory here.
  // Sessions from before computers were told apart name none, and would be listed on every one of the user's
  // computers. Their folders are looked for here; a session whose folder is not here goes with the other
  // computers' sessions, from where it can be taken over like any of them.
  const [absent, setAbsent] = useState<ReadonlySet<string>>(new Set());
  const unplaced = JSON.stringify(
    [
      ...new Set(
        state.sessions.filter((session) => !session.device).map((session) => session.projectPath),
      ),
    ].sort(),
  );
  useEffect(() => {
    const folders: string[] = JSON.parse(unplaced);
    if (!window.desktop || !folders.length) return;
    let current = true;
    void window.desktop.foldersExist(folders).then((found) => {
      if (current) setAbsent(new Set(folders.filter((_, index) => !found[index]).map(pathKey)));
    });
    return () => {
      current = false;
    };
  }, [unplaced]);
  const catalog = useSessionCatalog(
    form,
    profiles.profiles,
    connected,
    state.sessions,
    profiles.live,
  );
  const catalogRows = new Map(catalog.others.map((item) => [item.display.id, item]));
  const onThis = (session: Session) => !browser && isHere(session, state.device, absent);
  const sessions = state.sessions.filter((session) => onThis(session));
  const elsewhere = state.sessions.filter((session) => !onThis(session));
  const away = !!selected && !onThis(selected);
  // Another computer's session is worked on from here while that computer is connected and its commands
  // reach it: what is sent here runs there, as if sent there.
  const reachable = (session: Session) =>
    state.devices.some((device) => device.id === session.device?.id && device.ready);
  const remote = away && reachable(selected);
  // Two connections may have Claude working in one folder at once, each unaware of the other. A window tells
  // the others what it has running, and says so when another's session works where the shown one does. A
  // session this window lists too is the same service's and no other.
  const running = JSON.stringify(
    connected
      ? sessions
          .filter((session) => session.activeRun)
          .map((session) => ({ id: session.id, folder: session.projectPath }))
      : [],
  );
  useEffect(() => {
    void window.desktop?.setBusy(JSON.parse(running), profileId);
  }, [running]);
  const overlaps = (one: string, other: string) =>
    pathKey(one) === pathKey(other) || isInside(one, [other]) || isInside(other, [one]);
  const beside =
    selected && !away
      ? [
          ...othersBusy
            .filter((entry) =>
              entry.runs.some(
                (run) =>
                  !state.sessions.some((session) => session.id === run.id) &&
                  overlaps(run.folder, selected.projectPath),
              ),
            )
            .map((entry) => `“${entry.name}”`),
          ...profiles.profiles
            .filter(
              (profile) =>
                profile.id !== profileId &&
                profiles.live?.[profile.id]?.sessions.some(
                  (session) =>
                    session.activeRun &&
                    isHere(session, state.device) &&
                    overlaps(session.projectPath, selected.projectPath),
                ),
            )
            .map((profile) => `“${profile.name}”`),
        ]
      : [];
  const recorded = selected ? state.events[selected.id] : undefined;
  const unfinished = selected ? state.live[selected.id] : undefined;
  const events = useMemo(
    () => (selected ? client.shown(selected.id) : []),
    // What is shown changes with these two.
    [selected?.id, recorded, unfinished],
  );
  const [archive, setArchive] = useState<{ key: string; value: SharedHistory | null } | null>(null);
  const archiveKey = selected ? historyKey(profiles.initial, selected.id) : '';
  useEffect(() => {
    let active = true;
    const load = () => {
      if (!archiveKey) return;
      void sharedHistory(archiveKey).then(
        (value) => {
          if (active) setArchive({ key: archiveKey, value });
        },
        (error: Error) => {
          if (active) setError(error.message);
        },
      );
    };
    load();
    window.addEventListener('shared-history-changed', load);
    const channel =
      typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('cc-shared-history');
    if (channel) channel.onmessage = load;
    return () => {
      active = false;
      window.removeEventListener('shared-history-changed', load);
      channel?.close();
    };
  }, [archiveKey]);
  const linkedHistory = archive?.key === archiveKey ? archive.value : null;
  const visibleEvents = useMemo(
    () => joinedHistory(linkedHistory, events),
    [linkedHistory, events],
  );
  const history = selected ? state.history[selected.id] : undefined;
  const nativeSession = latest(events, 'native.session');
  // Each turn's report is a reason to ask for the session's figures again.
  const turnReports = useMemo(
    () => events.filter((event) => event.payload.type === 'turn.stats').length,
    [events],
  );
  const capabilities = latest(events, 'native.capabilities') ?? state.capabilities;
  const metrics = latest(events, 'native.metrics');
  // Quota belongs to the account, so the newest reading from any session wins over the selected session's.
  const quota = [metrics, state.metrics]
    .filter((item) => !!item?.rateLimits)
    .sort((a, b) =>
      (b!.rateLimits!.measuredAt ?? '').localeCompare(a!.rateLimits!.measuredAt ?? ''),
    )[0];
  const accountMetrics =
    (metrics ?? state.metrics) && quota
      ? { ...(metrics ?? state.metrics)!, rateLimits: quota.rateLimits }
      : (metrics ?? state.metrics);
  const rotation = usePoolRotation({
    client,
    profiles,
    busy: busy || refreshing,
    terminalOpen: !!terminalSessionId,
    close: async () => {
      if (profiles.persistent) return;
      signedIn.current = false;
      client.disconnect();
      await window.desktop?.disconnectProxy(profileId);
    },
    show: (id) => show(id),
    draft: setDraft,
    error: setError,
  });
  useEffect(() => {
    if (connected && profiles.focusSession) {
      if (state.sessions.some((session) => session.id === profiles.focusSession))
        show(profiles.focusSession);
      else setError('来源服务器已没有这条会话，请刷新会话列表。');
      profiles.completeFocus();
    }
  }, [connected, profiles.focusSession, state.sessions]);
  useEffect(() => {
    if (connected && profiles.focusAccount) {
      open('settings', 'account');
      profiles.completeAccountFocus();
    }
  }, [connected, profiles.focusAccount]);
  const canCompact = !!latest(events, 'native.context')?.persisted;
  // A native terminal anywhere keeps what the CLI holds for all sessions, the account and its status, from
  // being read or changed; this window's own terminal, `terminalSessionId`, also takes the window.
  const anyTerminal = state.sessions.some((session) => session.activeRun?.surface === 'terminal');
  const controlsDisabled =
    (!!selected && archive?.key !== archiveKey) ||
    !!linkedHistory?.forward ||
    !connected ||
    rotation.working ||
    busy ||
    refreshing ||
    !!selected?.activeRun ||
    !!history?.loading ||
    !!terminalSessionId;
  // A run is that of the computer its session is on, whichever window of whichever computer started it; any
  // of them answers and stops it while that computer can be reached.
  const ownsRun = !!selected?.activeRun && (!away || remote);
  const queueEnabled = state.features.includes('message-queue');
  const sendMode = queueEnabled ? prefs.sendMode : 'direct';
  // A native run accepts follow-up messages from wherever it can be worked on.
  const inputDisabled =
    (!!selected && archive?.key !== archiveKey) ||
    !!linkedHistory?.forward ||
    !connected ||
    rotation.working ||
    busy ||
    !!history?.loading ||
    (!!selected?.activeRun && ((!nativeMode && !queueEnabled) || !ownsRun)) ||
    refreshing;
  const draft = selected ? (drafts[selected.id] ?? '') : '';
  // The last turn of the session did not reach its end: it can be taken up again from the message box.
  const lastStatus = selected
    ? state.events[selected.id]?.findLast((event) => event.payload.type === 'run.status')?.payload
    : undefined;
  const stopped =
    !!selected &&
    !selected.activeRun &&
    (!away || remote) &&
    lastStatus?.type === 'run.status' &&
    lastStatus.surface !== 'terminal' &&
    (lastStatus.status === 'cancelled' || lastStatus.status === 'failed');
  const signedOut = !serverPool && state.account?.loggedIn === false;
  const actionError = error instanceof RequestInterruptedError ? error.describe(connected) : error;
  const currentError = actionError ?? state.error;
  // Offered when the service holds a newer installer than the running client.
  const upgrade =
    selfUpdating && version && state.release && isNewer(state.release, version)
      ? state.release
      : null;
  // The service refused this client as the older one: its version can also be fetched from the release page,
  // whether or not the service holds the installer.
  const direct =
    selfUpdating &&
    state.mismatch &&
    window.desktop &&
    version &&
    state.service &&
    isNewer(state.service, version)
      ? state.service
      : null;
  // A service of a newer version: what that version changed can be read here, whether or not this system's
  // client upgrades itself.
  const ahead =
    state.mismatch && version && state.service && isNewer(state.service, version)
      ? state.service
      : null;
  // How far an installer being fetched from the release page is, from 0 to 1.
  const [downloaded, setDownloaded] = useState<number | null>(null);
  useEffect(
    () =>
      window.desktop?.onUpdateProgress(({ received, size }) =>
        setDownloaded(size ? received / size : 0),
      ),
    [],
  );
  const install = (version?: string) => {
    void act(async () => {
      try {
        await window.desktop!.installUpdate(version, profileId);
      } finally {
        setDownloaded(null);
      }
    });
  };

  // A check or an upgrade of the service that failed says why.
  const update = state.update;
  useEffect(() => {
    if (update?.state === 'failed' && update.detail) setError(update.detail);
  }, [update]);
  const serviceUpdate = !nativeMode
    ? null
    : update?.state === 'available'
      ? {
          label: `升级服务端到 ${update.latest}`,
          icon: <Download />,
          disabled: busy || state.sessions.some((item) => !!item.activeRun),
          run: () => {
            if (
              window.confirm(
                `服务端将升级到 ${update.latest} 并重启，需要几分钟，期间不能发送消息；客户端会自动重连并同步会话。继续？`,
              )
            )
              void act(async () => {
                await client.request({ type: 'service.update.install', version: update.latest! });
              });
          },
        }
      : update?.state === 'manual'
        ? {
            label: `服务端 ${update.latest} 需在服务器上升级`,
            icon: <Download />,
            disabled: true,
            run: () => undefined,
          }
        : update?.state === 'installing' || update?.state === 'restarting'
          ? {
              label: `服务端升级中：${update.detail ?? '重启'}`,
              icon: <RefreshCw />,
              disabled: true,
              run: () => undefined,
            }
          : {
              label:
                update?.state === 'checking'
                  ? '正在检查更新…'
                  : update?.state === 'idle' && update.checkedAt
                    ? `已是最新 ${state.service} · 再次检查`
                    : '检查更新',
              icon: <RefreshCw />,
              disabled: busy || update?.state === 'checking',
              run: () => {
                void act(async () => {
                  await client.request({ type: 'service.update.check' });
                });
              },
            };

  // A selected saved account connects once; a missing token leaves its form ready to fill.
  const loaded = useRef(false);
  useEffect(() => {
    if (!profiles.autoConnect) {
      loaded.current = false;
      return;
    }
    if (
      client.state.status !== 'disconnected' ||
      (loaded.current && !profiles.focusSession && !profiles.connectRequest)
    )
      return;
    loaded.current = true;
    if (form.token) void login(form);
  }, [profiles.autoConnect, profiles.focusSession, profiles.connectRequest]);
  useEffect(() => {
    if (connected) void profiles.save(form).catch((error: Error) => setError(error.message));
  }, [connected, form.remember, form.autoLogin]);
  useEffect(() => {
    const close = () => client.disconnect();
    // The system says the network is back: the attempt that was waiting for its turn is made now.
    const retry = () => client.retryNow();
    window.addEventListener('beforeunload', close);
    window.addEventListener('online', retry);
    return () => {
      window.removeEventListener('beforeunload', close);
      window.removeEventListener('online', retry);
      const active = client.state.status !== 'disconnected';
      client.disconnect();
      if (active) void window.desktop?.disconnectProxy(profileId);
      void window.desktop?.setBusy([], profileId);
    };
  }, [client, changeForm]);
  // A connection that breaks is made again by the client, and the window stays where it is. It comes back to
  // the sign-in page only when the connection is over for good: ended here, or refused by the service.
  const signedIn = useRef(false);
  useEffect(() => {
    if (state.status === 'connected' || state.status === 'reconnecting') {
      signedIn.current = true;
      return;
    }
    if (state.status !== 'disconnected' || !signedIn.current) return;
    signedIn.current = false;
    void window.desktop?.disconnectProxy(profileId);
    setForm((current) => (current.remember ? current : { ...current, token: '' }));
    if (client.state.error)
      notifications.push({
        kind: 'connection',
        title: '连接中断',
        body: client.state.error.split('\n')[0],
      });
  }, [state.status]);
  useEffect(() => {
    if (!connected) {
      setTerminalSessionId(null);
      setMenu(null);
    }
  }, [connected]);
  useEffect(() => {
    if (connected) void window.desktop?.workspaceRoots().then(setWorkspaceRoots);
  }, [connected]);
  useEffect(() => {
    saveProjects(localStorage, projects);
    saveShared('projects', projects);
  }, [projects]);
  useEffect(
    () =>
      onSharedChange('projects', (value) => {
        const next = savedProjects(value);
        setProjects((current) =>
          JSON.stringify(current) === JSON.stringify(next) ? current : next,
        );
      }),
    [],
  );
  // Each session's native state is read once when it is first shown idle.
  useEffect(() => {
    if (
      !nativeMode ||
      !selected ||
      !connected ||
      history?.loading ||
      selected.activeRun ||
      anyTerminal ||
      rotation.working ||
      refreshed.current.has(selected.id)
    )
      return;
    refreshed.current.add(selected.id);
    void refreshStatus(selected.id);
  }, [
    nativeMode,
    selected?.id,
    connected,
    history?.loading,
    selected?.activeRun,
    anyTerminal,
    rotation.working,
  ]);
  useEffect(() => {
    if (nativeMode && connected)
      void client.request({ type: serverPool ? 'pool.status' : 'account.status' }).catch(() => {});
  }, [nativeMode, connected, accountOpen, serverPool]);
  useEffect(() => {
    if (
      !accountOpen ||
      !nativeMode ||
      !connected ||
      state.capabilities ||
      state.account?.loggedIn !== true ||
      refreshing ||
      rotation.working ||
      state.sessions.some((session) => session.activeRun)
    )
      return;
    void refreshStatus();
  }, [
    accountOpen,
    nativeMode,
    connected,
    state.capabilities,
    state.account?.loggedIn,
    rotation.working,
  ]);

  async function act(action: () => Promise<void>) {
    setError(null);
    setBusy(true);
    try {
      await action();
    } catch (error) {
      setError(
        error instanceof RequestInterruptedError
          ? error
          : error instanceof Error
            ? error.message
            : '操作失败。',
      );
    } finally {
      setBusy(false);
    }
  }
  // Remote mode connects through the main process, which opens the tunnel and returns a loopback address.
  async function login(form: ConnectionProfile) {
    setError(null);
    try {
      if (!form.name.trim()) throw new Error('请输入服务名称。');
      validateConnection(form);
      profiles.completeManagement?.();
      const device = await thisDevice();
      if (!mounted.current) return;
      if (form.mode === 'remote') {
        setProxyConnecting(true);
        // The address here only has to be a loopback one; each attempt gets its own from the bridge it opens.
        client.connect(
          'ws://127.0.0.1/ws',
          form.token,
          device,
          true,
          async () =>
            (
              await window.desktop!.connectProxy({
                profileId,
                url: form.url,
                fingerprint: form.fingerprint,
                waits: getPrefs().connection,
              })
            ).url,
        );
      } else {
        client.connect(form.url, form.token, device);
      }
      localStorage.setItem('proxy-url', form.url);
    } catch (error) {
      if (form.mode === 'remote') await window.desktop?.disconnectProxy(profileId);
      setError(error instanceof Error ? error.message : '连接失败。');
    } finally {
      setProxyConnecting(false);
    }
  }
  function stopRun() {
    if (!selected?.activeRun) return;
    const { id: sessionId, activeRun } = selected;
    void act(async () => {
      await client.request({ type: 'run.cancel', sessionId, runId: activeRun.id });
    });
  }
  function disconnect() {
    if (browser) {
      void act(browser.logout);
      return;
    }
    client.disconnect();
    setForm((current) => (current.remember ? current : { ...current, token: '' }));
    void window.desktop?.disconnectProxy(profileId);
  }
  async function switchProfile(
    id: string,
    connect: boolean,
    sessionId?: string,
    accountPage = false,
  ) {
    if (id === profileId) {
      if (sessionId) show(sessionId);
      return;
    }
    await act(async () => {
      if (!profiles.persistent) {
        if (!confirmSwitch()) return;
        signedIn.current = false;
        client.disconnect();
        await window.desktop?.disconnectProxy(profileId);
      }
      await profiles.select(id, connect, undefined, sessionId, accountPage);
    });
  }
  function confirmSwitch() {
    return (
      (!terminalSessionId &&
        !state.sessions.some((session) => session.activeRun && isHere(session, state.device))) ||
      window.confirm('切换代理服务会断开当前服务器并结束这台电脑上正在运行的任务和终端。继续？')
    );
  }
  function manageProfiles() {
    if (confirmSwitch()) disconnect();
  }
  function saveProfile() {
    setProfileNotice(null);
    void act(async () => {
      if (!form.name.trim()) throw new Error('请输入服务名称。');
      validateConnection(form);
      await profiles.save({
        ...form,
        name: form.name.trim(),
        url: form.url.trim(),
        fingerprint: form.fingerprint.trim(),
      });
      setProfileNotice('代理服务配置已保存。');
    });
  }
  // Moves the window to a place and remembers it; going back or forward revisits without adding to the trail.
  function visit(next: Place, record = true) {
    if (next.sessionId && next.sessionId !== client.state.selectedId) client.select(next.sessionId);
    setPlace(next);
    closeSide();
    if (!record) return;
    const { places, at } = trail.current;
    const last = places[at];
    if (
      last.page === next.page &&
      last.section === next.section &&
      last.sessionId === next.sessionId
    )
      return;
    trail.current = { places: [...places.slice(0, at + 1), next].slice(-50), at: 0 };
    trail.current.at = trail.current.places.length - 1;
    setTrailAt(trail.current.at);
  }
  function step(by: number) {
    const { places } = trail.current;
    // Sessions deleted since are passed over.
    for (let at = trail.current.at + by; at >= 0 && at < places.length; at += by) {
      const target = places[at];
      if (target.sessionId && !state.sessions.some((item) => item.id === target.sessionId))
        continue;
      trail.current.at = at;
      setTrailAt(at);
      visit(target, false);
      return;
    }
  }
  const stepAvailable = (by: number) => {
    const { places } = trail.current;
    for (let at = trail.current.at + by; at >= 0 && at < places.length; at += by)
      if (!places[at].sessionId || state.sessions.some((item) => item.id === places[at].sessionId))
        return true;
    return false;
  };
  const show = (sessionId: string) => visit({ ...place, page: 'chat', sessionId });
  const open = (page: Page, section: Section = place.section) => {
    if (!host.schedules && page === 'schedules') return;
    if (!host.nativeSettings && (section === 'claude' || section === 'account'))
      section = 'general';
    visit({ page, section, sessionId: client.state.selectedId });
  };
  async function refreshStatus(sessionId = selected?.id ?? sessions[0]?.id) {
    if (!sessionId || refreshing) return;
    setRefreshing(true);
    try {
      await client.request({ type: 'session.status', sessionId });
    } catch (error) {
      setError(
        error instanceof RequestInterruptedError
          ? error
          : error instanceof Error
            ? error.message
            : '原生状态读取失败',
      );
    } finally {
      setRefreshing(false);
    }
  }
  async function createSession(projectPath: string) {
    const response = await client.request({ type: 'session.create', title: '新会话', projectPath });
    if (response.sessionId) show(response.sessionId);
  }
  async function createInProject(path: string) {
    await act(() => createSession(path));
  }
  async function addProject() {
    if (!window.desktop?.chooseProject) {
      setCreateOpen(true);
      return;
    }
    await act(async () => {
      const path = await window.desktop!.chooseProject();
      if (path) setProjects((value) => withProject(value, path));
    });
  }
  // The desktop gives an ordinary session a local directory; the browser creates one on the server.
  async function newSession() {
    if (browser) {
      await act(async () => {
        const response = await client.request({ type: 'server.session.create', title: '新会话' });
        if (response.sessionId) show(response.sessionId);
      });
      return;
    }
    if (window.desktop) {
      await act(async () => {
        const directory = await window.desktop!.createWorkspace();
        try {
          await createSession(directory);
        } catch (error) {
          await window.desktop!.removeWorkspace(directory);
          throw error;
        }
      });
      return;
    }
    const path =
      (away ? undefined : selected?.projectPath) ?? projects[0] ?? sessions[0]?.projectPath;
    if (path) await createInProject(path);
    else await addProject();
  }
  // A due task is an ordinary message: to its session once that is idle, or to a session made for it. It is
  // never queued into a run, and waits while this window's native terminal is open.
  const notifications = useNotifications(
    client,
    () => (foreground && place.page === 'chat' ? client.state.selectedId : null),
    profileId,
  );
  useEffect(() =>
    window.desktop?.onNotifyClicked((sessionId) => {
      if (sessionId) void profiles.select(profileId, true, undefined, sessionId);
    }, profileId),
  );
  const schedules = useSchedules(
    async (task, due) => {
      const { status, sessions, selectedId, device } = client.state;
      if (
        status !== 'connected' ||
        rotation.working ||
        sessions.some(
          (session) => session.activeRun?.surface === 'terminal' && isHere(session, device),
        )
      )
        return false;
      let session: Session | undefined;
      if (task.target.type === 'session') {
        const { sessionId } = task.target;
        session = sessions.find((item) => item.id === sessionId);
        if (!session) throw new Error('目标会话已不存在');
        if (session.activeRun) return false;
      } else {
        const created = await client.request({
          type: 'session.create',
          title: task.name,
          projectPath: task.target.projectPath,
        });
        session = client.state.sessions.find((item) => item.id === created.sessionId);
        if (!session) throw new Error('新会话创建失败');
        // Creating a session moved the live stream to it; the session being read takes it back.
        if (selectedId) client.select(selectedId);
      }
      if (
        (task.model && task.model !== session.model) ||
        (task.effort && task.effort !== session.effort)
      )
        await client.request({
          type: 'session.configure',
          sessionId: session.id,
          permissionMode: session.permissionMode,
          model: task.model ?? session.model,
          effort: task.effort ?? session.effort,
        });
      await client.request({
        type: 'message.send',
        sessionId: session.id,
        text: taskMessage(task, due),
        scenario: 'chat',
      });
      return true;
    },
    (task, outcome) =>
      notifications.push({
        kind: 'schedule',
        title: '定时任务未发出',
        body: `${task.name}：${outcome.text}`,
      }),
    profileId,
    host.schedules,
  );
  // Where a session of another computer is to be on this one; null when the user gives none.
  async function placeHere(session: Session) {
    const path = window.desktop
      ? await window.desktop.chooseProject()
      : window.prompt('这台电脑上的项目目录', session.projectPath);
    return path?.trim() || null;
  }
  // Moves a session to a directory chosen here, on this computer, which also takes it over from the computer
  // it was on: from the next message Claude works there.
  async function takeOver(session: Session) {
    await act(async () => {
      const projectPath = await placeHere(session);
      if (!projectPath) return;
      await client.request({ type: 'session.move', sessionId: session.id, projectPath });
      setProjects((value) => withProject(value, projectPath));
    });
  }
  // A fork continues from the same context in a session of its own. Forking before a message brings that
  // message back as a draft, which is how an earlier message is edited and sent again.
  async function fork(session: Session, before?: { id: string; text: string }) {
    await act(async () => {
      // The copy of a session that is on another computer needs a directory on this one.
      const projectPath = onThis(session) ? undefined : await placeHere(session);
      if (projectPath === null) return;
      const response = await client.request({
        type: 'session.fork',
        sessionId: session.id,
        ...(before ? { beforeMessageId: before.id } : {}),
        ...(projectPath ? { projectPath } : {}),
      });
      if (!response.sessionId) return;
      if (before) setDraft(response.sessionId, before.text);
      show(response.sessionId);
    });
  }
  async function send(text = draft, mode = sendMode) {
    if (!selected || !text.trim() || inputDisabled) return;
    const sessionId = selected.id;
    setSlashOpen(false);
    await act(async () => {
      try {
        if (await rotation.sendAfterQuota(selected, text, scenario, true)) return;
        await client.request({
          type: mode === 'queue' && queueEnabled ? 'message.enqueue' : 'message.send',
          sessionId,
          text,
          scenario,
        });
        setDraft(sessionId, '');
      } catch (error) {
        // Only a definitive rejection before acceptance may move this new message to another server.
        if (error instanceof RequestRejectedError && error.code === 'pool_unavailable') {
          await rotation.sendAfterQuota(selected, text, scenario);
          return;
        }
        throw error;
      }
    });
  }
  // Takes up the last turn, which was stopped or cut off, without the user writing anything.
  function resume() {
    if (!selected || linkedHistory?.forward) return;
    const sessionId = selected.id;
    void act(async () => {
      await client.request({ type: 'run.continue', sessionId });
    });
  }
  async function compact() {
    if (!selected || controlsDisabled || !canCompact) return;
    setSlashOpen(false);
    setDraft(selected.id, '');
    await act(async () => {
      await client.request({ type: 'session.compact', sessionId: selected.id });
    });
  }
  async function configure(values: {
    model?: string | null;
    effort?: Effort | null;
    permissionMode?: PermissionMode;
  }) {
    if (!selected) return;
    await act(async () => {
      await client.request({
        type: 'session.configure',
        sessionId: selected.id,
        permissionMode: selected.permissionMode,
        ...values,
      });
    });
  }
  function sessionMenu(session: Session): MenuItem[] {
    const idle = connected && !busy && !refreshing && !terminalSessionId;
    const anyRun = state.sessions.some((item) => !!item.activeRun);
    const pinned = prefs.pinnedSessions.includes(session.id);
    return [
      {
        label: pinned ? '取消置顶' : '置顶',
        icon: pinned ? <PinOff /> : <Pin />,
        run: () =>
          setPrefs((value) => ({
            ...value,
            pinnedSessions: toggled(value.pinnedSessions, session.id),
          })),
      },
      {
        label: '重命名',
        icon: <Pencil />,
        disabled: !idle || !!session.activeRun,
        run: () => {
          setError(null);
          closeSide();
          setRenameSession(session);
        },
      },
      ...(host.localProjects
        ? [
            {
              label: '分叉会话',
              icon: <GitFork />,
              disabled: !idle || !!session.activeRun,
              run: () => {
                void fork(session);
              },
            },
          ]
        : []),
      {
        label: '导出为 Markdown',
        icon: <FileDown />,
        disabled: !connected || !!terminalSessionId,
        run: () => {
          void act(async () => {
            await exportSession(client, session, profiles.initial);
          });
        },
      },
      // A session on another computer is taken over first, with a directory here.
      ...(onThis(session)
        ? [
            {
              label: '移到其他项目…',
              icon: <FolderSymlink />,
              disabled: !idle || !!session.activeRun,
              run: () => {
                if (menu) setMenu({ ...menu, kind: 'move', sessionId: session.id });
              },
            },
          ]
        : []),
      ...(nativeMode
        ? [
            {
              label: '原生终端',
              icon: <SquareTerminal />,
              // A terminal takes only its own session; others may be running.
              disabled: !idle || !!session.activeRun,
              run: () => {
                show(session.id);
                setTerminalSessionId(session.id);
              },
            },
            {
              label: '刷新状态',
              icon: <RefreshCw />,
              disabled: !idle || anyRun || refreshing || !!history?.loading,
              run: () => {
                void refreshStatus(session.id);
              },
            },
          ]
        : []),
      {
        label: '删除',
        icon: <Trash2 />,
        danger: true,
        separated: true,
        disabled: !connected || !!session.activeRun || !!terminalSessionId,
        run: () => {
          setError(null);
          closeSide();
          setDeleteSession(session);
        },
      },
    ];
  }
  function projectMenu(path: string): MenuItem[] {
    const key = pathKey(path);
    const pinned = prefs.pinnedProjects.includes(key);
    return [
      {
        label: '新建会话',
        icon: <Plus />,
        disabled: !connected || busy || refreshing || !!terminalSessionId,
        run: () => {
          void createInProject(path);
        },
      },
      {
        label: pinned ? '取消置顶' : '置顶',
        icon: pinned ? <PinOff /> : <Pin />,
        run: () =>
          setPrefs((value) => ({ ...value, pinnedProjects: toggled(value.pinnedProjects, key) })),
      },
      ...(nativeMode
        ? [
            {
              label: '额度重置后自动继续',
              icon: <RefreshCw />,
              checked: !!state.pool?.quotaResumeProjects?.some(
                (item) => item.deviceId === state.device?.id && pathKey(item.projectPath) === key,
              ),
              disabled:
                !connected ||
                busy ||
                !state.features.includes('project-quota-resume') ||
                !state.pool,
              detail: state.features.includes('project-quota-resume') ? undefined : '请升级服务端',
              run: () =>
                void act(async () => {
                  await client.request({
                    type: 'project.quotaResume',
                    projectPath: path,
                    enabled: !state.pool?.quotaResumeProjects?.some(
                      (item) =>
                        item.deviceId === state.device?.id && pathKey(item.projectPath) === key,
                    ),
                  });
                }),
            },
          ]
        : []),
      { label: '修改显示名称', icon: <Pencil />, run: () => setRenameProject(path) },
      {
        label: '更改文件夹…',
        icon: <FolderInput />,
        disabled: !connected || busy || !!terminalSessionId,
        run: () => {
          if (!window.desktop) return setRepointProject(path);
          void act(async () => {
            const chosen = await window.desktop!.chooseProject();
            if (chosen) await repoint(path, chosen);
          });
        },
      },
      ...(window.desktop
        ? [
            {
              label: isMac ? '在访达中打开' : '在资源管理器中打开',
              icon: <FolderOpen />,
              separated: true,
              run: () => {
                void act(() => window.desktop!.openFolder(path));
              },
            },
          ]
        : []),
    ];
  }
  const projectLabel = (path: string) => prefs.projectNames[pathKey(path)] || folderName(path);
  // The projects of this computer: the ones listed here and the folders its sessions are in.
  function herePaths() {
    const paths = [...projects];
    for (const item of sessions)
      if (
        !isInside(item.projectPath, workspaceRoots) &&
        !paths.some((path) => pathKey(path) === pathKey(item.projectPath))
      )
        paths.push(item.projectPath);
    return paths;
  }
  // Every project the session could belong to, the one it is in marked. A session of another computer is in
  // none of them, also when a folder here has the same path: moving it into one takes it over.
  function moveMenu(session: Session): MenuItem[] {
    const here = onThis(session);
    return [
      ...herePaths().map((path) => ({
        label: projectLabel(path),
        detail: path,
        checked: here && pathKey(path) === pathKey(session.projectPath),
        run: () => {
          if (!here || pathKey(path) !== pathKey(session.projectPath))
            void act(async () => {
              await client.request({
                type: 'session.move',
                sessionId: session.id,
                projectPath: path,
              });
            });
        },
      })),
      // A folder that is no project yet becomes one with the move.
      {
        label: '选择其他文件夹…',
        icon: <FolderOpen />,
        separated: true,
        run: () => {
          void takeOver(session);
        },
      },
    ];
  }
  // Points a project at another folder: the service moves its sessions there with what Claude Code keeps of
  // the project, and what this computer keeps about it (its place in the list, its name, its pin) follows.
  async function repoint(from: string, to: string) {
    const key = pathKey(from);
    const next = pathKey(to);
    if (key === next) return;
    if (state.features.includes('project-move')) {
      await client.request({ type: 'project.move', from, to });
    } else {
      // Older personal servers can still move sessions and expose their upgrade controls.
      const members = sessions.filter((item) => pathKey(item.projectPath) === key);
      if (members.some((item) => item.activeRun))
        throw new Error('这个项目里有会话正在运行，结束后再更改文件夹。');
      for (const item of members)
        await client.request({ type: 'session.move', sessionId: item.id, projectPath: to });
    }
    setProjects((value) => [
      ...new Map(
        value
          .map((path) => (pathKey(path) === key ? to : path))
          .map((path) => [pathKey(path), path]),
      ).values(),
    ]);
    setPrefs((value) => {
      const projectNames = { ...value.projectNames };
      if (projectNames[key] && !projectNames[next]) projectNames[next] = projectNames[key];
      delete projectNames[key];
      return {
        ...value,
        projectNames,
        pinnedProjects: [
          ...new Set(value.pinnedProjects.map((item) => (item === key ? next : item))),
        ],
      };
    });
  }
  const adapterName = `${form.name} · ${nativeMode ? 'Claude Code' : 'Simulation'}`;
  const sessionAccount = serverPool
    ? state.pool?.accounts.find((account) => account.id === selected?.accountId)
    : undefined;
  const accountName = serverPool
    ? (sessionAccount?.email ??
      sessionAccount?.name ??
      (selected?.accountId ? '正在读取账号' : selected ? '待选择账号' : '账号池'))
    : signedOut
      ? '未登录'
      : (state.account?.email ?? capabilities?.account.email ?? (nativeMode ? '账号' : '离线模拟'));
  const connectionName = serverPool ? `${accountName} · Claude Code` : adapterName;
  const upgradeItem: MenuItem | null = upgrade
    ? {
        label: `升级客户端到 ${upgrade}`,
        icon: <Download />,
        disabled: busy || state.sessions.some((item) => !!item.activeRun),
        run: () => {
          void act(() => window.desktop!.installUpdate(undefined, profileId));
        },
      }
    : null;
  // What an upgrade would bring is read where the upgrade is offered, before it is taken.
  const newer =
    upgrade ??
    ahead ??
    (update && ['available', 'manual'].includes(update.state) ? (update.latest ?? null) : null);
  const updates = [
    ...(newer
      ? [
          {
            label: `查看 ${newer} 的更新内容`,
            icon: <ScrollText />,
            run: () => setNotes(newer),
          },
        ]
      : []),
    ...(upgradeItem ? [upgradeItem] : []),
    ...(serviceUpdate ? [serviceUpdate] : []),
  ];
  // The rail shows its button only for an update that exists, not for the standing offer to look for one.
  const pendingUpdate = upgrade
    ? `客户端可升级到 ${upgrade}`
    : update && ['available', 'manual', 'installing', 'restarting'].includes(update.state)
      ? (serviceUpdate?.label ?? null)
      : null;
  // What a menu shows beside an item that has a shortcut.
  const hint = (action: Action) =>
    (prefs.shortcuts.enabled && comboText(keyFor(prefs, action))) || undefined;
  const settingsMenu: MenuItem[] = [
    ...(host.accountManagement
      ? [
          {
            label: `账号 · ${accountName}`,
            icon: <UserRound />,
            detail: serverPool
              ? (sessionAccount?.subscriptionType ?? '账号与额度')
              : signedOut
                ? '点击登录 Claude 账号'
                : (state.account?.subscriptionType ??
                  capabilities?.account.subscriptionType ??
                  '账号与额度'),
            run: () => open('settings', 'account'),
          },
          ...profiles.profiles
            .filter((profile) => !profiles.pool.config.enabled && profile.id !== profileId)
            .map((profile) => ({
              label: `切换代理服务 · ${profile.name}`,
              icon: <UserRound />,
              detail: profile.url,
              disabled: busy || refreshing || rotation.working,
              run: () => {
                void switchProfile(profile.id, true);
              },
            })),
          {
            label: '管理代理服务',
            icon: <Settings />,
            disabled: busy || refreshing || rotation.working,
            run: manageProfiles,
          },
        ]
      : []),
    {
      label: '设置',
      icon: <Settings />,
      hint: hint('settings'),
      separated: true,
      run: () => open('settings', nativeMode && host.nativeSettings ? 'claude' : 'general'),
    },
    { label: '帮助', icon: <CircleHelp />, run: () => open('settings', 'help') },
    {
      label: browser ? '退出登录' : '断开连接',
      icon: <LogOut />,
      separated: true,
      run: disconnect,
    },
  ];
  const toggleSide = () => setSideOpen((value) => !value);
  const canCreate = connected && !busy && !refreshing && !terminalSessionId && !rotation.working;
  const barMenus: BarMenu[] = [
    {
      label: '文件',
      items: [
        {
          label: '新建会话',
          hint: hint('newSession'),
          disabled: !canCreate,
          run: () => {
            void newSession();
          },
        },
        ...(host.localProjects
          ? [
              {
                label: '添加项目…',
                disabled: !connected || busy || !!terminalSessionId,
                run: () => {
                  void addProject();
                },
              },
            ]
          : []),
        {
          label: '导出当前会话…',
          disabled: !selected || !connected || !!terminalSessionId,
          separated: true,
          run: () => {
            void act(async () => {
              await exportSession(client, selected!, profiles.initial);
            });
          },
        },
        { label: browser ? '退出登录' : '断开连接', separated: true, run: disconnect },
        ...(window.desktop ? [{ label: '退出', run: () => void window.desktop!.quit() }] : []),
      ],
    },
    {
      label: '视图',
      items: [
        {
          label: '查找对话内容',
          hint: hint('find'),
          disabled: !selected || place.page !== 'chat' || !!terminalSessionId,
          run: () => setFindRequest((value) => value + 1),
        },
        { label: sideOpen ? '收起侧栏' : '展开侧栏', hint: hint('toggleSide'), run: toggleSide },
        { label: '会话', separated: true, checked: place.page === 'chat', run: () => open('chat') },
        ...(host.schedules
          ? [
              {
                label: '定时任务',
                checked: place.page === 'schedules',
                run: () => open('schedules'),
              },
            ]
          : []),
        {
          label: '设置',
          hint: hint('settings'),
          checked: place.page === 'settings',
          run: () => open('settings'),
        },
        ...(window.desktop
          ? [
              {
                label: '放大',
                hint: hint('zoomIn'),
                separated: true,
                run: () => window.desktop!.zoom(1),
              },
              { label: '缩小', hint: hint('zoomOut'), run: () => window.desktop!.zoom(-1) },
              { label: '实际大小', hint: hint('zoomReset'), run: () => window.desktop!.zoom(0) },
            ]
          : []),
      ],
    },
    {
      label: '帮助',
      items: [
        { label: '使用说明', run: () => open('settings', 'help') },
        {
          label: '快捷键',
          run: () => open('settings', 'shortcuts'),
        },
        ...(project.url ? [{ label: '项目主页', separated: true, run: openProject }] : []),
        { label: '检查更新与版本信息', run: () => open('settings', 'about') },
      ],
    },
  ];
  // The shortcuts, as the user set them. A key press that something else already took, or that belongs to the
  // native terminal or an open dialog, is left alone.
  const keys = useRef<(event: KeyboardEvent) => void>(() => {});
  keys.current = (event) => {
    if (!foreground || event.defaultPrevented || !prefs.shortcuts.enabled) return;
    if (!connected && state.status !== 'reconnecting') return;
    if (
      (event.target as Element | null)?.closest?.('.native-terminal') ||
      document.querySelector('dialog[open]')
    )
      return;
    const combo = comboOf(event);
    const action = combo && actions.find((item) => keyFor(prefs, item.id) === combo)?.id;
    if (!action) return;
    const run: Record<Action, (() => void) | false | undefined> = {
      back: !terminalSessionId && (() => step(-1)),
      forward: !terminalSessionId && (() => step(1)),
      toggleSide,
      newSession: canCreate && (() => void newSession()),
      settings: () => open('settings'),
      find:
        !!selected &&
        place.page === 'chat' &&
        !terminalSessionId &&
        (() => setFindRequest((value) => value + 1)),
      zoomIn: window.desktop && (() => window.desktop!.zoom(1)),
      zoomOut: window.desktop && (() => window.desktop!.zoom(-1)),
      zoomReset: window.desktop && (() => window.desktop!.zoom(0)),
    };
    const act = run[action];
    if (!act) return;
    event.preventDefault();
    act();
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keys.current(event);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  if (browser && (state.status === 'disconnected' || state.status === 'connecting'))
    return (
      <main className="web-login">
        <section className="web-login-body">
          <h1>连接服务端工作台</h1>
          {browser.selfSigned && <CertificateWarning />}
          <p role="status">{currentError ?? '正在连接…'}</p>
          {state.status === 'disconnected' && (
            <button
              className="button"
              onClick={() =>
                client.connectBrowser(
                  browserSocket(),
                  browser.expired,
                  async () => (await browserSession()).authenticated,
                )
              }
            >
              重新连接
            </button>
          )}
          <button className="button" onClick={disconnect}>
            退出登录
          </button>
        </section>
      </main>
    );

  if (profiles.managing || state.status === 'disconnected' || state.status === 'connecting')
    return localSettings ? (
      <div className="settings-only">
        <div className="window-drag" />
        <SettingsPage
          client={client}
          section={localSettings}
          go={setLocalSettings}
          back={() => setLocalSettings(null)}
          native={false}
          account={null}
          form={form}
          changeForm={changeForm}
          workspaceRoot={workspaceRoots[0] ?? ''}
          chooseWorkspace={(reset) => {
            void act(async () => {
              setWorkspaceRoots(await window.desktop!.chooseWorkspace(reset));
            });
          }}
          version={version}
          service={null}
          adapterName=""
          updates={[]}
          showNotes={setNotes}
        />
        {notesDialog}
      </div>
    ) : (
      <>
        {notesDialog}
        <LoginPage
          showNotes={setNotes}
          newer={upgrade ?? ahead}
          profiles={profiles.profiles}
          profileId={profileId}
          name={form.name}
          changeName={(name) => setForm((current) => ({ ...current, name }))}
          selectProfile={(id) => {
            void switchProfile(id, false);
          }}
          addProfile={() => {
            void act(profiles.add);
          }}
          saveProfile={saveProfile}
          removeProfile={() => {
            if (window.confirm(`删除代理服务配置“${form.name}”及其保存的服务凭据？`))
              void act(profiles.remove);
          }}
          notice={rotation.notice ?? profileNotice}
          pool={
            profiles.profiles.length > 1 ? (
              <AccountPoolPanel
                pool={profiles.pool}
                profiles={profiles.profiles}
                activeId={profileId}
                connected={connected}
              />
            ) : null
          }
          openSettings={() => setLocalSettings('general')}
          form={form}
          change={changeForm}
          error={
            currentError && state.mismatch && !upgrade && state.service && version
              ? `${currentError}${
                  isNewer(version, state.service)
                    ? '此客户端较新，请先升级服务端。'
                    : !selfUpdating
                      ? '这个系统上的客户端需要手动升级：请到 GitHub 发布页下载与服务端同一版本的安装包。'
                      : state.preparing !== null
                        ? `服务端正在下载这一版的安装包（${Math.floor(state.preparing * 100)}%），稍后重新连接就能从服务端升级；也可以现在直接从 GitHub 发布页下载。`
                        : '服务端还没有这一版的安装包，它会继续尝试下载；可以直接从 GitHub 发布页下载，或稍后重试。'
                }`
              : currentError
          }
          upgrade={state.mismatch && window.desktop ? upgrade : null}
          older={
            form.mode === 'remote' &&
            state.mismatch &&
            state.service &&
            isNewer(version, state.service)
              ? state.service
              : null
          }
          direct={direct}
          downloaded={downloaded}
          install={install}
          connecting={state.status === 'connecting' || proxyConnecting || busy}
          submit={() => {
            void login(form);
          }}
        />
      </>
    );
  const menuSession =
    menu?.kind === 'session' ? state.sessions.find((item) => item.id === menu.sessionId) : null;
  const moved =
    menu?.kind === 'move' ? state.sessions.find((item) => item.id === menu.sessionId) : null;
  const menuAway = !!moved && !onThis(moved);
  const openMenu =
    !menu || (menu.kind === 'session' && !menuSession)
      ? null
      : menu.kind === 'session'
        ? { label: `会话操作 · ${menuSession!.title}`, items: sessionMenu(menuSession!) }
        : menu.kind === 'project'
          ? { label: `项目操作 · ${menu.path}`, items: projectMenu(menu.path) }
          : menu.kind === 'move'
            ? {
                label: '会话所在的项目',
                heading: menuAway
                  ? '选这个会话在这台电脑上的项目；下一条消息会告诉 Claude 换了电脑'
                  : '把会话移到另一个项目；下一条消息会告诉 Claude，聊过的会话仍沿用原项目的记忆',
                items: moved ? moveMenu(moved) : [],
              }
            : menu.kind === 'settings'
              ? { label: '设置与账号', items: settingsMenu }
              : menu.kind === 'update'
                ? { label: '更新', items: updates }
                : {
                    label: menu.label,
                    items: barMenus.find((item) => item.label === menu.label)?.items ?? [],
                  };
  const sectionNames: Record<Section, string> = {
    account: '账号与额度',
    claude: 'Claude Code 设置',
    general: '常规设置',
    document: '共享文档',
    notifications: '通知设置',
    shortcuts: '快捷键',
    help: '帮助',
    about: '关于与更新',
  };
  return (
    <div
      className={`shell ${sideOpen ? '' : 'side-closed'} ${selfSigned ? 'web-self-signed' : ''}`}
    >
      {selfSigned && <CertificateWarning />}
      <TitleBar
        title={
          place.page === 'chat'
            ? (selected?.title ?? 'CC Desk Tunnel')
            : place.page === 'schedules'
              ? '定时任务'
              : sectionNames[place.section]
        }
        back={!terminalSessionId && stepAvailable(-1) ? () => step(-1) : undefined}
        forward={!terminalSessionId && stepAvailable(1) ? () => step(1) : undefined}
        sideOpen={sideOpen}
        toggleSide={toggleSide}
        menus={barMenus}
        openMenu={(item, position) => setMenu({ kind: 'bar', label: item.label, ...position })}
        connected={connected}
        adapterName={connectionName}
      />
      <Rail
        accountPool={serverPool ? () => open('settings', 'account') : undefined}
        page={place.page}
        go={(page) => open(page)}
        schedules={host.schedules}
        update={host.serviceManagement ? pendingUpdate : null}
        openUpdate={(position) => setMenu({ kind: 'update', ...position })}
        openSettings={(position) => setMenu({ kind: 'settings', ...position })}
      />
      {rotation.notice && (
        <div className="pool-notice" role="status">
          <span>{rotation.notice}</span>
          <IconButton title="关闭提示" onClick={rotation.dismissNotice}>
            <X aria-hidden="true" />
          </IconButton>
        </div>
      )}
      {sideOpen && (
        <button
          className="sidebar-shade"
          aria-label="收起侧栏"
          onClick={() => setSideOpen(false)}
        />
      )}
      {place.page === 'settings' ? (
        <SettingsPage
          client={client}
          browser={!!browser}
          section={place.section}
          go={(section) => open('settings', section)}
          native={nativeMode}
          form={form}
          changeForm={changeForm}
          workspaceRoot={workspaceRoots[0] ?? ''}
          chooseWorkspace={(reset) => {
            void act(async () => {
              setWorkspaceRoots(await window.desktop!.chooseWorkspace(reset));
            });
          }}
          version={version}
          service={state.service}
          adapterName={adapterName}
          updates={host.serviceManagement ? updates : []}
          showNotes={setNotes}
          account={
            serverPool ? (
              <UnifiedAccountPool
                client={client}
                state={state.pool}
                connected={connected}
                profiles={profiles}
                select={(id) =>
                  void switchProfile(
                    id,
                    !!profiles.profiles.find((item) => item.id === id)?.token,
                    undefined,
                    true,
                  )
                }
              />
            ) : (
              <AccountPanel
                pool={
                  <AccountPoolPanel
                    pool={profiles.pool}
                    profiles={profiles.profiles}
                    activeId={profileId}
                    connected={connected}
                    legacyService={state.serviceProtocol === 16}
                  />
                }
                client={client}
                account={nativeMode ? state.account : null}
                capabilities={signedOut ? null : capabilities}
                metrics={signedOut ? null : accountMetrics}
                refreshing={refreshing}
                disabled={
                  !state.sessions.length ||
                  !connected ||
                  refreshing ||
                  anyTerminal ||
                  rotation.working
                }
                error={currentError}
                refresh={() => {
                  void refreshStatus();
                }}
              />
            )
          }
        />
      ) : place.page === 'schedules' ? (
        <SchedulePanel
          schedules={schedules}
          sessions={sessions}
          projects={projects}
          capabilities={capabilities}
        />
      ) : (
        <>
          <Sidebar
            quotaWaits={state.pool?.quotaWaits?.map((wait) => wait.sessionId)}
            serviceName={serverPool || profiles.profiles.length > 1 ? form.name : undefined}
            unifiedHistory={serverPool}
            sources={Object.fromEntries(
              catalog.others.map((item) => [item.display.id, item.source.name]),
            )}
            catalogStatus={catalog.failure || (catalog.refreshing ? '同步其他代理会话…' : '')}
            refreshCatalog={() => void catalog.refresh()}
            sessions={[
              ...sessions,
              ...catalog.others.filter((item) => onThis(item.session)).map((item) => item.display),
            ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))}
            elsewhere={[
              ...elsewhere,
              ...catalog.others.filter((item) => !onThis(item.session)).map((item) => item.display),
            ]}
            devices={state.devices}
            selectedId={selected?.id}
            projects={host.localProjects ? projects : []}
            localProjects={host.localProjects}
            workspaceRoots={workspaceRoots}
            connected={connected}
            busy={busy}
            refreshing={refreshing}
            terminalOpen={!!terminalSessionId}
            notifications={notifications}
            select={(id) => {
              const remote = catalogRows.get(id);
              if (!remote) {
                show(id);
                return;
              }
              const profile = profiles.profiles.find((item) => item.id === remote.source.id);
              if (profile) void switchProfile(profile.id, !!profile.token, remote.session.id);
            }}
            newSession={() => {
              void newSession();
            }}
            addProject={() => {
              void addProject();
            }}
            createInProject={(path) => {
              void createInProject(path);
            }}
            sessionMenu={(session, position) =>
              setMenu({ kind: 'session', sessionId: session.id, ...position })
            }
            projectMenu={(path, position) => setMenu({ kind: 'project', path, ...position })}
          />
          <main className="workspace">
            {linkedHistory?.forward && (
              <div className="session-account-strip" role="status">
                <span>此任务已在其他服务器续接</span>
                <button
                  className="button secondary"
                  onClick={() => {
                    const next = linkedHistory.forward!;
                    const profile = profiles.profiles.find(
                      (item) => item.id === next.profileId && item.url === next.url,
                    );
                    if (!profile) {
                      setError('目标服务器配置已删除或地址已更改，请恢复原配置后打开会话。');
                      return;
                    }
                    void switchProfile(profile.id, true, next.sessionId);
                  }}
                >
                  前往当前会话
                </button>
              </div>
            )}
            {selected &&
              profiles.profiles.length > 1 &&
              !profiles.pool.config.enabled &&
              !terminalSessionId && (
                <div className="session-account-strip">
                  <span>当前服务器：{form.name}</span>
                  <select
                    aria-label="续接到服务器"
                    value=""
                    disabled={
                      controlsDisabled || away || sessions.some((session) => !!session.activeRun)
                    }
                    onChange={(event) => {
                      if (draft.trim()) {
                        setError('请先发送或清空草稿，再切换服务器。');
                        return;
                      }
                      void rotation.transfer(event.target.value, selected);
                    }}
                  >
                    <option value="" disabled>
                      续接到其他服务器…
                    </option>
                    {profiles.profiles
                      .filter((profile) => profile.id !== profileId)
                      .map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.name}
                        </option>
                      ))}
                  </select>
                </div>
              )}
            {serverPool && !terminalSessionId && (
              <div className="session-account-strip" aria-label={`当前服务器：${form.name}`}>
                <div>
                  <span className="pool-live-dot" />
                  <strong>
                    {profiles.pool.config.enabled
                      ? '自动调度'
                      : state.pool?.settings.enabled
                        ? '账号池自动接力'
                        : '固定账号模式'}
                  </strong>
                  <span className="session-account-note">同一项目 · 历史连续</span>
                </div>
                <div>
                  {selected && !profiles.pool.config.enabled && (
                    <select
                      aria-label="当前会话 Claude 账号"
                      value={selected.accountId ?? ''}
                      disabled={
                        !connected || busy || refreshing || !!selected.activeRun || !state.pool
                      }
                      onChange={(event) =>
                        void act(async () => {
                          await client.request({
                            type: 'session.account',
                            sessionId: selected.id,
                            accountId: event.target.value,
                          });
                        })
                      }
                    >
                      <option value="" disabled>
                        发送时选择账号
                      </option>
                      {state.pool?.accounts.map((account) => (
                        <option
                          key={account.id}
                          value={account.id}
                          disabled={!account.enabled || account.loggedIn !== true}
                        >
                          {account.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <button className="button secondary" onClick={() => open('settings', 'account')}>
                    管理账号池
                  </button>
                </div>
              </div>
            )}
            {terminalSessionId && connected && (
              <Suspense
                fallback={
                  <div className="history-status" role="status">
                    加载原生终端
                  </div>
                }
              >
                <NativeTerminal
                  client={client}
                  sessionId={terminalSessionId}
                  onClose={closeTerminal}
                />
              </Suspense>
            )}
            {currentError && (state.status !== 'reconnecting' || actionError) && (
              <div className="error-banner" role="alert">
                <span>{currentError}</span>
                <IconButton
                  title="关闭错误提示"
                  onClick={() => {
                    setError(null);
                    client.update({ error: null });
                  }}
                >
                  <X />
                </IconButton>
              </div>
            )}
            {state.status === 'reconnecting' && (
              <ReconnectNotice
                retry={state.retry}
                restarting={state.update?.state === 'restarting'}
                error={state.error}
                retryNow={() => client.retryNow()}
                disconnect={disconnect}
              />
            )}
            <Conversation
              findRequest={findRequest}
              session={selected}
              here={!!selected && onThis(selected)}
              events={visibleEvents}
              history={history}
              connected={connected}
              quotaWait={
                selected && state.pool?.quotaWaits?.some((wait) => wait.sessionId === selected.id)
                  ? away
                    ? `额度等待中；跨服接力需由 ${selected.device?.name ?? '项目所在电脑'} 的客户端执行，并开启自动接力。`
                    : (rotation.notice ??
                      '额度等待中；正在检查跨服接力条件，无可用服务时等待重置。')
                  : undefined
              }
              native={nativeMode}
              ownsRun={ownsRun}
              clock={clock}
              progress={selected ? state.progress[selected.id] : undefined}
              busy={busy}
              newSession={() => {
                void newSession();
              }}
              loadEarlier={() => client.loadEarlier(selected!.id)}
              edit={
                controlsDisabled || away || !!linkedHistory
                  ? undefined
                  : (id, text) => {
                      void fork(selected!, { id, text });
                    }
              }
              stopTask={(taskId) => {
                void act(async () => {
                  await client.request({
                    type: 'run.task.stop',
                    sessionId: selected!.id,
                    runId: selected!.activeRun!.id,
                    taskId,
                  });
                });
              }}
              backgroundTask={(toolId) => {
                void act(async () => {
                  await client.request({
                    type: 'run.task.background',
                    sessionId: selected!.id,
                    runId: selected!.activeRun!.id,
                    toolId,
                  });
                });
              }}
              stop={stopRun}
              replyApproval={async (runId, approvalId, allowed, answers) => {
                let sent = false;
                await act(async () => {
                  await client.request({
                    type: 'approval.reply',
                    sessionId: selected!.id,
                    runId,
                    approvalId,
                    allowed,
                    ...(answers ? { answers } : {}),
                  });
                  sent = true;
                });
                return sent;
              }}
            />
            {beside.length > 0 && (
              <div className="elsewhere-bar" role="status">
                <Laptop />
                <p>
                  连接{beside.join('、')}
                  里有会话正在这个文件夹里运行。两边同时改动文件可能互相覆盖，建议等一边做完，或让它们在不同的文件夹里工作。
                </p>
              </div>
            )}
            {selected && away && host.localProjects && (
              <div className="elsewhere-bar" role="status">
                <Laptop />
                {remote ? (
                  <p>
                    这个会话在设备“{selected.device?.name}”上，项目目录是{' '}
                    <code>{selected.projectPath}</code>
                    。在这里发的消息、审批和停止都作用于那台电脑上的会话，命令也在那里执行。要换到这台电脑上做，选它在这里的项目目录或分叉到本机。
                  </p>
                ) : (
                  <p>
                    这个会话在设备“{selected.device?.name ?? '未知设备'}”上，项目目录是{' '}
                    <code>{selected.projectPath}</code>
                    。那台电脑目前不在线，这里只能查看；它连上服务后可以直接在这里操作。要在这台电脑上接着做，先选它在这里的项目目录；下一条消息会告诉
                    Claude 换了电脑。
                  </p>
                )}
                <button
                  type="button"
                  className="button primary"
                  disabled={controlsDisabled}
                  onClick={(event) => {
                    // With projects here the session goes into one of them, or into a folder chosen there.
                    if (!herePaths().length) return void takeOver(selected);
                    const box = event.currentTarget.getBoundingClientRect();
                    setMenu({
                      kind: 'move',
                      sessionId: selected.id,
                      x: box.left,
                      y: box.top - 6,
                      above: true,
                    });
                  }}
                >
                  在本机继续…
                </button>
                <button
                  type="button"
                  className="button secondary"
                  disabled={controlsDisabled}
                  onClick={() => {
                    void fork(selected);
                  }}
                >
                  分叉到本机…
                </button>
              </div>
            )}
            {browser && selected && away && !remote && (
              <div className="elsewhere-bar" role="status">
                <Laptop />
                <p>设备“{selected.device?.name ?? '未知设备'}”未连接，当前只能查看会话。</p>
              </div>
            )}
            {selected &&
              (!away || remote) &&
              !terminalSessionId &&
              selected.goal &&
              ['active', 'paused'].includes(selected.goal.status) && (
                <div
                  className="session-goal"
                  role="status"
                  aria-label="会话目标"
                  title={selected.goal.condition}
                >
                  <strong>{selected.goal.status === 'active' ? '目标进行中' : '目标已暂停'}</strong>
                  <span>{selected.goal.condition}</span>
                </div>
              )}
            {selected && (!away || remote) && !terminalSessionId && (
              <Composer
                openAccount={() => open('settings', 'account')}
                session={selected}
                projectName={
                  state.devices.some(
                    (device) => device.server && device.id === selected.device?.id,
                  ) || isInside(selected.projectPath, workspaceRoots)
                    ? null
                    : projectLabel(selected.projectPath)
                }
                chooseProject={
                  controlsDisabled || away
                    ? undefined
                    : (position) => setMenu({ kind: 'move', sessionId: selected.id, ...position })
                }
                draft={draft}
                setDraft={(text) => setDraft(selected.id, text)}
                native={nativeMode}
                connected={connected}
                busy={busy}
                refreshing={refreshing}
                canRefreshModels={!state.sessions.some((session) => session.activeRun)}
                ownsRun={ownsRun}
                inputDisabled={inputDisabled}
                controlsDisabled={controlsDisabled}
                slashOpen={slashOpen}
                setSlashOpen={setSlashOpen}
                canCompact={canCompact}
                scenario={scenario}
                setScenario={setScenario}
                capabilities={capabilities}
                nativeSession={nativeSession}
                metrics={metrics}
                queueEnabled={queueEnabled}
                sendMode={sendMode}
                setSendMode={(mode) => setPrefs((prefs) => ({ ...prefs, sendMode: mode }))}
                removeQueued={(messageId) =>
                  void act(async () => {
                    await client.request({
                      type: 'message.queue.remove',
                      sessionId: selected.id,
                      messageId,
                    });
                  })
                }
                pauseQueue={(paused) =>
                  void act(async () => {
                    await client.request({
                      type: 'message.queue.pause',
                      sessionId: selected.id,
                      paused,
                    });
                  })
                }
                send={(text, mode) => {
                  void send(text, mode);
                }}
                resume={stopped && !inputDisabled ? resume : undefined}
                compact={() => {
                  void compact();
                }}
                refresh={() => {
                  void refreshStatus();
                }}
                configure={configure}
                stop={stopRun}
              />
            )}
            {selected && (!away || (browser && remote)) && !terminalSessionId && (
              <SessionBar
                client={client}
                sessionId={selected.id}
                refresh={turnReports}
                metrics={metrics}
                native={nativeMode}
                accountQuota={{
                  name: accountName,
                  // Pool readings are scoped to this server and this session's account. Global
                  // native metrics may belong to a different account after a handoff.
                  limits: serverPool
                    ? sessionAccount?.loggedIn === true && !sessionAccount.login
                      ? sessionAccount.limits
                      : null
                    : signedOut
                      ? null
                      : (accountMetrics?.rateLimits ?? null),
                  error: serverPool ? sessionAccount?.error : accountMetrics?.errors?.usage,
                }}
                openAccount={() => open('settings', 'account')}
              />
            )}
          </main>
        </>
      )}
      {menu && openMenu && (
        <Menu
          // One menu may give way to another in the same place, which is then laid out anew.
          key={menu.kind}
          label={openMenu.label}
          heading={'heading' in openMenu ? openMenu.heading : undefined}
          x={menu.x}
          y={menu.y}
          above={menu.above}
          onClose={closeMenu}
          items={openMenu.items}
        />
      )}
      {repointProject && (
        <AddProjectDialog
          title="更改项目文件夹"
          action="更改"
          busy={busy}
          connected={connected}
          error={actionError}
          close={() => setRepointProject(null)}
          add={(written) => {
            void act(async () => {
              if (!written) return;
              const path = (await window.desktop?.asOnDisk(written)) ?? written;
              await repoint(repointProject, path);
              setRepointProject(null);
            });
          }}
        />
      )}
      {createOpen && (
        <AddProjectDialog
          busy={busy}
          connected={connected}
          error={actionError}
          close={() => setCreateOpen(false)}
          add={(written) => {
            void act(async () => {
              if (!written) return;
              const path = (await window.desktop?.asOnDisk(written)) ?? written;
              setProjects((value) => withProject(value, path));
              setCreateOpen(false);
            });
          }}
        />
      )}
      {deleteSession && (
        <DeleteSessionDialog
          session={deleteSession}
          native={nativeMode}
          busy={busy}
          connected={connected}
          error={actionError}
          close={() => setDeleteSession(null)}
          confirm={() => {
            void act(async () => {
              await client.request({ type: 'session.delete', sessionId: deleteSession.id });
              setDraft(deleteSession.id, '');
              // A plain session's directory goes with it when the session left nothing there.
              if (isInside(deleteSession.projectPath, workspaceRoots))
                void window.desktop?.removeWorkspace(deleteSession.projectPath);
              setDeleteSession(null);
            });
          }}
        />
      )}
      {renameProject && (
        <RenameProjectDialog
          path={renameProject}
          name={prefs.projectNames[pathKey(renameProject)] ?? ''}
          close={() => setRenameProject(null)}
          rename={(name) => {
            setPrefs((value) => {
              const projectNames = { ...value.projectNames };
              if (name) projectNames[pathKey(renameProject)] = name;
              else delete projectNames[pathKey(renameProject)];
              return { ...value, projectNames };
            });
            setRenameProject(null);
          }}
        />
      )}
      {renameSession && (
        <RenameSessionDialog
          session={renameSession}
          busy={busy || refreshing}
          connected={connected}
          error={actionError}
          close={() => setRenameSession(null)}
          rename={(title) => {
            void act(async () => {
              await client.request({ type: 'session.rename', sessionId: renameSession.id, title });
              setRenameSession(null);
            });
          }}
        />
      )}
      {notesDialog}
    </div>
  );
}
