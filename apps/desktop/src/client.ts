import {
  continues,
  isFragment,
  PROTOCOL_VERSION,
  clientServerMessageSchema,
  fallbackServerProtocol,
} from '@cc-desk-tunnel/protocol';
import type { EventPayload, HistoryPage } from '@cc-desk-tunnel/protocol';
import { HistoryCache } from './historyCache.ts';
import type { Range } from './historyCache.ts';
import type {
  AccountState,
  SetupTokenResult,
  Command,
  Device,
  IdleCompaction,
  NativeCapabilities,
  NativeMetrics,
  AccountQuota,
  ClientServerMessage as ServerMessage,
  Project,
  ServiceUpdate,
  Session,
  SessionEvent,
  ServerPoolState,
} from '@cc-desk-tunnel/protocol';

type Response = Extract<ServerMessage, { type: 'response' }>;
// What a page from the service holds whole: every event of the session in (after, through].
function covered(page: HistoryPage, command?: NewCommand): Range {
  if (command?.type === 'session.subscribe' && page.mode === 'append')
    return [command.afterSequence ?? 0, page.lastSequence];
  if (command?.type === 'session.history' && page.mode === 'prepend')
    return [
      page.hasEarlier ? page.firstSequence - 1 : (command.afterSequence ?? 0),
      command.beforeSequence - 1,
    ];
  if (page.mode === 'replace')
    return [page.hasEarlier ? page.firstSequence - 1 : 0, page.lastSequence];
  return [0, 0];
}
type DataMessage = Extract<
  ServerMessage,
  {
    type:
      | 'usage.summary'
      | 'usage.page'
      | 'session.stats'
      | 'settings.state'
      | 'compaction.state'
      | 'instructions.state'
      | 'session.snapshot'
      | 'web.settings.state'
      | 'web.totp.setup'
      | 'web.certificate.state';
  }
>;
// Commands answered with a data frame, and the frame each one gets.
type Replies = {
  'session.subscribe': 'session.snapshot';
  'session.history': 'session.snapshot';
  'usage.summary': 'usage.summary';
  'usage.query': 'usage.page';
  'session.stats': 'session.stats';
  'settings.get': 'settings.state';
  'settings.update': 'settings.state';
  'compaction.get': 'compaction.state';
  'compaction.update': 'compaction.state';
  'instructions.get': 'instructions.state';
  'instructions.update': 'instructions.state';
  'web.settings.get': 'web.settings.state';
  'web.settings.update': 'web.settings.state';
  'web.sessions.revoke': 'web.settings.state';
  'web.totp.setup': 'web.totp.setup';
  'web.totp.enable': 'web.settings.state';
  'web.totp.disable': 'web.settings.state';
  'web.certificate.get': 'web.certificate.state';
  'web.certificate.set': 'web.certificate.state';
  'web.certificate.reset': 'web.certificate.state';
};

type NewCommand = Command extends infer C
  ? C extends Command
    ? C extends { type: 'session.history' }
      ? Omit<C, 'requestId' | 'afterSequence'> & { afterSequence?: number }
      : Omit<C, 'requestId'>
    : never
  : never;
// Android supplies a pinned native TLS socket; the desktop/browser keep their existing transport.
export type ClientSocket = Pick<
  WebSocket,
  'readyState' | 'onopen' | 'onmessage' | 'onclose' | 'onerror' | 'send' | 'close'
>;
// Losing a reply says nothing about whether the operation reached the service. Keep that uncertainty
// separate from the current connection state, which can recover while the warning is still displayed.
export class RequestRejectedError extends Error {
  readonly code: string | undefined;
  constructor(code: string | undefined, message: string) {
    super(message);
    this.code = code;
  }
}
export class RequestInterruptedError extends Error {
  readonly readOnly: boolean;
  constructor(type: Command['type']) {
    const readOnly = [
      'session.subscribe',
      'session.history',
      'session.status',
      'account.status',
      'pool.status',
      'usage.summary',
      'usage.query',
      'quota.watch',
      'session.stats',
      'settings.get',
      'compaction.get',
      'instructions.get',
      'web.settings.get',
      'web.certificate.get',
      'service.update.check',
    ].includes(type);
    super(
      readOnly
        ? '连接中断，上次读取未完成；连接恢复后可重试。'
        : '连接中断；上次请求的确认未收到。任务可能仍在运行，请查看会话历史确认结果；不会自动重发。',
    );
    this.name = 'RequestInterruptedError';
    this.readOnly = readOnly;
  }
  describe(connected: boolean) {
    if (!connected) return this.message;
    return this.readOnly
      ? '连接已恢复；上次读取未完成，请重试。'
      : '连接已恢复；上次请求的确认因断线未收到。任务可能仍在运行，请查看会话历史确认结果；不会自动重发。';
  }
}
export class RequestTimeoutError extends Error {}

export type HistoryState = {
  firstSequence: number;
  lastSequence: number;
  hasEarlier: boolean;
  loading: boolean;
  loadingEarlier: boolean;
  // Live events received after a failed snapshot must not advance a cursor past missing history.
  needsReload?: boolean;
};
export type ClientState = {
  status: 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
  // Retry progress belongs to the connection, not to a request that must never be replayed.
  retry: { attempt: number; nextAt: number | null } | null;
  connectionId: string | null;
  // The computer this client signed in as; a session's commands run on the one it is on.
  device: Device | null;
  browser: Extract<ServerMessage, { type: 'ready' }>['browser'] | null;
  // The service's files as the file panel reaches them, where it offers them (see FilePanel.tsx).
  files: NonNullable<Extract<ServerMessage, { type: 'ready' }>['files']> | null;
  // The user's computers connected to the service now, and whether commands reach each yet. Another
  // computer's sessions can be worked on from here while it is listed and ready.
  devices: ConnectedDevice[];
  sessions: Session[];
  // The projects of all the user's computers, as the service keeps them.
  projects: Project[];
  events: Record<string, SessionEvent[]>;
  // Output a run is in the middle of, as far as it has arrived. It has no place in the history yet: the
  // event that records it takes its place.
  live: Record<string, SessionEvent>;
  history: Record<string, HistoryState>;
  selectedId: string | null;
  error: string | null;
  adapter: 'simulation' | 'claude-code';
  // The Windows installer version the service offers, if any.
  release: string | null;
  // The service's version and where it stands against the published releases, if it follows them.
  service: string | null;
  serviceProtocol: number | null;
  historyId: string | null;
  features: string[];
  pool: ServerPoolState | null;
  update: ServiceUpdate | null;
  // The service refused this client for its version; it may still hand out an installer.
  mismatch: boolean;
  // How much of the installer of its own version the service has fetched so far, from 0 to 1, while it is
  // still fetching it.
  preparing: number | null;
  model: string | null;
  // The latest capabilities from any session, for views that are not tied to the selected one.
  capabilities: NativeCapabilities | null;
  // The plan quota the service holds for its account, as `ready` and each `quota` since gave it. It is the
  // account's: no session's events carry it. Kept while disconnected, as the last reading.
  quota: AccountQuota | null;
  accountQuotas: Record<string, AccountQuota>;
  metrics: NativeMetrics | null;
  account: AccountState | null;
  // A newly generated token is held only until its one-time dialog closes or this connection ends.
  setupToken: SetupTokenResult | null;
  // The service's idle compaction setting, as it last said; every window is told when it changes.
  compaction: IdleCompaction | null;
  // What each session's background tasks last said of themselves, by task: kept while the window is open
  // and nowhere else.
  progress: Record<string, Record<string, TaskProgress>>;
};
export type TaskProgress = Extract<EventPayload, { type: 'native.progress' }>;
export type ConnectedDevice = Extract<ServerMessage, { type: 'devices' }>['devices'][number];

// The renderer's single connection and its state store: components read `state` through subscribe / getSnapshot
// and send commands with request(). A connection that breaks is made again, for as long as it takes, and what
// was missed is read from the service's record; nothing is resent automatically.
export class ProxyClient {
  state: ClientState = {
    status: 'disconnected',
    retry: null,
    connectionId: null,
    device: null,
    browser: null,
    files: null,
    devices: [],
    sessions: [],
    projects: [],
    events: {},
    live: {},
    history: {},
    selectedId: null,
    error: null,
    adapter: 'simulation',
    release: null,
    service: null,
    serviceProtocol: null,
    historyId: null,
    features: [],
    pool: null,
    update: null,
    mismatch: false,
    preparing: null,
    model: null,
    capabilities: null,
    quota: null,
    accountQuotas: {},
    metrics: null,
    account: null,
    setupToken: null,
    compaction: null,
    progress: {},
  };
  results = new Map<string, DataMessage>();
  private historyParts = new Map<
    string,
    {
      sessionId: string;
      total: number;
      next: number;
      size: number;
      parts: string[];
      done?: boolean;
    }
  >();
  listeners = new Set<() => void>();
  socket: ClientSocket | null = null;
  credentials: {
    url: string;
    token: string;
    device: Device | null;
    browser?: () => void;
    validate?: () => Promise<boolean>;
    reconnect: boolean;
    // Remote mode: opens the bridge in the main process and resolves to its address. A bridge serves one
    // connection, so every attempt asks for a new one.
    bridge?: () => Promise<string>;
    transport?: () => ClientSocket;
    cacheScope?: string;
  } | null = null;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
  retryAttempt = 0;
  // Whether this sign-in has stood once. Until then a failure is the user's to look at; after it, a fault on
  // the way is tried again.
  private established = false;
  // Tells the answer of the bridge asked for last from those of earlier attempts.
  private turn = 0;
  // Streamed events and fragments are taken in batches, in the order they came, so a fast reply does not
  // re-render per fragment.
  streamTimer: ReturnType<typeof setTimeout> | undefined;
  streamEvents: (SessionEvent | Extract<ServerMessage, { type: 'session.fragment' }>)[] = [];
  // Event history is kept for the most recently viewed sessions only.
  cacheOrder: string[] = [];
  private historyEpoch = new Map<string, object>();
  // When something last came from each session's run, by the service's clock, for telling a run that goes on
  // from one that has been quiet for long. Readings of the context and the quota repeat through a long turn
  // and say nothing of it.
  private activity = new Map<string, number>();
  // How far this computer's clock is ahead of the service's, as near as the fastest event yet shows.
  private ahead = Infinity;
  serviceNow = () => Date.now() - (Number.isFinite(this.ahead) ? this.ahead : 0);
  activityAt = (sessionId: string) => this.activity.get(sessionId) ?? 0;
  pending = new Map<
    string,
    {
      resolve: (response: Response) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      type: Command['type'];
      capture: boolean;
      sessionId?: string;
      renew?: () => void;
      progress?: (received: number, total: number) => void;
      parts?: string[];
      following?: ServerMessage[];
      done?: Promise<Response>;
      command?: NewCommand;
    }
  >();
  // The history read before, kept on disk; and the sessions being shown from it while the service is asked.
  disk = new HistoryCache();
  private opening = new Map<string, Promise<void>>();
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  update(values: Partial<ClientState>) {
    this.state = { ...this.state, ...values };
    for (const listener of this.listeners) listener();
  }
  connect(
    url: string,
    token: string,
    device: Device,
    reconnect = true,
    bridge?: () => Promise<string>,
    cacheScope = url,
  ) {
    const address = new URL(url);
    if (
      !['ws:', 'wss:'].includes(address.protocol) ||
      address.username ||
      address.password ||
      address.search ||
      address.hash
    )
      throw new Error('请输入不含凭据的 WebSocket 服务地址。');
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname) ||
      address.protocol !== 'ws:'
    )
      throw new Error('当前离线原型仅连接本机环回服务。');
    if (token.trim().length < 24) throw new Error('服务凭据至少 24 个字符。');
    this.start({
      url: address.toString(),
      token: token.trim(),
      device,
      reconnect,
      bridge,
      cacheScope,
    });
  }
  // A controller has its own identity and never claims the project's computer or opens a tunnel.
  // Its native transport supplies the credential without exposing it to the page.
  connectController(device: Device, transport: () => ClientSocket) {
    this.start({ url: '', token: '', device, reconnect: true, transport });
  }
  private start(credentials: NonNullable<ProxyClient['credentials']>) {
    this.disconnect();
    this.credentials = credentials;
    this.disk = new HistoryCache(`history:${credentials.cacheScope ?? credentials.url}`);
    this.opening.clear();
    const device = credentials.device;
    this.established = false;
    this.cacheOrder = [];
    this.historyEpoch.clear();
    this.update({
      status: 'connecting',
      device,
      browser: null,
      files: null,
      projects: [],
      devices: [],
      error: null,
      release: null,
      service: null,
      serviceProtocol: null,
      historyId: null,
      features: [],
      pool: null,
      update: null,
      mismatch: false,
      preparing: null,
      sessions: [],
      events: {},
      live: {},
      history: {},
      selectedId: null,
      capabilities: null,
      quota: null,
      accountQuotas: {},
      metrics: null,
      account: null,
      compaction: null,
    });
    this.open();
  }
  // The browser has an HttpOnly session, not a desktop identity or execution channel.
  connectBrowser(url: string, expired: () => void, validate?: () => Promise<boolean>) {
    const address = new URL(url);
    const expected = location.protocol === 'https:' ? 'wss:' : 'ws:';
    if (
      address.protocol !== expected ||
      address.host !== location.host ||
      address.username ||
      address.password ||
      address.search ||
      address.hash
    )
      throw new Error('浏览器只能连接当前服务。');
    this.disconnect();
    this.disk = new HistoryCache(`history:${address.href}`);
    this.opening.clear();
    this.credentials = {
      url: address.href,
      token: '',
      device: null,
      reconnect: true,
      browser: expired,
      validate,
    };
    this.established = false;
    this.cacheOrder = [];
    this.historyEpoch.clear();
    this.update({
      status: 'connecting',
      device: null,
      browser: null,
      files: null,
      projects: [],
      devices: [],
      error: null,
      sessions: [],
      events: {},
      live: {},
      history: {},
      selectedId: null,
    });
    this.open();
  }
  private open(protocolVersion: number = PROTOCOL_VERSION) {
    const credentials = this.credentials;
    if (!credentials) return;
    if (this.state.status === 'reconnecting')
      this.update({ retry: { attempt: (this.state.retry?.attempt ?? 0) + 1, nextAt: null } });
    if (credentials.browser && credentials.validate) {
      const turn = ++this.turn;
      const current = () => this.credentials === credentials && this.turn === turn;
      void credentials.validate().then(
        (authenticated) => {
          if (!current()) return;
          if (authenticated) this.attach(credentials, protocolVersion);
          else {
            this.credentials = null;
            this.update({ status: 'disconnected', connectionId: null });
            credentials.browser!();
          }
        },
        () => {
          if (!current()) return;
          this.update({
            status: 'reconnecting',
            connectionId: null,
            devices: [],
            error: '暂时无法连接服务，正在重试。',
          });
          this.retryTimer = setTimeout(
            () => {
              this.retryTimer = undefined;
              this.open();
            },
            Math.min(1000 * 2 ** this.retryAttempt++, 5000),
          );
        },
      );
      return;
    }
    if (!credentials.bridge) {
      this.attach(credentials, protocolVersion);
      return;
    }
    const turn = ++this.turn;
    const current = () => this.credentials === credentials && this.turn === turn;
    credentials.bridge().then(
      (url) => {
        if (!current()) return;
        credentials.url = url;
        this.attach(credentials, protocolVersion);
      },
      // The bridge could not even be set up on this computer: nothing a later attempt would change.
      (error) => {
        if (!current()) return;
        this.credentials = null;
        this.update({
          status: 'disconnected',
          retry: null,
          connectionId: null,
          error: error instanceof Error ? error.message : '本机连接准备失败。',
        });
      },
    );
  }
  private attach(credentials: NonNullable<ProxyClient['credentials']>, protocolVersion: number) {
    const socket = credentials.transport?.() ?? new WebSocket(credentials.url);
    this.socket = socket;
    let ready = false;
    let fallback: number | null = null;
    const timeout = setTimeout(() => socket.close(), 50000);
    socket.onopen = () => {
      if (this.socket !== socket || this.credentials !== credentials) return;
      if (credentials.browser) {
        socket.send(JSON.stringify({ type: 'web.auth', protocolVersion: PROTOCOL_VERSION }));
        return;
      }
      socket.send(
        JSON.stringify({
          type: 'auth',
          protocolVersion,
          token: credentials.token,
          deviceName: credentials.device!.name,
        }),
      );
      socket.send(JSON.stringify({ type: 'device', id: credentials.device!.id }));
    };
    socket.onmessage = ({ data }) => {
      if (this.socket !== socket) return;
      let message: ServerMessage;
      try {
        message = clientServerMessageSchema.parse(JSON.parse(data));
        if (message.type === 'ready' && message.protocolVersion !== protocolVersion)
          throw new Error('Unexpected service protocol');
      } catch {
        this.update({ error: '服务消息格式不兼容，已断开连接。' });
        this.credentials = null;
        socket.close();
        return;
      }
      receive(message);
    };
    const receive = (message: ServerMessage) => {
      if (message.type === 'session.history.part') {
        const request = this.pending.get(message.requestId);
        if (
          !request ||
          !['session.subscribe', 'session.history'].includes(request.type) ||
          request.sessionId !== message.sessionId
        )
          return;
        request.renew?.();
        request.parts ??= [];
        request.parts.push(message.data);
        if (request.parts.length > 4096) {
          this.update({ error: '历史单页过大，已停止读取，请检查服务端。' });
          this.credentials = null;
          socket.close();
          return;
        }
        socket.send(JSON.stringify({ type: 'session.history.next', requestId: message.requestId }));
        if (!message.last) return;
        const partSessionId = message.sessionId;
        const following = request.following ?? [];
        let page: ServerMessage[];
        try {
          if (request.parts.length > 4096) throw new Error('History page too large');
          page = JSON.parse(request.parts.join('')).map((value: unknown) =>
            clientServerMessageSchema.parse(value),
          );
          if (
            page[0]?.type !== 'session.snapshot' ||
            page[0].requestId !== message.requestId ||
            page[0].session.id !== message.sessionId ||
            page.some(
              (item, index) =>
                index > 0 && (item.type !== 'session.fragment' || item.sessionId !== partSessionId),
            )
          )
            throw new Error('History page does not match request');
        } catch {
          this.update({ error: '历史消息格式不兼容，已断开连接。' });
          this.credentials = null;
          socket.close();
          return;
        }
        request.parts = undefined;
        request.following = undefined;
        for (const item of [...page, ...following]) receive(item);
        return;
      }
      if (message.type === 'session.deleted') this.cancelHistory(message.sessionId);
      // A subscribing snapshot replaces live state. Preserve the events which followed its
      // captured boundary until the whole snapshot and its unfinished fragment have arrived.
      const sessionId =
        message.type === 'session.event'
          ? message.event.sessionId
          : message.type === 'session.updated'
            ? message.session.id
            : message.type === 'session.fragment'
              ? message.sessionId
              : undefined;
      if (sessionId) {
        const reading = [...this.pending.values()].find(
          (request) =>
            request.type === 'session.subscribe' &&
            request.sessionId === sessionId &&
            request.parts,
        );
        if (reading) {
          (reading.following ??= []).push(message);
          return;
        }
      }
      if (message.type === 'session.snapshot.part') {
        const requestId = message.requestId;
        const pending = this.pending.get(requestId);
        if (!pending || !['session.subscribe', 'session.history'].includes(pending.type)) return;
        try {
          let part = this.historyParts.get(requestId);
          if (!part && message.index === 0) {
            part = {
              sessionId: message.sessionId,
              total: message.total,
              next: 0,
              size: 0,
              parts: [],
            };
            this.historyParts.set(requestId, part);
          }
          if (
            !part ||
            part.done ||
            pending.sessionId !== message.sessionId ||
            part.sessionId !== message.sessionId ||
            part.total !== message.total ||
            part.next !== message.index
          )
            throw new Error('历史分片顺序不一致，请重试读取。');
          part.parts.push(message.data);
          part.size += message.data.length;
          if (part.size > 128 * 1024 * 1024)
            throw new Error('单页历史过大，请保留原会话并检查服务端。');
          part.next++;
          pending.renew?.();
          pending.progress?.(part.next, part.total);
          if (part.next < part.total) return;
          const complete = clientServerMessageSchema.parse(JSON.parse(part.parts.join('')));
          if (
            complete.type !== 'session.snapshot' ||
            complete.requestId !== requestId ||
            complete.session.id !== part.sessionId
          )
            throw new Error('历史分片内容不一致，请重试读取。');
          part.parts = [];
          part.done = true;
          message = complete;
        } catch (error) {
          clearTimeout(pending.timer);
          this.pending.delete(requestId);
          this.results.delete(requestId);
          this.historyParts.delete(requestId);
          pending.reject(
            new RequestRejectedError('history_invalid', '历史分片读取失败，请重试读取。'),
          );
          return;
        }
      }
      if (message.type === 'ready') {
        ready = true;
        if (
          message.adapter === 'claude-code' &&
          !credentials.bridge &&
          !credentials.browser &&
          !credentials.transport
        )
          credentials.reconnect = false;
        this.established = true;
        clearTimeout(timeout);
        this.retryAttempt = 0;
        const historyChanged = this.state.historyId !== (message.historyId ?? null);
        if (historyChanged) this.update({ events: {}, live: {}, history: {} });
        const selectedId = message.sessions.some((session) => session.id === this.state.selectedId)
          ? this.state.selectedId
          : null;
        this.update({
          status: 'connected',
          retry: null,
          connectionId: message.connectionId,
          browser: message.browser ?? null,
          files: message.files ?? null,
          sessions: message.sessions,
          projects: message.projects ?? [],
          selectedId,
          error: null,
          adapter: message.adapter,
          release: message.client?.version ?? null,
          service: message.version,
          serviceProtocol: message.protocolVersion,
          historyId: message.historyId ?? null,
          features: message.features ?? [],
          pool: null,
          mismatch: false,
          update: message.update ?? null,
          model: message.model ?? null,
          quota: message.quota ?? null,
          accountQuotas: message.quota
            ? { [message.quota.accountId ?? 'default']: message.quota }
            : {},
        });
        if (message.historyId) {
          this.disk.use(message.historyId);
          this.disk.retain(message.sessions.map((session) => session.id));
        } else this.disk.historyId = null;
        if (selectedId) this.present(selectedId);
      } else if (message.type === 'response') {
        const request = this.pending.get(message.requestId);
        if (!request) return;
        clearTimeout(request.timer);
        this.pending.delete(message.requestId);
        if (message.ok) request.resolve(message);
        else {
          this.results.delete(message.requestId);
          request.reject(new RequestRejectedError(message.code, message.message ?? '请求失败。'));
        }
      } else if (message.type === 'connection.error') {
        // Retry authentication once, before any session command can be sent. A new
        // bridge rechecks TLS and recreates the execution channel for this attempt.
        fallback = !ready ? fallbackServerProtocol(message, protocolVersion) : null;
        if (fallback !== null) {
          socket.close();
          return;
        }
        this.update({ error: message.message });
        if (message.code === 'unauthorized' && credentials.browser) credentials.browser();
        if (message.code === 'version_mismatch')
          this.update({
            mismatch: true,
            service: message.service ?? null,
            release: message.client?.version ?? null,
            preparing: message.preparing
              ? message.preparing.size
                ? message.preparing.received / message.preparing.size
                : 0
              : null,
          });
        if (
          [
            'unauthorized',
            'version_mismatch',
            'tunnel_failed',
            'ssh_failed',
            'connection_lost',
            'client_failed',
          ].includes(message.code)
        ) {
          // The way to the service broke, or the service could not reach back: the next attempt may do.
          const passing =
            this.established &&
            credentials.reconnect &&
            ['tunnel_failed', 'ssh_failed', 'connection_lost'].includes(message.code);
          if (!passing) this.credentials = null;
          socket.close();
        }
      } else if (
        message.type === 'usage.summary' ||
        message.type === 'usage.page' ||
        message.type === 'session.stats' ||
        message.type === 'settings.state' ||
        message.type === 'instructions.state' ||
        message.type === 'web.settings.state' ||
        message.type === 'web.totp.setup' ||
        message.type === 'web.certificate.state'
      ) {
        if (this.pending.has(message.requestId)) this.results.set(message.requestId, message);
      } else if (message.type === 'compaction.state') {
        if (message.requestId && this.pending.has(message.requestId))
          this.results.set(message.requestId, message);
        this.update({ compaction: message.values });
      } else if (message.type === 'service.update') {
        const { type: _type, ...update } = message;
        this.update({ update });
      } else if (message.type === 'pool.state') {
        const { type: _type, ...pool } = message;
        this.update({ pool });
      } else if (message.type === 'account.token.created') {
        const { type: _type, ...setupToken } = message;
        this.update({ setupToken });
      } else if (message.type === 'account.state') {
        const { type: _type, ...account } = message;
        // A signed-out account must not keep showing the previous one's identity and quota.
        this.update(
          account.loggedIn
            ? { account }
            : {
                account,
                capabilities: null,
                quota: null,
                metrics: null,
                accountQuotas: { ...this.state.accountQuotas, default: { rateLimits: null } },
              },
        );
      } else if (message.type === 'quota') {
        const { type: _type, ...quota } = message;
        this.update({
          accountQuotas: { ...this.state.accountQuotas, [quota.accountId ?? 'default']: quota },
          ...(!quota.accountId || quota.accountId === 'default' ? { quota } : {}),
        });
      } else if (message.type === 'devices') {
        this.update({ devices: message.devices });
      } else if (message.type === 'projects') {
        this.update({ projects: message.projects });
      } else if (message.type === 'session.updated') {
        this.upsert(message.session);
      } else if (message.type === 'session.deleted') {
        this.disk.drop(message.sessionId);
        const events = { ...this.state.events };
        const live = { ...this.state.live };
        const history = { ...this.state.history };
        delete events[message.sessionId];
        delete live[message.sessionId];
        delete history[message.sessionId];
        this.historyEpoch.delete(message.sessionId);
        this.streamEvents = this.streamEvents.filter(
          (event) => event.sessionId !== message.sessionId,
        );
        this.cacheOrder = this.cacheOrder.filter((id) => id !== message.sessionId);
        const sessions = this.state.sessions.filter((session) => session.id !== message.sessionId);
        const selectedId =
          this.state.selectedId === message.sessionId ? null : this.state.selectedId;
        this.update({ sessions, events, live, history, selectedId });
      } else if (message.type === 'session.snapshot') {
        // Archive reads have their own cursor and data. They must not prepend thousands of events into
        // the visible conversation, or depend on its four-session cache and loading indicators.
        if (this.pending.get(message.requestId)?.capture) {
          if (
            this.pending.get(message.requestId)?.type === 'session.subscribe' &&
            this.state.sessions.some((session) => session.id === message.session.id)
          ) {
            const current = this.state.sessions.find(
              (session) => session.id === message.session.id,
            );
            if (!current || current.updatedAt <= message.session.updatedAt)
              this.upsert(message.session);
          }
          this.results.set(message.requestId, message);
          return;
        }
        this.flushStream();
        const request = this.pending.get(message.requestId);
        if (
          !request ||
          !this.cacheOrder.includes(message.session.id) ||
          !this.state.sessions.some((session) => session.id === message.session.id)
        )
          return;
        const current = this.state.sessions.find((session) => session.id === message.session.id);
        if (!current || current.updatedAt <= message.session.updatedAt)
          this.upsert(message.session);
        const id = message.session.id;
        // Chunked history may overlap new live output; retain events newer than the snapshot.
        const tail = (message.reset ? [] : (this.state.events[id] ?? [])).filter(
          (event) => event.sequence > message.lastSequence,
        );
        const newer = tail.length > 0 || (current?.updatedAt ?? '') > message.session.updatedAt;
        // History up to now ends where unfinished output begins; the service sends that again, whole.
        if (message.mode !== 'prepend' && !newer && this.state.live[id]) {
          const { [id]: _stale, ...live } = this.state.live;
          this.update({ live });
        }
        const previous = this.state.history[id];
        // A page fetched above what is kept on disk goes on there.
        const above =
          request.command?.type === 'session.history' && !!request.command.afterSequence;
        const history = {
          ...(message.mode === 'prepend' && previous?.needsReload ? { needsReload: true } : {}),
          firstSequence:
            message.mode === 'append'
              ? (previous?.firstSequence ?? message.firstSequence)
              : message.firstSequence,
          lastSequence:
            message.mode === 'prepend'
              ? (previous?.lastSequence ?? message.lastSequence)
              : (tail.at(-1)?.sequence ?? message.lastSequence),
          hasEarlier:
            message.mode === 'append'
              ? (previous?.hasEarlier ?? false)
              : message.hasEarlier || above,
          loading: false,
          loadingEarlier: false,
        };
        this.merge(id, [...message.events, ...tail], history, message.mode === 'replace');
        if (message.reset) this.disk.drop(id);
        this.disk.write(id, message.events, covered(message, request.command));
        if (request.type === 'session.history') {
          clearTimeout(request.timer);
          this.pending.delete(message.requestId);
          request.resolve({
            type: 'response',
            requestId: message.requestId,
            ok: true,
            sessionId: id,
          });
        }
      } else if (message.type === 'session.event') {
        const payload = message.event.payload;
        const at = Date.parse(message.event.createdAt);
        this.ahead = Math.min(this.ahead, Date.now() - at);
        if (!['native.metrics', 'native.capabilities', 'native.context'].includes(payload.type))
          this.activity.set(message.event.sessionId, at);
        if (payload.type === 'native.metrics' && (payload.rateLimits || payload.errors?.usage))
          this.update({ metrics: payload });
        if (payload.type === 'native.capabilities') this.update({ capabilities: payload });
        // The service streams the shown session's events, and may send some of another one's: one of those in a cached
        // history would move its cursor past what was never received, and showing that session again would not fetch it.
        if (message.event.sessionId !== this.state.selectedId) return;
        this.streamEvents.push(message.event);
        this.streamTimer ??= setTimeout(() => this.flushStream(), 32);
      } else if (message.type === 'session.fragment') {
        this.activity.set(message.sessionId, this.serviceNow());
        if (!this.cacheOrder.includes(message.sessionId)) return;
        this.streamEvents.push(message);
        this.streamTimer ??= setTimeout(() => this.flushStream(), 32);
      }
    };
    socket.onclose = (event) => {
      clearTimeout(timeout);
      if (this.socket !== socket) return;
      this.socket = null;
      if (credentials.browser && event.code === 4001) {
        this.credentials = null;
        credentials.browser();
      }
      this.flushStream();
      this.rejectPending();
      if (fallback !== null && this.credentials === credentials) {
        this.open(fallback);
        return;
      }
      if (
        !this.credentials ||
        !this.credentials.reconnect ||
        (this.credentials.bridge && !this.established)
      ) {
        const nativeClosed = !!this.credentials;
        this.credentials = null;
        this.update({
          status: 'disconnected',
          retry: null,
          connectionId: null,
          error: this.state.error ?? (nativeClosed ? '原生连接已结束，请重新连接。' : null),
          setupToken: null,
        });
        return;
      }
      const delay = Math.min(1000 * 2 ** this.retryAttempt++, credentials.bridge ? 10000 : 5000);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        this.open();
      }, delay);
      this.update({
        status: 'reconnecting',
        connectionId: null,
        devices: [],
        setupToken: null,
        retry: { attempt: this.state.retry?.attempt ?? 0, nextAt: Date.now() + delay },
      });
    };
    socket.onerror = () => {
      /* onclose owns reconnect and pending request cleanup. */
    };
  }
  // Makes the attempt that is waiting for its turn now: the network just came back.
  retryNow() {
    if (this.state.status !== 'reconnecting' || this.retryTimer === undefined) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.open();
  }
  disconnect() {
    this.flushStream();
    const browser = this.credentials?.browser;
    this.credentials = null;
    this.turn++;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const socket = this.socket;
    this.socket = null;
    // Said before closing, so that the service does not keep this computer's runs for it to come back to.
    if (!browser && socket?.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify({ type: 'leave' }));
    socket?.close();
    this.rejectPending();
    this.retryAttempt = 0;
    this.update({ status: 'disconnected', connectionId: null, retry: null, setupToken: null });
  }
  private rejectPending() {
    for (const [id, request] of this.pending) {
      clearTimeout(request.timer);
      this.results.delete(id);
      request.reject(new RequestInterruptedError(request.type));
    }
    this.pending.clear();
    this.historyParts.clear();
  }
  private upsert(session: Session) {
    this.update({
      sessions: [...this.state.sessions.filter((item) => item.id !== session.id), session].sort(
        (a, b) => b.updatedAt.localeCompare(a.updatedAt),
      ),
    });
  }
  private flushStream() {
    clearTimeout(this.streamTimer);
    this.streamTimer = undefined;
    const grouped = new Map<string, SessionEvent[]>();
    const live = { ...this.state.live };
    let moved = false;
    let progress = this.state.progress;
    for (const item of this.streamEvents) {
      const open = live[item.sessionId];
      // A list of background tasks ends what the tasks no longer on it had said.
      if (!('type' in item) && item.payload.type === 'native.tasks' && progress[item.sessionId]) {
        const listed = item.payload.tasks.map((task) => task.id);
        progress = {
          ...progress,
          [item.sessionId]: Object.fromEntries(
            Object.entries(progress[item.sessionId]).filter(([id]) => listed.includes(id)),
          ),
        };
      }
      if ('type' in item) {
        const { sessionId, runId, payload } = item;
        if (payload.type === 'native.progress') {
          progress = {
            ...progress,
            [sessionId]: { ...progress[sessionId], [payload.taskId]: payload },
          };
          continue;
        }
        if (!isFragment(payload)) continue;
        const last = open?.runId === runId ? open.payload : undefined;
        live[sessionId] =
          open && last && isFragment(last) && continues(last, payload)
            ? { ...open, payload: { ...payload, text: last.text + payload.text } }
            : { sessionId, runId, sequence: 0, createdAt: new Date().toISOString(), payload };
        moved = true;
        continue;
      }
      // Whatever the run records next comes after its unfinished output, which is recorded first.
      if (open?.runId === item.runId) {
        delete live[item.sessionId];
        moved = true;
      }
      const events = grouped.get(item.sessionId) ?? [];
      events.push(item);
      grouped.set(item.sessionId, events);
    }
    this.streamEvents = [];
    if (progress !== this.state.progress) this.update({ progress });
    if (moved) this.update({ live });
    for (const [id, events] of grouped) {
      const held = this.state.history[id];
      this.merge(id, events);
      // Once its page is in, the shown session's events follow what it holds without a gap.
      if (held && !held.loading && !held.needsReload)
        this.disk.write(id, events, [held.lastSequence, this.state.history[id]!.lastSequence]);
    }
  }
  private merge(
    sessionId: string,
    events: SessionEvent[],
    history?: HistoryState,
    replace = false,
  ) {
    const bySequence = new Map(
      (replace ? [] : (this.state.events[sessionId] ?? [])).map((event) => [event.sequence, event]),
    );
    for (const event of events) bySequence.set(event.sequence, event);
    const combined = [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
    const previous = history ??
      this.state.history[sessionId] ?? {
        firstSequence: combined[0]?.sequence ?? 0,
        lastSequence: 0,
        hasEarlier: false,
        loading: false,
        loadingEarlier: false,
      };
    this.update({
      events: {
        ...this.state.events,
        [sessionId]: combined,
      },
      history: {
        ...this.state.history,
        [sessionId]: {
          ...previous,
          // An empty snapshot starts at zero. Its first live record establishes the cache boundary.
          firstSequence: previous.firstSequence || combined[0]?.sequence || 0,
          lastSequence: Math.max(previous.lastSequence, combined.at(-1)?.sequence ?? 0),
        },
      },
    });
  }
  // A session's events as they are shown: what is recorded, then the output still arriving, where the event
  // that records it will be.
  shown(sessionId: string): SessionEvent[] {
    const recorded = this.state.events[sessionId] ?? [];
    const unfinished = this.state.live[sessionId];
    return unfinished
      ? [...recorded, { ...unfinished, sequence: (recorded.at(-1)?.sequence ?? 0) + 1 }]
      : recorded;
  }
  private load(sessionId: string) {
    this.historyEpoch.set(sessionId, {});
    const previous = this.state.history[sessionId];
    const afterSequence = previous?.needsReload ? 0 : (previous?.lastSequence ?? 0);
    this.update({
      history: {
        ...this.state.history,
        [sessionId]: {
          ...(previous ?? {
            firstSequence: 0,
            lastSequence: 0,
            hasEarlier: false,
            loadingEarlier: false,
          }),
          loading: true,
          loadingEarlier: false,
        },
      },
    });
    // The service checks that the history held still ends with the event it has there.
    const last = this.state.events[sessionId]?.at(-1);
    void this.request({
      type: 'session.subscribe',
      sessionId,
      afterSequence,
      ...((this.state.serviceProtocol ?? 0) >= 27 &&
      afterSequence &&
      last?.sequence === afterSequence
        ? { afterCreatedAt: last.createdAt }
        : {}),
    }).catch((error: Error) => {
      if (error.name === 'AbortError' || this.state.selectedId !== sessionId) return;
      const history = this.state.history[sessionId];
      if (history)
        this.update({
          error: error.message,
          history: {
            ...this.state.history,
            [sessionId]: { ...history, loading: false, needsReload: true },
          },
        });
    });
  }
  async loadEarlier(sessionId: string) {
    const history = this.state.history[sessionId];
    if (!history?.hasEarlier || history.loadingEarlier || history.loading) return;
    const epoch = this.historyEpoch.get(sessionId);
    const connection = this.state.connectionId;
    const current = () =>
      this.historyEpoch.get(sessionId) === epoch &&
      this.cacheOrder.includes(sessionId) &&
      this.state.status === 'connected' &&
      this.state.connectionId === connection &&
      this.state.sessions.some((session) => session.id === sessionId);
    this.update({
      history: { ...this.state.history, [sessionId]: { ...history, loadingEarlier: true } },
    });
    try {
      const held = this.disk.ready
        ? await this.disk.earlier(sessionId, history.firstSequence)
        : null;
      if (!current()) return;
      if (held && 'events' in held && held.events.length) {
        this.merge(sessionId, held.events, {
          ...this.state.history[sessionId]!,
          firstSequence: held.events[0]!.sequence,
          hasEarlier: held.hasEarlier,
          loadingEarlier: false,
        });
        return;
      }
      let after = held && 'after' in held ? held.after : 0;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!current()) return;
        try {
          // Keep the page separate until its read is confirmed; late attempts cannot prepend twice.
          let page = await this.fetch({
            type: 'session.history',
            sessionId,
            beforeSequence: history.firstSequence,
            ...((this.state.serviceProtocol ?? 0) >= 27 ? { afterSequence: after } : {}),
          });
          if (!current()) return;
          // Sequences are global: a gap above the cached stretch may contain no events for
          // this session. Fall back to a bounded normal page rather than setting its cursor to zero.
          if (!page.events.length && after > 0) {
            after = 0;
            page = await this.fetch({
              type: 'session.history',
              sessionId,
              beforeSequence: history.firstSequence,
            });
            if (!current()) return;
          }
          if (
            page.session.id !== sessionId ||
            page.mode !== 'prepend' ||
            (page.hasEarlier && (page.firstSequence <= 0 || !page.events.length)) ||
            page.firstSequence >= history.firstSequence ||
            page.events.some(
              (event) => event.sessionId !== sessionId || event.sequence >= history.firstSequence,
            )
          )
            throw new Error('更早记录分页异常，请重新打开会话后重试。');
          this.flushStream();
          const latest = this.state.history[sessionId]!;
          this.merge(sessionId, page.events, {
            ...latest,
            firstSequence: page.firstSequence,
            hasEarlier: page.hasEarlier || after > 0,
            loadingEarlier: false,
          });
          this.disk.write(
            sessionId,
            page.events,
            covered(page, {
              type: 'session.history',
              sessionId,
              beforeSequence: history.firstSequence,
              afterSequence: after,
            }),
          );
          return;
        } catch (error) {
          if (!current()) return;
          if (!(error instanceof RequestTimeoutError)) throw error;
          if (attempt === 2)
            throw new Error('读取更早记录超时，已自动重试 2 次。请检查连接后点击重试。');
        }
      }
    } finally {
      if (this.historyEpoch.get(sessionId) === epoch) {
        const latest = this.state.history[sessionId];
        if (latest?.loadingEarlier)
          this.update({
            history: { ...this.state.history, [sessionId]: { ...latest, loadingEarlier: false } },
          });
      }
    }
  }
  select(sessionId: string) {
    if (this.state.selectedId === sessionId && this.state.history[sessionId]?.loading) return;
    this.cancelHistory();
    this.flushStream();
    this.cacheOrder = [...this.cacheOrder.filter((id) => id !== sessionId), sessionId];
    const events = { ...this.state.events };
    const live = { ...this.state.live };
    const history = { ...this.state.history };
    while (this.cacheOrder.length > 4) {
      const evicted = this.cacheOrder.shift()!;
      delete events[evicted];
      delete live[evicted];
      delete history[evicted];
      this.historyEpoch.delete(evicted);
    }
    this.update({ selectedId: sessionId, events, live, history });
    this.present(sessionId);
  }
  // A session not in memory shows what is kept of it at once; the service is then asked for what came since.
  private present(sessionId: string) {
    if (this.state.history[sessionId] || !this.disk.ready) {
      if (this.state.status === 'connected') this.load(sessionId);
      return;
    }
    const reading: HistoryState = {
      firstSequence: 0,
      lastSequence: 0,
      hasEarlier: false,
      loading: true,
      loadingEarlier: false,
    };
    this.update({ history: { ...this.state.history, [sessionId]: reading } });
    const opening = this.disk.latest(sessionId).then((page) => {
      // Shown elsewhere, read again or loaded in the meantime: what the disk had is not wanted.
      if (this.state.history[sessionId] !== reading) return;
      if (page?.events.length)
        this.merge(
          sessionId,
          page.events,
          {
            firstSequence: page.events[0]!.sequence,
            lastSequence: page.events.at(-1)!.sequence,
            hasEarlier: page.hasEarlier,
            loading: false,
            loadingEarlier: false,
          },
          true,
        );
      else {
        const { [sessionId]: _none, ...history } = this.state.history;
        this.update({ history });
      }
      if (this.state.selectedId === sessionId && this.state.status === 'connected')
        this.load(sessionId);
    });
    this.opening.set(sessionId, opening);
    void opening.finally(() => {
      if (this.opening.get(sessionId) === opening) this.opening.delete(sessionId);
    });
  }
  // Read a session, or all of them, from the service again: what is kept of it goes, from disk and memory.
  resync(sessionId?: string) {
    this.flushStream();
    this.cancelHistory(sessionId);
    if (sessionId) this.disk.drop(sessionId);
    else this.disk.clear();
    const keep = <T>(map: Record<string, T>) =>
      sessionId ? Object.fromEntries(Object.entries(map).filter(([id]) => id !== sessionId)) : {};
    this.cacheOrder = sessionId ? this.cacheOrder.filter((id) => id !== sessionId) : [];
    this.update({
      events: keep(this.state.events),
      live: keep(this.state.live),
      history: keep(this.state.history),
    });
    const selected = this.state.selectedId;
    if (selected && (!sessionId || selected === sessionId)) this.select(selected);
  }

  // A browser's user is still there; its login's idle time starts over.
  markActive() {
    if (!this.state.browser || this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify({ type: 'web.activity' }));
    return true;
  }

  // Data replies arrive just before their response frame.
  async fetch<T extends keyof Replies>(
    command: Extract<NewCommand, { type: T }>,
    progress?: (received: number, total: number) => void,
  ) {
    const response = await this.request(command, true, progress);
    const result = this.results.get(response.requestId);
    this.results.delete(response.requestId);
    if (!result) throw new Error('服务没有返回数据。');
    return result as Extract<ServerMessage, { type: Replies[T] }>;
  }
  async request(
    command: NewCommand,
    capture = false,
    progress?: (received: number, total: number) => void,
  ): Promise<Response> {
    if (this.state.status !== 'connected' || this.socket?.readyState !== WebSocket.OPEN)
      throw new Error('服务未连接。');
    const requestId = crypto.randomUUID();
    const historyRead = ['session.subscribe', 'session.history'].includes(command.type);
    const done = new Promise<Response>((resolve, reject) => {
      const timeout = () => {
        this.pending.delete(requestId);
        this.results.delete(requestId);
        this.historyParts.delete(requestId);
        if (historyRead && (this.state.serviceProtocol ?? 0) >= 26)
          this.socket?.send(JSON.stringify({ type: 'session.history.cancel', requestId }));
        reject(
          new RequestTimeoutError(
            historyRead
              ? '读取会话历史超时。'
              : command.type === 'message.enqueue'
                ? '排队请求超时；请查看待发送队列及历史确认结果，未自动重发。'
                : '请求超时；请查看历史确认结果，未自动重发。',
          ),
        );
      };
      const wait =
        command.type === 'session.status' ||
        historyRead ||
        command.type.startsWith('account.') ||
        command.type.startsWith('service.')
          ? 30000
          : 10000;
      const timer = setTimeout(timeout, wait);
      const renew = historyRead
        ? () => {
            const pending = this.pending.get(requestId);
            if (pending) {
              clearTimeout(pending.timer);
              pending.timer = setTimeout(timeout, wait);
            }
          }
        : undefined;
      this.pending.set(requestId, {
        resolve,
        reject,
        timer,
        type: command.type,
        capture,
        command,
        ...('sessionId' in command ? { sessionId: command.sessionId } : {}),
        renew,
        progress,
      });
      const wire = { ...command };
      if ((this.state.serviceProtocol ?? 0) < 29 && wire.type === 'session.create')
        delete wire.plain;
      if ((this.state.serviceProtocol ?? 0) < 28 && wire.type === 'approval.reply')
        delete wire.plan;
      if ((this.state.serviceProtocol ?? 0) < 27) {
        if (wire.type === 'session.history') delete wire.afterSequence;
        if (wire.type === 'session.subscribe') delete wire.afterCreatedAt;
      }
      this.socket!.send(
        JSON.stringify({
          ...wire,
          ...(historyRead && this.state.features.includes('chunked-history')
            ? { chunked: true }
            : {}),
          requestId,
        }),
      );
    }).finally(() => this.historyParts.delete(requestId));
    const pending = this.pending.get(requestId);
    if (pending) pending.done = done;
    return done;
  }
  async waitForHistory(sessionId: string) {
    const opening = this.opening.get(sessionId);
    if (opening) await opening;
    await Promise.all(
      [...this.pending.values()]
        .filter((request) => request.sessionId === sessionId)
        .map((request) => request.done),
    );
    if (this.state.selectedId !== sessionId) throw new Error('已切换会话，读取取消。');
    if (this.state.history[sessionId]?.needsReload)
      throw new Error('会话历史尚未完整加载，请重新打开会话后重试。');
  }
  private cancelHistory(sessionId?: string) {
    for (const [requestId, request] of this.pending) {
      if (request.type !== 'session.subscribe' && request.type !== 'session.history') continue;
      if (sessionId && request.sessionId !== sessionId) continue;
      clearTimeout(request.timer);
      this.pending.delete(requestId);
      this.historyParts.delete(requestId);
      if (this.socket?.readyState === WebSocket.OPEN && (this.state.serviceProtocol ?? 0) >= 26)
        this.socket.send(JSON.stringify({ type: 'session.history.cancel', requestId }));
      const id = request.sessionId!;
      const history = this.state.history[id];
      if (history)
        this.update({
          history: {
            ...this.state.history,
            [id]: {
              ...history,
              loading: false,
              loadingEarlier: false,
              ...(request.type === 'session.subscribe' ? { needsReload: true } : {}),
            },
          },
        });
      request.reject(Object.assign(new Error('历史读取已取消。'), { name: 'AbortError' }));
    }
  }
}
