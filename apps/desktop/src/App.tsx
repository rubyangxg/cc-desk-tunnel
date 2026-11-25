import { useHistoryCache } from './historyCache.ts';
import { RequestRejectedError } from './client.ts';
import {
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { flushSync } from 'react-dom';
import {
  CircleHelp,
  Download,
  FileDown,
  FolderInput,
  FolderMinus,
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
  Project,
  Session,
  SessionEvent,
} from '@cc-desk-tunnel/protocol';
import { FORCED_UPGRADE_SINCE, platformOf, projectOf, runWorking } from '@cc-desk-tunnel/protocol';
import { browserSession, browserSocket, watchActivity } from './browser-api.ts';
import { CertificateWarning } from './WebGate.tsx';
import { hostCapabilities } from './host-capabilities.ts';
import AccountPanel from './AccountPanel.tsx';
import UnifiedAccountPool from './UnifiedAccountPool.tsx';
import { QuotaSummary } from './QuotaSummary.tsx';
import { ProxyClient, RequestInterruptedError } from './client.ts';
import Composer from './Composer.tsx';
import SessionBar from './SessionBar.tsx';
import { isHere, thisDevice } from './device.ts';
import { selfUpdating } from './platform.ts';
import { useClientUpgrade } from './client-upgrade.ts';
import { useDrafts } from './drafts.ts';
import { useDrawerSwipe } from './useDrawerSwipe.ts';
import { useWebNavigation } from './useWebNavigation.ts';
import type { Place } from './useWebNavigation.ts';
import SchedulePanel from './SchedulePanel.tsx';
import { taskMessage, useSchedules } from './schedules.ts';
import type { Scenario } from './Composer.tsx';
import Conversation from './Conversation.tsx';
import ReconnectNotice from './ReconnectNotice.tsx';
import LoginPage from './LoginPage.tsx';
import FilePanel from './FilePanel.tsx';
import { filePlaces, nativeLabels, sessionFolder, sftpPath } from './files.ts';
import type { FilePlace } from './files.ts';
import type { ConnectionForm } from './LoginPage.tsx';
import type { ProfileControls } from './Connections.tsx';
import { validateConnection } from './connections.ts';
import { loadProjects, saveProjects } from './projects.ts';
import type { ConnectionProfile } from './connections.ts';
import AccountPoolPanel from './AccountPoolPanel.tsx';
import { usePoolRotation } from './usePoolRotation.ts';
import { fiveHour, quotaBlock } from './accountPool.ts';
import { exportSession } from './exportSession.ts';
import { historyKey, joinedHistory, sharedHistory } from './sharedHistory.ts';
import type { SharedHistory } from './sharedHistory.ts';
import { onSharedChange, saveShared, shared, useShared } from './shared.ts';
import { useNotifications } from './notifications.ts';
import { isInside, isNewer, pathKey, projectName } from './paths.ts';
import { getPrefs, setPrefs, toggled, usePrefs } from './prefs.ts';
import { UPDATE_TICK_MS, lookDue } from './update-check.ts';
import { actions, comboOf, keyFor, show as comboText } from './shortcuts.ts';
import type { Action } from './shortcuts.ts';
import { nextMode } from './modes.ts';
import Rail from './Rail.tsx';
import { setHelpOpener } from './help-nav.ts';
import { suggestions } from './help-content.ts';
import type { Target } from './help-content.ts';
import type { Page } from './Rail.tsx';
import {
  AddProjectDialog,
  DeleteSessionDialog,
  HandoffConfirmDialog,
  RenameProjectDialog,
  RenameSessionDialog,
} from './SessionDialogs.tsx';
import SettingsPage, { sections } from './SettingsPage.tsx';
import type { Section } from './SettingsPage.tsx';
import Sidebar from './Sidebar.tsx';
import { useSessionCatalog } from './useSessionCatalog.ts';
import TitleBar from './TitleBar.tsx';
import type { BarMenu } from './TitleBar.tsx';
import IdleReminder from './IdleReminder.tsx';
import { CcdtDialog } from './CcdtDialog.tsx';
import { SetupTokenDialog } from './SetupTokenDialog.tsx';
import { IconButton, Menu, WorkspaceVisible } from './ui.tsx';
import type { MenuItem, MenuPosition } from './ui.tsx';

// The notes of every version so far are read only when asked for, and stay out of what the window starts with.
const ReleaseNotes = lazy(() => import('./ReleaseNotes.tsx'));
const HelpCenter = lazy(() => import('./HelpCenter.tsx'));

// The newest event of a kind is the session's current native state.
function latest<T extends EventPayload['type']>(events: SessionEvent[], type: T) {
  return (events.findLast((event) => event.payload.type === type)?.payload ?? null) as Extract<
    EventPayload,
    { type: T }
  > | null;
}
// Which menu is open. Its items are built while rendering, so they follow the state as it changes.
type OpenMenu = MenuPosition &
  (
    | { kind: 'session'; sessionId: string }
    | { kind: 'project'; deviceId: string; path: string }
    | { kind: 'move'; sessionId: string }
    | { kind: 'settings' }
    | { kind: 'update' }
    | { kind: 'bar'; label: string }
  );
const narrow = () => matchMedia('(max-width: 700px)').matches;

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
  const workspaceVisible = useContext(WorkspaceVisible);
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
  const deviceProjects = (state.serviceProtocol ?? 0) >= 29;
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
  const [dismissedFork, setDismissedFork] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const statusPending = useRef(false);
  const [quotaError, setQuotaError] = useState<string | null>(null);
  const quotaPrimed = useRef<string | null>(null);
  const [findRequest, setFindRequest] = useState(0);
  // Which of this computer's settings is open on the login page.
  const [localSettings, setLocalSettings] = useState<Section | null>(null);
  useEffect(() => {
    if (state.status !== 'disconnected' && state.status !== 'connecting') setLocalSettings(null);
  }, [state.status]);
  const refreshed = useRef(new Set<string>());
  // The folders that hold plain sessions; new ones are made in the first.
  const [workspaceRoots, setWorkspaceRoots] = useState<string[]>([]);
  const [drafts, setDraft] = useDrafts(profileId);
  const [scenario, setScenario] = useState<Scenario>('chat');
  const [slashOpen, setSlashOpen] = useState(false);
  // The side column is shown beside the page on a wide window and laid over it on a narrow one.
  const [sideOpen, setSideOpen] = useState(() => !narrow());
  const [place, setPlace] = useState<Place>({
    page: 'chat',
    section: browser ? 'general' : 'account',
    sessionId: null,
  });
  const pendingPlace = useRef(place);
  const webNavigation = useWebNavigation(inBrowser, place, (next, drawer, direction) => {
    if (
      direction &&
      client.state.status === 'connected' &&
      next.sessionId &&
      !client.state.sessions.some((session) => session.id === next.sessionId)
    ) {
      webNavigation.step(webNavigation.canStep(direction) ? direction : -direction);
      return;
    }
    changePlace(next);
    if (narrow()) setSideOpen(drawer);
  });
  function changePlace(next: Place) {
    pendingPlace.current = next;
    const apply = () => {
      if (pendingPlace.current === next) setPlace(next);
    };
    if (
      narrow() &&
      document.startViewTransition &&
      (place.page === 'settings' || next.page === 'settings') &&
      (place.page !== next.page ||
        place.section !== next.section ||
        place.settingsIndex !== next.settingsIndex)
    ) {
      document.documentElement.style.setProperty(
        '--settings-shift',
        next.page !== 'settings' ||
          (place.page === 'settings' && next.settingsIndex && !place.settingsIndex)
          ? '-24px'
          : '24px',
      );
      document.startViewTransition(() => flushSync(apply));
    } else apply();
  }
  const changeSide = (open: boolean) => {
    if (inBrowser && narrow()) webNavigation.drawer(open);
    else setSideOpen(open);
  };
  const closeSide = () => {
    if (narrow()) changeSide(false);
  };
  // Crossing between the layouts also removes a narrow drawer's temporary history entry.
  useEffect(() => {
    const query = matchMedia('(max-width: 700px)');
    const follow = () => {
      if (inBrowser) webNavigation.drawer(false);
      setSideOpen(!query.matches);
    };
    query.addEventListener('change', follow);
    return () => query.removeEventListener('change', follow);
  }, [inBrowser]);
  useEffect(() => {
    if (!inBrowser || state.status !== 'connected') return;
    const id = place.sessionId;
    if (id && client.state.sessions.some((session) => session.id === id)) {
      if (client.state.selectedId !== id) client.select(id);
    } else if (client.state.selectedId) client.update({ selectedId: null });
  }, [client, inBrowser, place.sessionId, state.status]);
  const drawerSwipe = useDrawerSwipe(narrow() && place.page !== 'settings', sideOpen, changeSide);
  // Places visited, for the title bar's way back and forward.
  const trail = useRef<{ places: Place[]; at: number }>({ places: [place], at: 0 });
  const [, setTrailAt] = useState(0);
  const accountOpen = place.page === 'settings' && place.section === 'account';
  const prefs = usePrefs();
  const [version, setVersion] = useState('');
  useEffect(() => {
    void window.desktop?.version().then(setVersion);
  }, []);
  // Opening a session in ccdt found it not installed (`{}`), or of another release (`installed`).
  const [ccdtNeeded, setCcdtNeeded] = useState<{ installed?: string } | null>(null);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteSession, setDeleteSession] = useState<Session | null>(null);
  const [renameSession, setRenameSession] = useState<Session | null>(null);
  const [renameProject, setRenameProject] = useState<Project | null>(null);
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
  // The user's other computers that are online, by name, for the help's examples.
  const onlineOthers = state.devices
    .filter((device) => device.ready && !device.server && device.id !== state.device?.id)
    .map((device) => device.name);
  // This computer's projects, as the service keeps them for all the user's computers.
  const projects = state.projects.filter((project) => project.device.id === state.device?.id);
  // The project a session is in, of whichever computer; one from before computers were told apart that is
  // listed here is this one's. A session in none is a plain session.
  const projectIn = (session: Session) =>
    projectOf(
      state.projects,
      session.device?.id ?? (onThis(session) ? state.device?.id : undefined),
      session.projectPath,
    );
  const away = !!selected && !onThis(selected);
  // Another computer's session is worked on from here while that computer is connected and its commands
  // reach it: what is sent here runs there, as if sent there.
  const reachable = (session: Session) =>
    state.devices.some((device) => device.id === session.device?.id && device.ready);
  const remote = away && reachable(selected);
  // The file panel, beside the conversation on the desktop, or as a page in its place.
  const filesAvailable = !browser && !!window.desktop?.files && place.page === 'chat';
  const filesOpen = filesAvailable && prefs.filePanel.open;
  const [filesPage, setFilesPage] = useState(false);
  const [filesWidth, setFilesWidth] = useState<number | null>(null);
  const [windowWidth, setWindowWidth] = useState(() => innerWidth);
  useEffect(() => {
    const resized = () => setWindowWidth(innerWidth);
    addEventListener('resize', resized);
    return () => removeEventListener('resize', resized);
  }, []);
  // The conversation keeps room enough beside it; on a narrow window the panel lies over it instead.
  const filesOver = windowWidth <= 1000;
  const filesMax = Math.max(
    280,
    windowWidth - 52 - (sideOpen && !filesOver ? 284 : 0) - (filesOver ? 0 : 380),
  );
  const filesShownWidth = Math.min(filesWidth ?? prefs.filePanel.width, filesMax);
  const toggleFiles = () => {
    setFilesPage(false);
    setPrefs((current) => ({
      ...current,
      filePanel: { ...current.filePanel, open: !current.filePanel.open },
    }));
  };
  const serverDevice = state.devices.find((device) => device.server)?.id;
  const filesPlaces = useMemo(
    () => filePlaces(state.device, state.devices, state.files),
    [state.device, state.devices, state.files],
  );
  const selectedForFiles = selected;
  const filesStart = useCallback(
    (where: FilePlace) =>
      sessionFolder(
        selectedForFiles ?? undefined,
        where,
        state.device,
        !!selectedForFiles && onThis(selectedForFiles),
        state.files,
        serverDevice,
      ),
    // A session's folders change with its project or computer, which the session record carries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedForFiles, state.device, state.files, serverDevice],
  );
  // A path shown in the file panel from a link in the conversation: a path on this computer, or one on the
  // computer the session is on, which the panel reaches as that computer's (or the service's) files.
  const [filesRequest, setFilesRequest] = useState<{
    place: string;
    path: string;
    at: number;
  } | null>(null);
  const openInFiles = (path: string, here: boolean) => {
    const device = selected?.device;
    const placeId = here ? 'local' : device?.id === serverDevice ? 'server' : device?.id;
    if (!placeId || !filesPlaces.some((entry) => entry.id === placeId)) {
      setError('这个路径所在的电脑现在不在线，文件面板打不开它。');
      return;
    }
    setFilesPage(false);
    setPrefs((current) => ({ ...current, filePanel: { ...current.filePanel, open: true } }));
    setFilesRequest({
      place: placeId,
      path: placeId === 'local' || placeId === 'server' ? path : sftpPath(path, platformOf(device)),
      at: Date.now(),
    });
  };
  function resizeFiles(event: ReactPointerEvent<HTMLDivElement>) {
    const startX = event.clientX;
    const startWidth = filesShownWidth;
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    let width = startWidth;
    const move = (moved: PointerEvent) => {
      width = Math.round(Math.max(280, Math.min(filesMax, startWidth + startX - moved.clientX)));
      setFilesWidth(width);
    };
    const done = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', done);
      handle.removeEventListener('pointercancel', done);
      setFilesWidth(null);
      setPrefs((current) => ({ ...current, filePanel: { ...current.filePanel, width } }));
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', done);
    handle.addEventListener('pointercancel', done);
  }
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
  // Old services put quota in session metrics; current services keep it at account scope.
  const legacyMetrics = [metrics, state.metrics]
    .filter((item) => !!item?.rateLimits)
    .sort((a, b) =>
      (b!.rateLimits!.measuredAt ?? '').localeCompare(a!.rateLimits!.measuredAt ?? ''),
    )[0];
  const selectedPoolAccount = state.pool?.accounts.find(
    (account) => account.id === (selected?.accountId ?? 'default'),
  );
  const quota = selectedPoolAccount
    ? {
        rateLimits: selectedPoolAccount.loggedIn === false ? null : selectedPoolAccount.limits,
        error: selectedPoolAccount.error,
      }
    : (state.accountQuotas[selected?.accountId ?? 'default'] ??
      (selected?.accountId && selected.accountId !== 'default' && state.quota
        ? null
        : state.account?.loggedIn === false
          ? null
          : (state.quota ??
            (legacyMetrics
              ? { rateLimits: legacyMetrics.rateLimits ?? null, error: legacyMetrics.errors?.usage }
              : null))));
  const rotation = usePoolRotation({
    client,
    profiles,
    busy: busy || refreshing,
    terminalOpen: false,
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
  // Chat runs hold CLI state; external ccdt terminals hold only their own sessions.
  const anyTerminal = state.sessions.some((session) => session.activeRun?.surface === 'terminal');
  const anyChat = state.sessions.some(
    (session) => session.activeRun && session.activeRun.surface !== 'terminal',
  );
  const statusBusy = anyChat || (anyTerminal && !state.features.includes('terminal-quota'));
  const controlsDisabled =
    (!!selected && archive?.key !== archiveKey) ||
    !!linkedHistory?.forward ||
    !connected ||
    rotation.working ||
    busy ||
    refreshing ||
    !!selected?.activeRun ||
    !!history?.loading;
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
    selected?.activeRun?.surface === 'terminal' ||
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
  const quotaSession = selected ?? state.sessions[0];
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
  // A service newer than this client that holds no installer for it yet, as just after its own upgrade: the
  // release page has it. The service tells when its own arrives.
  const behind =
    selfUpdating && version && state.service && isNewer(state.service, version) && !upgrade
      ? state.service
      : null;
  const upgrading = useClientUpgrade((message) => setError(message || null), profileId);
  // A service of a newer version: what that version changed can be read here, whether or not this system's
  // client upgrades itself.
  const ahead =
    state.mismatch && version && state.service && isNewer(state.service, version)
      ? state.service
      : null;
  const [installerProbe, setInstallerProbe] = useState<{
    service: string;
    progress: number | null;
  } | null>(null);
  const [restart, setRestart] = useState<{ from: string; profile: ConnectionProfile } | null>(null);
  const restartingService =
    restart?.profile.url === form.url &&
    restart.profile.fingerprint === form.fingerprint &&
    restart.profile.token === form.token
      ? restart.from
      : null;
  const preparing =
    installerProbe?.service === state.service ? installerProbe.progress : state.preparing;
  const needsInstaller = !!direct && !upgrade;
  const canProbe =
    foreground &&
    !browser &&
    form.mode === 'remote' &&
    !!form.token.trim() &&
    !!window.desktop?.probeService &&
    !upgrading.step &&
    state.status === 'disconnected' &&
    (needsInstaller || !!restartingService);
  // This App instance is tied to one service profile. Stop watching if it goes into the background or its endpoint changes.
  useEffect(() => {
    setInstallerProbe(null);
    setRestart(null);
  }, [form.url, form.fingerprint, form.token]);
  useEffect(() => {
    if (!canProbe) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const deadline = Date.now() + 180_000;
    const poll = (delay: number) => {
      timer = setTimeout(async () => {
        const device = await thisDevice().catch(() => null);
        if (cancelled) return;
        const result = await window
          .desktop!.probeService({
            url: form.url,
            fingerprint: form.fingerprint,
            token: form.token.trim(),
            deviceName: device?.name ?? 'CC Desk Tunnel',
          })
          .catch(() => null);
        if (cancelled) return;
        if (
          result?.status === 'ready' ||
          (result?.status === 'refused' &&
            ((needsInstaller && !!result.release) ||
              (restartingService && result.service !== restartingService)))
        ) {
          setRestart(null);
          // Repeat the real sign-in so this profile's bridge captures the installer digest and credentials.
          void login(form);
          return;
        }
        if (result?.status === 'failed' || (restartingService && Date.now() >= deadline)) {
          setRestart(null);
          setError(
            result?.status === 'failed' ? result.error : '服务端还没有重启好，请稍后重新连接。',
          );
          return;
        }
        const progress = result?.status === 'refused' ? result.preparing : null;
        if (result?.status === 'refused' && result.service)
          setInstallerProbe({ service: result.service, progress });
        poll(restartingService || progress !== null ? 3000 : 15000);
      }, delay);
    };
    poll(restartingService || state.preparing !== null ? 3000 : 15000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [canProbe, needsInstaller, restartingService, form.url, form.fingerprint, form.token]);

  // A check or an upgrade of the service that failed says why to whoever asked for it. The checks a window makes by
  // itself while it is in use fail quietly, to be made again within the hour.
  const live = state.update;
  const asked = useRef(false);
  useEffect(() => {
    if (live?.state === 'failed' && live.detail && asked.current) setError(live.detail);
    if (live && !['checking', 'installing'].includes(live.state)) asked.current = false;
  }, [live]);
  // While the service looks again, the release it found last stays offered.
  const [settled, setSettled] = useState(live);
  useEffect(() => {
    if (live?.state !== 'checking') setSettled(live);
  }, [live]);
  const update =
    live?.state === 'checking' && settled && ['available', 'manual'].includes(settled.state)
      ? settled
      : live;
  // While this window is shown, the service looks for a new release at least hourly (see update-check.ts).
  useEffect(() => {
    if (!host.serviceManagement || !nativeMode || !connected || !workspaceVisible) return;
    const look = () => {
      if (!document.hidden && lookDue(client.state.update, Date.now()))
        void client.request({ type: 'service.update.check' }).catch(() => {});
    };
    look();
    const timer = setInterval(look, UPDATE_TICK_MS);
    document.addEventListener('visibilitychange', look);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', look);
    };
  }, [client, nativeMode, connected, workspaceVisible]);
  // Upgrading the service restarts it. Sessions at work are cut off, so the upgrade asks to be forced past them; an
  // open terminal at rest and background tasks a finished turn left only end. A service before FORCED_UPGRADE_SINCE
  // refuses while anything runs, terminals at rest included, and cannot be forced.
  const working = state.sessions.filter((item) => runWorking(item.activeRun));
  const resting = state.sessions.filter((item) => item.activeRun && !runWorking(item.activeRun));
  const titles = (sessions: Session[]) =>
    sessions
      .slice(0, 3)
      .map((item) => `「${item.title}」`)
      .join('') + (sessions.length > 3 ? ` 等 ${sessions.length} 个会话` : '');
  const forcible =
    !!state.service &&
    state.service.localeCompare(FORCED_UPGRADE_SINCE, undefined, { numeric: true }) >= 0;
  const serviceUpdate = !nativeMode
    ? null
    : update?.state === 'available'
      ? {
          label: `升级服务端到 ${update.latest}${
            working.length
              ? `（${working.length} 个会话正在运行）`
              : !forcible && resting.length
                ? '（先关闭终端、等后台任务结束）'
                : ''
          }`,
          icon: <Download />,
          disabled: busy || (!forcible && (working.length > 0 || resting.length > 0)),
          run: () => {
            const force = working.length > 0;
            const question = force
              ? `${titles(working)}正在运行。\n\n升级会重启服务端：正在进行的回答、命令和等你确认的审批会被中断，可能需要重新开始。\n\n仍然强行升级到 ${update.latest}？`
              : `服务端将升级到 ${update.latest} 并重启，需要几分钟，期间不能发送消息；客户端会自动重连并同步会话。${
                  resting.length
                    ? `\n\n${titles(resting)}开着终端或在等后台任务，它们会被结束；会话本身保留，升级后可以继续。`
                    : ''
                }\n\n继续？`;
            if (window.confirm(question))
              void act(async () => {
                asked.current = true;
                await client.request({
                  type: 'service.update.install',
                  version: update.latest!,
                  ...(force ? { force } : {}),
                });
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
                  asked.current = true;
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
    if (!connected) setMenu(null);
  }, [connected]);
  useEffect(() => {
    if (connected) void window.desktop?.workspaceRoots().then(setWorkspaceRoots);
  }, [connected]);
  // Before the service kept the projects, the computer kept one list for all its connections. A connection there
  // was then hands it to its service once (see `projects:legacy` in electron/main.cjs).
  useEffect(() => {
    if (!connected || !window.desktop || !deviceProjects) return;
    void (async () => {
      const legacy = await window.desktop!.legacyProjects?.(
        profileId,
        state.historyId ?? undefined,
      );
      if (!legacy) return;
      for (const path of legacy.projects) {
        const name = legacy.names[pathKey(path)]?.trim().slice(0, 60);
        await client.request({ type: 'project.add', path, ...(name ? { name } : {}) });
      }
      await window.desktop!.legacyProjectsMoved(
        profileId,
        state.historyId ?? undefined,
        legacy.key,
      );
    })().catch(() => {});
  }, [connected, deviceProjects, profileId, state.historyId]);
  // Each session's native state is read once when it is first shown idle.
  useEffect(() => {
    if (
      !nativeMode ||
      !selected ||
      !connected ||
      history?.loading ||
      selected.activeRun ||
      statusBusy ||
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
    statusBusy,
    rotation.working,
  ]);
  // The browser has no local sessions; before it opens a conversation it shows the quota the service holds, as the
  // desktop account page does. Only the refresh button asks the service to read it anew.
  useEffect(() => {
    if (!connected || signedOut) quotaPrimed.current = null;
    if (
      !inBrowser ||
      !nativeMode ||
      !connected ||
      (selected && !accountOpen) ||
      !quotaSession ||
      state.account?.loggedIn !== true ||
      quota?.rateLimits ||
      refreshing ||
      statusPending.current ||
      quotaPrimed.current === quotaSession.id
    )
      return;
    quotaPrimed.current = quotaSession.id;
    refreshQuota(false);
  }, [
    inBrowser,
    nativeMode,
    connected,
    signedOut,
    selected?.id,
    accountOpen,
    quotaSession?.id,
    state.account?.loggedIn,
    !!quota?.rateLimits,
    refreshing,
  ]);
  useEffect(() => {
    if (nativeMode && connected && state.features.includes('idle-compaction'))
      void client.request({ type: 'compaction.get' }).catch(() => {});
  }, [nativeMode, connected]);
  useEffect(() => {
    if (nativeMode && connected)
      void client.request({ type: serverPool ? 'pool.status' : 'account.status' }).catch(() => {});
  }, [nativeMode, connected, accountOpen, serverPool]);
  useEffect(() => {
    if (nativeMode && connected && state.features.includes('quota-watch'))
      void client.request({ type: 'quota.watch', active: prefs.quotaReads }).catch(() => {});
  }, [nativeMode, connected, prefs.quotaReads, state.features]);
  useEffect(() => {
    if (
      !accountOpen ||
      inBrowser ||
      !nativeMode ||
      !connected ||
      state.capabilities ||
      state.account?.loggedIn !== true ||
      refreshing ||
      rotation.working ||
      statusBusy
    )
      return;
    void refreshStatus(undefined, true);
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
          JSON.stringify([profileId, new URL(form.url).href, form.fingerprint]),
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
      !state.sessions.some((session) => session.activeRun && isHere(session, state.device)) ||
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
    if (inBrowser) {
      webNavigation.visit(next);
      return;
    }
    if (next.sessionId && next.sessionId !== client.state.selectedId) client.select(next.sessionId);
    changePlace(next);
    closeSide();
    if (!record) return;
    const { places, at } = trail.current;
    const last = places[at];
    if (
      last.page === next.page &&
      last.section === next.section &&
      last.settingsIndex === next.settingsIndex &&
      last.sessionId === next.sessionId &&
      last.article === next.article
    )
      return;
    trail.current = { places: [...places.slice(0, at + 1), next].slice(-50), at: 0 };
    trail.current.at = trail.current.places.length - 1;
    setTrailAt(trail.current.at);
  }
  function step(by: number) {
    if (inBrowser) {
      webNavigation.step(by);
      return;
    }
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
    if (inBrowser) return webNavigation.canStep(by);
    const { places } = trail.current;
    for (let at = trail.current.at + by; at >= 0 && at < places.length; at += by)
      if (!places[at].sessionId || state.sessions.some((item) => item.id === places[at].sessionId))
        return true;
    return false;
  };
  const show = (sessionId: string) => visit({ ...place, page: 'chat', sessionId });
  // The help, at an article or its front page; any "?" in the window comes here.
  const showHelp = (article?: string) => visit({ ...place, page: 'help', article });
  useEffect(() => {
    setHelpOpener(showHelp);
    return () => setHelpOpener(null);
  });
  // What an article's button stands for: a setting, or something the window does.
  const runHelp = (target: Target) => {
    if ('article' in target) return showHelp(target.article);
    if ('settings' in target) return open('settings', target.settings);
    if (target.doing === 'schedules') return open('schedules');
    open('chat');
    if (target.doing === 'addProject') void addProject();
    else if (target.doing === 'newSession') void newSession();
    else if (target.doing === 'files' && !prefs.filePanel.open) toggleFiles();
  };
  // A new session with words put in its input box, for the user to change and send.
  async function startWith(text: string) {
    const made = await newSession();
    if (made) {
      setDraft(made, text);
      show(made);
    }
  }
  const open = (page: Page, section: Section = place.section) => {
    if (!host.schedules && page === 'schedules') return;
    if (
      (!host.nativeSettings &&
        ['connection', 'context', 'claude', 'instructions'].includes(section)) ||
      (section === 'connection' && !window.desktop)
    )
      section = 'general';
    visit({ page, section, sessionId: client.state.selectedId });
  };
  // The session in ccdt, signed in as this window is; the window says how to install ccdt where it is missing.
  async function openInCcdt(session: Session) {
    await act(async () => {
      const opened = await window.desktop!.openInCcdt({
        url: form.url,
        fingerprint: form.fingerprint,
        token: form.token,
        sessionId: session.id,
        projectPath: onThis(session) ? session.projectPath : undefined,
      });
      if (opened.status !== 'opened')
        setCcdtNeeded(opened.status === 'outdated' ? { installed: opened.installed } : {});
    });
  }
  // `quota`: asked for on the account page, which reads the plan quota anew.
  async function refreshStatus(
    sessionId = selected?.id ?? sessions[0]?.id,
    quota = false,
    reportError: (error: string | RequestInterruptedError) => void = setError,
  ) {
    if (!sessionId || statusPending.current) return;
    statusPending.current = true;
    setRefreshing(true);
    try {
      await client.request({
        type: 'session.status',
        sessionId,
        ...(quota && client.state.features.includes('quota-watch') ? { quota } : {}),
      });
    } catch (error) {
      reportError(
        error instanceof RequestInterruptedError
          ? error
          : error instanceof Error
            ? error.message
            : '原生状态读取失败',
      );
    } finally {
      statusPending.current = false;
      setRefreshing(false);
    }
  }
  // `quota`: read the plan quota anew (the refresh button); without it the service answers with what it holds.
  function refreshQuota(quota = true) {
    if (!connected || signedOut || !quotaSession || statusPending.current) return;
    setQuotaError(null);
    void refreshStatus(quotaSession.id, quota, (error) =>
      setQuotaError(
        error instanceof RequestInterruptedError
          ? error.describe(client.state.status === 'connected')
          : error,
      ),
    );
  }
  // In a folder of this computer, which becomes a project unless the session is a plain one.
  async function createSession(projectPath: string, plain = false) {
    const response = await client.request({
      type: 'session.create',
      title: '新会话',
      projectPath,
      ...(plain ? { plain } : {}),
    });
    if (response.sessionId) show(response.sessionId);
    return response.sessionId;
  }
  async function createInProject(path: string) {
    await act(async () => {
      await createSession(path);
    });
  }
  // A session in a project of another of the user's computers that is connected.
  async function createElsewhere(deviceId: string, projectPath: string) {
    await act(async () => {
      const response = await client.request({
        type: 'session.create',
        title: '新会话',
        projectPath,
        deviceId,
      });
      if (response.sessionId) show(response.sessionId);
    });
  }
  async function addProject() {
    if (!deviceProjects) {
      setError('请先升级服务端，再添加项目；旧服务端的升级入口仍可使用。');
      return;
    }
    if (!window.desktop?.chooseProject) {
      setCreateOpen(true);
      return;
    }
    await act(async () => {
      const path = await window.desktop!.chooseProject();
      if (path) await client.request({ type: 'project.add', path });
    });
  }
  // The desktop gives an ordinary session a local directory; the browser creates one on the server.
  async function newSession(): Promise<string | undefined> {
    let made: string | undefined;
    if (browser) {
      await act(async () => {
        const response = await client.request({ type: 'server.session.create', title: '新会话' });
        made = response.sessionId;
        if (made) show(made);
      });
      return made;
    }
    if (window.desktop) {
      await act(async () => {
        const directory = await window.desktop!.createWorkspace();
        try {
          made = await createSession(directory, true);
        } catch (error) {
          await window.desktop!.removeWorkspace(directory);
          throw error;
        }
      });
      return made;
    }
    const path =
      (away ? undefined : selected?.projectPath) ?? projects[0]?.path ?? sessions[0]?.projectPath;
    if (path)
      await act(async () => {
        made = await createSession(path);
      });
    else await addProject();
    return made;
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
  // Clears the native goal the same way typing /goal clear would, without wiping the draft.
  async function clearGoal() {
    if (!selected || inputDisabled || !selected.goal) return;
    if (!['active', 'paused'].includes(selected.goal.status)) return;
    if (!window.confirm('清除当前目标？这与发送 /goal clear 相同。')) return;
    const sessionId = selected.id;
    const text = '/goal clear';
    await act(async () => {
      try {
        if (await rotation.sendAfterQuota(selected, text, scenario, true)) return;
        await client.request({
          type: 'message.send',
          sessionId,
          text,
          scenario,
        });
      } catch (error) {
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
      try {
        await client.request({ type: 'run.continue', sessionId });
      } catch (error) {
        // This rejection confirms that no continuation started on the source. Use the same
        // cross-service selection and handoff checks as a new message; never retry a lost ack.
        if (error instanceof RequestRejectedError && error.code === 'pool_unavailable') {
          await rotation.sendAfterQuota(selected, 'continue', 'chat');
          return;
        }
        throw error;
      }
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
    const idle = connected && !busy && !refreshing;
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
              label: '分叉',
              icon: <GitFork />,
              detail:
                session.activeRun?.surface === 'terminal'
                  ? '请先关闭原生终端'
                  : session.activeRun
                    ? state.features.includes('running-session-fork')
                      ? '从最近已完成的一轮分叉，原任务继续运行'
                      : '升级服务端后可在运行中分叉'
                    : undefined,
              disabled:
                !idle ||
                session.activeRun?.surface === 'terminal' ||
                (!!session.activeRun && !state.features.includes('running-session-fork')),
              run: () => {
                void fork(session);
              },
            },
          ]
        : []),
      {
        label: '导出 Markdown',
        icon: <FileDown />,
        disabled: !connected,
        run: () => {
          void act(async () => {
            await exportSession(client, session, profiles.initial);
          });
        },
      },
      {
        label: '重新同步',
        icon: <RefreshCw />,
        disabled: !connected,
        run: () => client.resync(session.id),
      },
      // To a project here or of another connected computer; the browser keeps no projects.
      ...(!browser
        ? [
            {
              label: '移到项目…',
              icon: <FolderSymlink />,
              disabled: !idle || !!session.activeRun,
              run: () => {
                if (menu) setMenu({ ...menu, kind: 'move', sessionId: session.id });
              },
            },
          ]
        : []),
      ...(nativeMode && host.terminalClient
        ? [
            {
              label: '用 ccdt 打开',
              icon: <SquareTerminal />,
              // ccdt takes over a terminal of its own left on the session; a chat run has to end first.
              disabled: !idle || (!!session.activeRun && session.activeRun.surface !== 'terminal'),
              run: () => {
                void openInCcdt(session);
              },
            },
          ]
        : []),
      ...(nativeMode
        ? [
            {
              label: '刷新状态',
              icon: <RefreshCw />,
              disabled: !idle || statusBusy || refreshing || !!history?.loading,
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
        disabled: !connected || !!session.activeRun,
        run: () => {
          setError(null);
          closeSide();
          setDeleteSession(session);
        },
      },
    ];
  }
  // A project of this computer or of another of the user's, connected or not. Only this computer's are pinned,
  // opened or pointed at another folder here; a new session goes into another computer's while it is connected.
  function projectMenu(entry: Project): MenuItem[] {
    const { path } = entry;
    const here = entry.device.id === state.device?.id;
    const key = pathKey(path);
    const pinned = prefs.pinnedProjects.includes(key);
    const reached = state.devices.some((device) => device.id === entry.device.id && device.ready);
    return [
      {
        label: '新建会话',
        icon: <Plus />,
        disabled: !connected || busy || refreshing || (!here && !reached),
        run: () => {
          void (here ? createInProject(path) : createElsewhere(entry.device.id, path));
        },
      },
      ...(here
        ? [
            {
              label: pinned ? '取消置顶' : '置顶',
              icon: pinned ? <PinOff /> : <Pin />,
              run: () =>
                setPrefs((value) => ({
                  ...value,
                  pinnedProjects: toggled(value.pinnedProjects, key),
                })),
            },
          ]
        : []),
      ...(nativeMode && here
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
      {
        label: '修改显示名称',
        icon: <Pencil />,
        disabled: !connected,
        run: () => {
          setError(null);
          setRenameProject(entry);
        },
      },
      ...(here
        ? [
            {
              label: '更改文件夹…',
              icon: <FolderInput />,
              disabled: !connected || busy,
              run: () => {
                if (!window.desktop) return setRepointProject(path);
                void act(async () => {
                  const chosen = await window.desktop!.chooseProject();
                  if (chosen) await repoint(path, chosen);
                });
              },
            },
          ]
        : []),
      ...(here && window.desktop
        ? [
            {
              label: '打开文件夹',
              icon: <FolderOpen />,
              separated: true,
              run: () => {
                void act(() => window.desktop!.openFolder(path));
              },
            },
          ]
        : []),
      // The folder and its sessions stay; the sessions are plain ones until it is a project again.
      {
        label: '移除项目',
        icon: <FolderMinus />,
        danger: true,
        separated: true,
        disabled: !connected || busy,
        run: () => {
          void act(async () => {
            await client.request({ type: 'project.remove', deviceId: entry.device.id, path });
          });
        },
      },
    ];
  }
  // Every project the session could belong to, the one it is in marked. A session of another computer is in
  // none of them, also when a folder here has the same path: moving it into one takes it over.
  function moveMenu(session: Session): MenuItem[] {
    const here = onThis(session);
    return [
      ...projects.map((entry) => ({
        label: projectName(entry),
        detail: entry.path,
        checked: here && pathKey(entry.path) === pathKey(session.projectPath),
        run: () => {
          if (!here || pathKey(entry.path) !== pathKey(session.projectPath))
            void act(async () => {
              await client.request({
                type: 'session.move',
                sessionId: session.id,
                projectPath: entry.path,
              });
            });
        },
      })),
      // The projects of the user's other computers that are connected, under each computer's name.
      ...state.devices
        .filter((device) => device.id !== state.device?.id && !device.server && device.ready)
        .flatMap((device) =>
          state.projects
            .filter((entry) => entry.device.id === device.id)
            .map((entry, index) => ({
              label: projectName(entry),
              detail: `${device.name} · ${entry.path}`,
              separated: index === 0,
              checked:
                session.device?.id === device.id &&
                pathKey(entry.path) === pathKey(session.projectPath),
              run: () => {
                if (
                  session.device?.id !== device.id ||
                  pathKey(entry.path) !== pathKey(session.projectPath)
                )
                  void act(async () => {
                    await client.request({
                      type: 'session.move',
                      sessionId: session.id,
                      projectPath: entry.path,
                      deviceId: device.id,
                    });
                  });
              },
            })),
        ),
      // A folder that is no project yet becomes one with the move.
      {
        label: '其他文件夹…',
        icon: <FolderOpen />,
        separated: true,
        run: () => {
          void takeOver(session);
        },
      },
    ];
  }
  // Points a project at another folder: the service moves it there, its name and place in the list along with its
  // sessions and what Claude Code keeps of it, and this computer's pin follows.
  async function repoint(from: string, to: string) {
    const key = pathKey(from);
    const next = pathKey(to);
    if (key === next) return;
    await client.request({ type: 'project.move', from, to });
    setPrefs((value) => ({
      ...value,
      pinnedProjects: [
        ...new Set(value.pinnedProjects.map((item) => (item === key ? next : item))),
      ],
    }));
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
  // The client's upgrade, from the service or the release page; while one runs, how it goes and a way to stop it.
  const upgradeItems: MenuItem[] = upgrading.step
    ? [
        { label: upgrading.text!, icon: <Download />, disabled: true, run: () => undefined },
        ...(upgrading.cancellable
          ? [{ label: '取消客户端升级', icon: <X />, run: upgrading.cancel }]
          : []),
      ]
    : [upgrade, behind]
        .filter((target): target is string => !!target)
        .map((target) => ({
          label: `${target === upgrade ? '升级客户端到' : '从 GitHub 下载并升级到'} ${target}${working.length ? `（${working.length} 个会话正在运行）` : ''}`,
          icon: <Download />,
          disabled: busy || working.length > 0,
          run: () => upgrading.start(target === upgrade ? undefined : target),
        }));
  // What an upgrade would bring is read where the upgrade is offered, before it is taken.
  const newer =
    upgrade ??
    behind ??
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
    ...upgradeItems,
    ...(serviceUpdate ? [serviceUpdate] : []),
  ];
  // The rail shows its button only for an update that exists, not for the standing offer to look for one.
  const pendingUpdate =
    upgrading.text ??
    (upgrade || behind
      ? `客户端可升级到 ${upgrade ?? behind}`
      : update && ['available', 'manual', 'installing', 'restarting'].includes(update.state)
        ? (serviceUpdate?.label ?? null)
        : null);
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
      run: () => open('settings', 'general'),
    },
    { label: '帮助', icon: <CircleHelp />, run: () => showHelp() },
    {
      label: browser ? '退出登录' : '断开连接',
      icon: <LogOut />,
      separated: true,
      run: disconnect,
    },
  ];
  const toggleSide = () => changeSide(!sideOpen);
  const canCreate = connected && !busy && !refreshing && !rotation.working;
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
                disabled: !connected || busy,
                run: () => {
                  void addProject();
                },
              },
            ]
          : []),
        {
          label: '导出会话…',
          disabled: !selected || !connected,
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
          label: '查找',
          hint: hint('find'),
          disabled: !selected || place.page !== 'chat',
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
        { label: '使用说明', run: () => showHelp() },
        {
          label: '快捷键',
          run: () => open('settings', 'shortcuts'),
        },
        ...(project.url ? [{ label: '项目主页', separated: true, run: openProject }] : []),
        { label: '检查更新', run: () => open('settings', 'about') },
      ],
    },
  ];
  // The shortcuts, as the user set them. A key press that something else already took, or that belongs to an open
  // dialog, is left alone.
  const keys = useRef<(event: KeyboardEvent) => void>(() => {});
  keys.current = (event) => {
    if (!foreground || event.defaultPrevented || document.querySelector('dialog[open]')) return;
    if (event.key === 'Escape' && narrow() && sideOpen) {
      changeSide(false);
      return;
    }
    if (!prefs.shortcuts.enabled) return;
    if (!connected && state.status !== 'reconnecting') return;
    const combo = comboOf(event);
    const action = combo && actions.find((item) => keyFor(prefs, item.id) === combo)?.id;
    if (!action) return;
    const run: Record<Action, (() => void) | false | undefined> = {
      back: () => step(-1),
      forward: () => step(1),
      toggleSide,
      newSession: canCreate && (() => void newSession()),
      settings: () => open('settings'),
      find: !!selected && place.page === 'chat' && (() => setFindRequest((value) => value + 1)),
      // As the mode menu, which a run going on keeps closed.
      cycleMode:
        !!selected &&
        place.page === 'chat' &&
        connected &&
        !busy &&
        !selected.activeRun &&
        (() => void configure({ permissionMode: nextMode(selected.permissionMode) })),
      toggleFiles: filesAvailable && toggleFiles,
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
            restartingService && !error
              ? null
              : currentError && state.mismatch && !upgrade && state.service && version
                ? `${currentError}${
                    isNewer(version, state.service)
                      ? '此客户端较新，请先升级服务端。'
                      : !selfUpdating
                        ? '这个系统上的客户端需要手动升级：请到 GitHub 发布页下载与服务端同一版本的安装包。'
                        : preparing !== null
                          ? `服务端正在下载这一版的安装包（${Math.floor(preparing * 100)}%），好了会出现升级按钮。也可以现在从 GitHub 下载。`
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
          upgrading={upgrading}
          serviceUpgraded={(from) => setRestart({ from, profile: form })}
          connecting={state.status === 'connecting' || proxyConnecting || busy}
          submit={() => {
            void login(form);
          }}
        />
      </>
    );
  const menuSession =
    menu?.kind === 'session' ? state.sessions.find((item) => item.id === menu.sessionId) : null;
  const menuProject =
    menu?.kind === 'project' ? projectOf(state.projects, menu.deviceId, menu.path) : undefined;
  const moved =
    menu?.kind === 'move' ? state.sessions.find((item) => item.id === menu.sessionId) : null;
  const openMenu =
    !menu || (menu.kind === 'session' && !menuSession) || (menu.kind === 'project' && !menuProject)
      ? null
      : menu.kind === 'session'
        ? { label: `会话操作 · ${menuSession!.title}`, items: sessionMenu(menuSession!) }
        : menu.kind === 'project'
          ? { label: `项目操作 · ${menu.path}`, items: projectMenu(menuProject!) }
          : menu.kind === 'move'
            ? {
                label: '会话所在的项目',
                heading: '下一条消息会告诉 Claude 换了项目或电脑；聊过的会话仍沿用原项目的记忆',
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
  const quotaFooter =
    inBrowser && nativeMode ? (
      <QuotaSummary
        quota={quota}
        connected={connected}
        emptyMessage={signedOut ? '尚未登录 Claude' : undefined}
        onOpen={() => open('settings', 'account')}
      />
    ) : undefined;
  return (
    <div
      className={`shell page-${place.page} ${sideOpen ? '' : 'side-closed'} ${selfSigned ? 'web-self-signed' : ''} ${filesOpen ? (filesPage ? 'files-page' : filesOver ? 'files-over' : 'files-open') : ''}`}
      style={filesOpen ? ({ '--file-width': `${filesShownWidth}px` } as CSSProperties) : undefined}
      data-settings-index={place.settingsIndex || undefined}
      {...drawerSwipe}
    >
      {selfSigned && <CertificateWarning />}
      <TitleBar
        title={
          place.page === 'chat'
            ? (selected?.title ?? 'CC Desk Tunnel')
            : place.page === 'schedules'
              ? '定时任务'
              : place.page === 'help'
                ? '帮助'
                : place.settingsIndex && narrow()
                  ? '设置'
                  : inBrowser && place.section === 'account'
                    ? '订阅用量'
                    : (sections.find((item) => item.id === place.section)?.name ?? '设置')
        }
        back={
          !inBrowser && narrow() && place.page === 'settings'
            ? () => (place.settingsIndex ? open('chat') : visit({ ...place, settingsIndex: true }))
            : stepAvailable(-1)
              ? () => step(-1)
              : undefined
        }
        forward={stepAvailable(1) ? () => step(1) : undefined}
        sideOpen={sideOpen}
        toggleSide={toggleSide}
        menus={barMenus}
        openMenu={(item, position) => setMenu({ kind: 'bar', label: item.label, ...position })}
        connected={connected}
        adapterName={connectionName}
        files={
          filesAvailable
            ? { open: filesOpen, toggle: toggleFiles, hint: hint('toggleFiles') }
            : undefined
        }
      />
      <Rail
        accountPool={serverPool ? () => open('settings', 'account') : undefined}
        page={place.page}
        go={(page) => {
          if (narrow() && page === 'chat' && place.page === 'chat') return;
          open(page);
          if (narrow() && page === 'chat') changeSide(true);
        }}
        schedules={host.schedules}
        update={host.serviceManagement ? pendingUpdate : null}
        openUpdate={(position) => setMenu({ kind: 'update', ...position })}
        openSettings={(position) =>
          narrow()
            ? visit({ ...place, page: 'settings', settingsIndex: true })
            : setMenu({ kind: 'settings', ...position })
        }
      />
      {rotation.notice && (
        <div className="pool-notice" role="status">
          <span>{rotation.notice}</span>
          <IconButton title="关闭提示" onClick={rotation.dismissNotice}>
            <X aria-hidden="true" />
          </IconButton>
        </div>
      )}
      <button className="sidebar-shade" aria-label="收起侧栏" onClick={() => changeSide(false)} />
      {place.page === 'settings' ? (
        <SettingsPage
          client={client}
          browser={!!browser}
          disconnect={disconnect}
          section={place.section}
          indexOnly={narrow() && !!place.settingsIndex}
          go={(section) => open('settings', section)}
          native={nativeMode}
          here={state.devices.find((device) => device.id === state.device?.id)}
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
                usageOnly={!!browser}
                quotaUnavailable={
                  inBrowser && !state.sessions.length ? '开始会话后可读取额度' : undefined
                }
                client={client}
                account={nativeMode ? state.account : null}
                capabilities={signedOut ? null : capabilities}
                quota={signedOut ? null : quota}
                refreshing={refreshing}
                disabled={
                  !state.sessions.length ||
                  !connected ||
                  refreshing ||
                  (anyTerminal && !state.features.includes('terminal-quota')) ||
                  rotation.working
                }
                error={inBrowser ? quotaError : currentError}
                refresh={() => {
                  if (inBrowser) refreshQuota();
                  else void refreshStatus(undefined, true);
                }}
              />
            )
          }
        />
      ) : place.page === 'help' ? (
        <Suspense fallback={null}>
          <HelpCenter
            article={place.article}
            here={state.device?.name ?? '这台电脑'}
            others={onlineOthers}
            browser={!!browser}
            version={version || state.service || ''}
            go={showHelp}
            run={runHelp}
            tryPrompt={host.localProjects ? (text) => void startWith(text) : undefined}
          />
        </Suspense>
      ) : place.page === 'schedules' ? (
        <SchedulePanel
          schedules={schedules}
          sessions={sessions}
          projects={projects.map((entry) => entry.path)}
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
            projects={state.projects}
            localProjects={host.localProjects}
            connected={connected}
            busy={busy}
            refreshing={refreshing}
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
            hereId={state.device?.id}
            createElsewhere={
              browser || !deviceProjects
                ? undefined
                : (deviceId, path) => {
                    void createElsewhere(deviceId, path);
                  }
            }
            sessionMenu={(session, position) =>
              setMenu({ kind: 'session', sessionId: session.id, ...position })
            }
            projectMenu={
              browser
                ? undefined
                : (entry, position) =>
                    setMenu({
                      kind: 'project',
                      deviceId: entry.device.id,
                      path: entry.path,
                      ...position,
                    })
            }
            footer={quotaFooter}
          />
          <main className="workspace">
            {selected?.forkSnapshot && dismissedFork !== selected.id && (
              <div className="session-account-strip" role="status">
                <span>
                  分叉快照：本轮进行中内容未复制，创建分叉不会停止原任务。项目文件夹仍共享。
                  {selected.forkSnapshot.throughSequence === 0 &&
                    '尚无已完成对话，请发送新消息开始。'}
                  {!selected.forkSnapshot.native &&
                    selected.forkSnapshot.throughSequence > 0 &&
                    nativeMode &&
                    '首次发送将携带最近对话摘录。'}
                </span>
                {state.sessions.some((item) => item.id === selected.forkSnapshot!.sourceId) && (
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => show(selected.forkSnapshot!.sourceId)}
                  >
                    查看原会话
                  </button>
                )}
                <IconButton title="关闭分叉提示" onClick={() => setDismissedFork(selected.id)}>
                  <X />
                </IconButton>
              </div>
            )}
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
            {selected && profiles.profiles.length > 1 && !profiles.pool.config.enabled && (
              <div className="session-account-strip">
                <span>当前服务器：{form.name}</span>
                <select
                  aria-label="续接到服务器"
                  value=""
                  disabled={
                    controlsDisabled || away || sessions.some((session) => !!session.activeRun)
                  }
                  // Polling is off without the pool, so read the targets' cached quotas when the picker opens.
                  onFocus={() => void profiles.pool.refresh(undefined, true, true)}
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
                    .map((profile) => {
                      const quota = profiles.pool.quotas[profile.id];
                      const blocked = quotaBlock(quota);
                      const used = fiveHour(quota)?.utilization;
                      const note = blocked
                        ? `（${blocked}）`
                        : quota?.limits?.available && !quota.error && typeof used === 'number'
                          ? `（5 小时剩余 ${Math.max(0, Math.round(100 - used))}%）`
                          : '';
                      return (
                        <option key={profile.id} value={profile.id} disabled={!!blocked}>
                          {profile.name}
                          {note}
                        </option>
                      );
                    })}
                </select>
              </div>
            )}
            {serverPool && (
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
              openInFiles={filesAvailable ? openInFiles : undefined}
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
              suggestions={
                !selected || controlsDisabled || away || inputDisabled
                  ? undefined
                  : suggestions({
                      project: !!projectIn(selected!),
                      other: onlineOthers[0],
                      schedules: host.schedules,
                    })
              }
              suggest={(text) => setDraft(selected!.id, text)}
              moreExamples={() => showHelp()}
              edit={
                controlsDisabled || away || !!linkedHistory
                  ? undefined
                  : (id, text, deliveryStatus) => {
                      // Only a confirmed non-delivery can be resent in place. A missing receipt is not proof.
                      if (deliveryStatus === 'not_sent') {
                        if (draft && draft !== text) {
                          setError('输入框里还有草稿，请先发送或清空，再编辑这条未送达的消息。');
                          return;
                        }
                        setError(null);
                        setDraft(selected!.id, text);
                        return;
                      }
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
              replyApproval={async (runId, approvalId, allowed, answers, plan) => {
                let sent = false;
                await act(async () => {
                  await client.request({
                    type: 'approval.reply',
                    sessionId: selected!.id,
                    runId,
                    approvalId,
                    allowed,
                    ...(answers ? { answers } : {}),
                    ...(plan && (state.serviceProtocol ?? 0) >= 28 ? { plan } : {}),
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
                  里也有会话在这个文件夹运行，两边同时改动文件可能互相覆盖。
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
                    。在这里的对话、审批和停止都作用于那台电脑，命令也在那里执行。
                  </p>
                ) : (
                  <p>
                    这个会话在设备“{selected.device?.name ?? '未知设备'}”上，项目目录是{' '}
                    <code>{selected.projectPath}</code>
                    。那台电脑不在线，这里只能查看，它上线后可以直接操作。
                  </p>
                )}
                <button
                  type="button"
                  className="button primary"
                  disabled={controlsDisabled}
                  onClick={(event) => {
                    // With projects here the session goes into one of them, or into a folder chosen there.
                    if (!projects.length) return void takeOver(selected);
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
                  <button
                    type="button"
                    className="text-link session-goal-clear"
                    disabled={inputDisabled}
                    title={
                      inputDisabled ? '当前无法发送，请稍后再清除' : '清除目标（等同 /goal clear）'
                    }
                    onClick={() => {
                      void clearGoal();
                    }}
                  >
                    清除目标
                  </button>
                </div>
              )}
            {nativeMode && selected && !selected.activeRun && (!away || remote) && (
              <IdleReminder
                events={events}
                settings={state.compaction}
                canCompact={canCompact && !controlsDisabled}
                compact={() => {
                  void compact();
                }}
                startFresh={() => {
                  if (onThis(selected)) void createInProject(selected.projectPath);
                  else void newSession();
                }}
              />
            )}
            {selected && (!away || remote) && (
              <Composer
                openAccount={() => open('settings', 'account')}
                session={selected}
                projectName={projectIn(selected) ? projectName(projectIn(selected)!) : null}
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
                quota={quota}
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
                recoverQueue={
                  !controlsDisabled &&
                  !away &&
                  state.features.includes('cross-server-queue-recovery') &&
                  !linkedHistory?.forward
                    ? () => {
                        if (
                          !window.confirm(
                            '请先确认其他服务器没有正在执行的续接会话。恢复后原消息仍保持暂停，不会自动发送；你可以检查、删除或继续队列。恢复原队列？',
                          )
                        )
                          return;
                        void act(async () => {
                          const archive = await sharedHistory(
                            historyKey(profiles.initial, selected.id),
                          );
                          if (archive?.forward)
                            throw new Error(
                              '已找到续接会话，请点击“前往当前会话”，不要恢复原队列。',
                            );
                          await client.request({
                            type: 'session.handoff.cancel',
                            sessionId: selected.id,
                            queueIds: selected.messageQueue!.items.map((item) => item.id),
                          });
                        });
                      }
                    : undefined
                }
                send={(text, mode) => {
                  void send(text, mode);
                }}
                resume={stopped && !inputDisabled ? resume : undefined}
                compact={() => {
                  void compact();
                }}
                refresh={() => {
                  void refreshStatus(undefined, true);
                }}
                configure={configure}
                stop={stopRun}
              />
            )}
            {selected && (!away || (browser && remote)) && (
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
                      : (quota?.rateLimits ?? null),
                  error: serverPool ? sessionAccount?.error : quota?.error,
                }}
                openAccount={() => open('settings', 'account')}
              />
            )}
          </main>
          {filesOpen && (
            <aside className="file-column" aria-label="文件">
              {!filesPage && (
                <div
                  className="file-resizer"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="调整文件面板宽度"
                  onPointerDown={resizeFiles}
                />
              )}
              <FilePanel
                places={filesPlaces}
                start={filesStart}
                sessionKey={selected?.id ?? ''}
                info={state.files}
                layout={filesPage ? 'page' : filesShownWidth < 620 ? 'narrow' : 'wide'}
                setPage={setFilesPage}
                close={toggleFiles}
                noticeKey={profileId}
                profileId={profileId}
                project={selected && onThis(selected) ? selected.projectPath : null}
                request={filesRequest}
                aliasOf={nativeLabels(state.projects, state.sessions)}
              />
            </aside>
          )}
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
              await client.request({ type: 'project.add', path });
              setCreateOpen(false);
            });
          }}
        />
      )}
      {rotation.confirmation && (
        <HandoffConfirmDialog
          text={rotation.confirmation.text}
          answer={rotation.confirmation.answer}
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
              if (onThis(deleteSession) && !projectIn(deleteSession))
                void window.desktop?.removeWorkspace(deleteSession.projectPath);
              setDeleteSession(null);
            });
          }}
        />
      )}
      {renameProject && (
        <RenameProjectDialog
          path={renameProject.path}
          name={renameProject.name ?? ''}
          busy={busy}
          connected={connected}
          error={actionError}
          close={() => setRenameProject(null)}
          rename={(name) => {
            void act(async () => {
              await client.request({
                type: 'project.rename',
                deviceId: renameProject.device.id,
                path: renameProject.path,
                name,
              });
              setRenameProject(null);
            });
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
      {ccdtNeeded && (
        <CcdtDialog
          installed={ccdtNeeded.installed}
          version={version}
          close={() => setCcdtNeeded(null)}
        />
      )}
      {notesDialog}
      {state.setupToken && (
        <SetupTokenDialog
          result={state.setupToken}
          close={() => client.update({ setupToken: null })}
        />
      )}
    </div>
  );
}
