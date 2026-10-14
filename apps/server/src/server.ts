import { ProjectQuotaSettings } from './project-quota.ts';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { totalmem } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, RequestListener } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { WebSocket, WebSocketServer } from 'ws';
import { nativeStore } from './native-store.ts';
import { AccountPool, orderedAccounts, nextAccountReset } from './account-pool.ts';
import { poolHandoff, handoffBlockReason } from './pool-handoff.ts';
import { accountStatus, accountLogout, NativeLogin } from './native-account.ts';
import {
  authSchema,
  commandSchema,
  continues,
  deviceIdentitySchema,
  isFragment,
  leaveSchema,
  MAX_FRAME_BYTES,
  platformOf,
  PROTOCOL_VERSION,
  TUNNEL_CLOSE,
  tunnelAttachSchema,
  tunnelCredentialsSchema,
  terminalControlSchema,
} from '@cc-desk-tunnel/protocol';
import type {
  AccountState,
  Command,
  Device,
  EventPayload,
  Fragment,
  ServerMessage,
  Session,
  TerminalControl,
  TunnelCredentials,
} from '@cc-desk-tunnel/protocol';
import { runClaude, nativeDirectory, prepareNativeDirectory, readNativeStatus } from './claude.ts';
import type { ClaudeOptions } from './claude.ts';
import { ClientReleases } from './client-release.ts';
import { DomainError } from './errors.ts';
import { NativeInput } from './native-input.ts';
import { completeOnboarding } from './native-onboarding.ts';
import { readNativeSettings, updateNativeSettings, settingsPath } from './native-settings.ts';
import type { NativeTerminal } from './native-terminal.ts';
import { simulate } from './simulation.ts';
import { SessionStore } from './store.ts';
import { Throttle } from './throttle.ts';
import { Door, Tunnel, sessionSsh, sessionSshPath } from './tunnel.ts';
import type { TunnelOptions } from './tunnel.ts';
import { ServiceUpdates, serviceVersion } from './updates.ts';
import type { UpdateOptions } from './updates.ts';
import { UsageLog, createUsageReceiver, telemetryEnvironment } from './usage.ts';

type Peer = {
  socket: WebSocket;
  id: string;
  address: string;
  authenticated: boolean;
  // The computer it is from: the name it signed in with, and the identity that follows in a frame of its own.
  name: string;
  device?: Device;
  tunnel?: Tunnel;
  registering: boolean;
  // The client said it was closing the connection: nothing is kept for it to come back to.
  left: boolean;
  subscriptions: Set<string>;
  responses: Map<string, { command: string; response: Promise<ServerMessage> }>;
  poolClient?: boolean;
};
// A run belongs to the computer its session is on, not to the connection that started it: connections come
// and go with the network, and the CLI goes on working here meanwhile. `connectionId` only names the one that
// started it, in the record.
export type Run = {
  id: string;
  sessionId: string;
  device: string;
  connectionId: string;
  controller: AbortController;
  // Simulation keeps its single tool and approval here; native runs use `approvals` and `input`.
  toolId?: string;
  toolFinished: boolean;
  approvalId?: string;
  decide?: (allowed: boolean, answers?: Record<string, string>) => void;
  approvals: Map<string, (allowed: boolean, answers?: Record<string, string>) => void>;
  cancelReason?: string;
  // Output still arriving in pieces: sent on as it comes, recorded once it is whole.
  open?: Fragment;
  input?: NativeInput;
  controls: {
    refresh?: () => Promise<void>;
    stopTask?: (taskId: string) => Promise<void>;
    quotaPolicyChanged?: () => void;
  };
  quotaWaiting?: boolean;
  quotaDeadline?: { accountId: string; at: number };
  wakeQuota?: () => void;
  attempted?: Set<string>;
  nativeId?: string;
};
type Terminal = { id: string; sessionId: string; owner: Peer; process?: NativeTerminal };
// One of the user's computers, while it is connected or expected back: its connections, the door its commands
// go through, and the wait that ends its runs if it stays away.
type Seat = {
  device: string;
  peers: Set<Peer>;
  door?: Door;
  opening?: Promise<void>;
  away?: NodeJS.Timeout;
};
type Login = { process: NativeLogin; owner: Peer; url?: string };
type CommandOf<T extends Command['type']> = Extract<Command, { type: T }>;
export type ServerOptions = {
  token: string;
  dataDir: string;
  stepMs?: number;
  allowedOrigins?: string[];
  claude?: ClaudeOptions;
  tunnel?: TunnelOptions;
  tls?: { cert: Buffer; key: Buffer };
  reverseProxy?: boolean;
  host?: string;
  // Where an administrator puts the Windows installer offered to clients; defaults to <dataDir>/client.
  clientDir?: string;
  // How many native runs and terminals may be going at once, over all connections; by default what the
  // memory of this machine holds.
  maxRuns?: number;
  // Following the published releases; absent, the service neither looks for nor installs newer versions.
  updates?: Omit<UpdateOptions, 'clientDir'>;
  // How long the runs of a computer go on after its last connection broke, for it to come back to. By default
  // five minutes with the real CLI and none in simulation.
  graceMs?: number;
};

// How many answered requests a connection remembers, to answer a resend of one the same way.
const REMEMBERED = 256;
// How much unfinished output a run holds before recording it, in characters.
const OPEN_LIMIT = 64 * 1024;
// What the "continue" button sends in the user's place. The turn before it was stopped or cut off, and a
// command that was under way then may or may not have taken effect.
const CONTINUE =
  'Continue from where the last turn stopped. A command that was running when it stopped may or may not have taken effect: check its result before repeating it.';

export function createProxyServer(options: ServerOptions) {
  if (options.token.length < 24)
    throw new Error('PROXY_TOKEN must contain at least 24 characters.');
  if (options.claude && (!options.tunnel || (!options.tls && !options.reverseProxy)))
    throw new Error(
      'Native mode requires TLS or explicit reverse proxy mode, and the execution channel.',
    );
  const store = new SessionStore(options.dataDir);
  const projectQuota = new ProjectQuotaSettings(store.database);
  const usage = new UsageLog(store.database);
  const usageReceiver = options.claude ? createUsageReceiver(usage) : undefined;
  const peers = new Set<Peer>();
  // One run or one terminal per session, each a CLI process of its own in the session's directory. What reads
  // or changes the state the CLI keeps for all of them — a status read or session change (`mutations`), an
  // account change — waits until none is going.
  const runs = new Map<string, Run>();
  const mutations = new Set<string>();
  const terminals = new Map<string, Terminal>();
  const pool = options.claude
    ? new AccountPool(store.database, store.directory, options.claude)
    : undefined;
  const poolLogins = new Map<string, Login>();
  const poolProbes = new Map<string, AbortController>();
  let poolRefresh: Promise<void> | undefined;
  let poolTimer: NodeJS.Timeout | undefined;
  const seats = new Map<string, Seat>();
  const graceMs = options.graceMs ?? (options.claude ? 300_000 : 0);
  let login: Login | undefined;
  // Each run or terminal is a CLI process that keeps some 250 MB; more of them than the memory holds would
  // take the machine down, and every one of them with it.
  const capacity =
    options.maxRuns ?? Math.max(1, Math.floor((totalmem() - 300 * 2 ** 20) / (300 * 2 ** 20)));
  // Background work that close() waits for.
  const tasks = new Set<Promise<unknown>>();
  const tunnelTasks = new Set<Promise<unknown>>();
  let closing = false;
  const adapter = options.claude ? 'claude-code' : 'simulation';
  const origins = options.allowedOrigins ?? [
    'http://127.0.0.1:5173',
    'http://localhost:5173',
    'file://',
    'null',
  ];
  const expectedToken = createHash('sha256').update(options.token).digest();
  const authorized = (token: string) =>
    timingSafeEqual(expectedToken, createHash('sha256').update(token).digest());
  const clientDir = options.clientDir ?? join(options.dataDir, 'client');
  const releases = new ClientReleases(clientDir);
  const version = serviceVersion();
  const updates = options.updates
    ? new ServiceUpdates(
        // The next client of another version is offered the installer the moment it is here.
        { ...options.updates, clientDir, installed: () => void releases.refresh() },
        (state) => broadcast({ type: 'service.update', ...state }),
      )
    : undefined;
  const throttle = new Throttle();
  // Behind the reverse proxy every socket comes from the proxy itself; it passes the client on in X-Real-IP.
  const addressOf = (request: IncomingMessage) =>
    (options.reverseProxy && [request.headers['x-real-ip']].flat()[0]) ||
    request.socket.remoteAddress ||
    'unknown';
  function refuse(address: string, what = 'service token') {
    const count = throttle.fail(address);
    const wait = throttle.blocked(address);
    console.log(
      `Sign-in refused from ${address}: wrong ${what}, ${count} in a row${wait ? `; blocked for ${wait}s` : ''}`,
    );
  }

  const handler: RequestListener = (request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ status: 'ok', protocolVersion: PROTOCOL_VERSION, adapter }));
    } else if (request.method === 'GET' && request.url === '/client/installer') {
      // The same secret as the WebSocket: only a signed-in client can fetch the installer.
      const release = releases.current;
      const address = addressOf(request);
      if (throttle.blocked(address)) {
        response.writeHead(429, { 'Retry-After': throttle.blocked(address) }).end();
      } else if (!authorized(request.headers.authorization?.replace(/^Bearer /, '') ?? '')) {
        refuse(address);
        response.writeHead(401).end();
      } else if (!release) {
        response.writeHead(404).end();
      } else {
        response.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': release.size,
          'Cache-Control': 'no-store',
        });
        createReadStream(release.path)
          .on('error', () => response.destroy())
          .pipe(response);
      }
    } else {
      response.writeHead(404);
      response.end();
    }
  };
  const server = options.tls ? createHttpsServer(options.tls, handler) : createServer(handler);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  server.on('upgrade', (request, socket, head) => {
    if (
      closing ||
      request.url !== '/ws' ||
      (request.headers.origin && !origins.includes(request.headers.origin))
    ) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const address = addressOf(request);
    if (throttle.blocked(address) || !throttle.enter(address)) {
      socket.end(
        `HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${throttle.blocked(address) || 5}\r\nConnection: close\r\n\r\n`,
      );
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, address));
  });

  function send(peer: Peer, message: ServerMessage) {
    if (peer.socket.readyState === WebSocket.OPEN) peer.socket.send(JSON.stringify(message));
  }
  function broadcast(message: ServerMessage, sessionId?: string) {
    for (const peer of peers) {
      if (peer.authenticated && (!sessionId || peer.subscriptions.has(sessionId)))
        send(peer, message);
    }
  }
  function deviceOf(peer: Peer) {
    if (!peer.device) throw new DomainError('device_unknown', '客户端没有报告设备标识。');
    return peer.device;
  }
  // A session is worked on from the computer its project directory is on. One from before computers were
  // told apart becomes that of the first to use it.
  function onDevice(peer: Peer, session: Session) {
    const device = deviceOf(peer);
    // Before computers were told apart they were all Windows ones, and so is the session's project path.
    if (!session.device && platformOf(device) === 'win32')
      updated(store.claim(session.id, device).id);
    else if (session.device?.id !== device.id)
      throw new DomainError(
        'other_device',
        `此会话在设备“${session.device?.name ?? '一台 Windows 电脑'}”上。要在本机接着做，请先为它选择本机的项目目录，或把它分叉到本机。`,
      );
  }
  function room() {
    if (options.claude && runs.size + terminals.size >= capacity)
      throw new DomainError(
        'capacity',
        `服务端同时最多进行 ${capacity} 个运行或终端（按服务器内存估算，可用 PROXY_MAX_RUNS 调整）。请等其他任务结束后再试。`,
      );
  }
  function track(task: Promise<unknown>, group = tasks) {
    group.add(task);
    void task.finally(() => group.delete(task));
  }
  function updated(sessionId: string) {
    broadcast({ type: 'session.updated', session: store.get(sessionId).session });
  }
  function accountBusy(id: string) {
    if (pool?.locked.has(id)) return true;
    return [...runs.keys(), ...terminals.keys(), ...mutations].some((sessionId) => {
      try {
        return (store.get(sessionId).session.accountId ?? 'default') === id;
      } catch {
        return false;
      }
    });
  }
  function publishPool(target?: Peer) {
    if (!pool || closing) return;
    const state = pool.snapshot();
    usage.rememberAccounts();
    for (const account of state.accounts) {
      account.busy = accountBusy(account.id);
      if (account.limits?.available && account.checkedAt !== null)
        usage.observe(account.limits, account.checkedAt, account.id);
      account.usage = usage
        .summary(Date.now(), account.id)
        .windows.map(({ name, requests, costUsd }) => ({ name, requests, costUsd }));
    }
    const message = {
      type: 'pool.state' as const,
      ...state,
      quotaResumeProjects: projectQuota.list(),
      nextReset: nextAccountReset(state.accounts, [...pool.locked]),
      serverTime: Date.now(),
      quotaWaits: [...runs.values()]
        .filter((run) => run.quotaWaiting)
        .map((run) => {
          const reset =
            run.quotaDeadline ??
            (pool!.settings.enabled ? nextAccountReset(state.accounts, [...pool!.locked]) : null);
          return {
            sessionId: run.sessionId,
            accountId: reset?.accountId ?? null,
            at: reset?.at ?? null,
          };
        }),
    };
    if (target) send(target, message);
    else for (const peer of peers) if (peer.authenticated && peer.poolClient) send(peer, message);
  }
  async function refreshPool() {
    if (!pool || closing) return;
    if (poolRefresh) return poolRefresh;
    pool.refreshing = true;
    publishPool();
    poolRefresh = (async () => {
      for (const account of pool.accounts) {
        if (closing) break;
        if (
          !account.enabled ||
          pool.locked.has(account.id) ||
          poolLogins.has(account.id) ||
          (account.id === 'default' && login)
        )
          continue;
        const claude = pool.options(account.id);
        try {
          const identity = await accountStatus(claude.executable, claude.environment);
          if (closing) break;
          pool.update(account.id, {
            loggedIn: identity.loggedIn,
            email: identity.email,
            subscriptionType: identity.subscriptionType,
          });
          if (!identity.loggedIn) {
            pool.update(account.id, {
              limits: null,
              checkedAt: Date.now(),
              error: '尚未登录或登录已失效',
            });
            publishPool();
            continue;
          }
          const active = [...runs.values()].find(
            (run) =>
              (store.get(run.sessionId).session.accountId ?? 'default') === account.id &&
              run.controls.refresh,
          );
          if (active?.controls.refresh) await active.controls.refresh();
          else {
            const controller = new AbortController();
            poolProbes.set(account.id, controller);
            const probeId =
              account.id === 'default' ? '00000000-0000-4000-8000-000000000000' : account.id;
            try {
              const events = await readNativeStatus(
                claude,
                store.directory,
                probeId,
                probeId,
                controller.signal,
              );
              const metrics = events.find((event) => event.type === 'native.metrics');
              if (!closing && metrics?.type === 'native.metrics')
                pool.observe(account.id, metrics.rateLimits, metrics.errors?.usage);
            } finally {
              poolProbes.delete(account.id);
            }
          }
        } catch {
          if (!closing)
            pool.update(account.id, {
              checkedAt: Date.now(),
              error: '检测失败，请检查此账号的登录状态与服务网络',
            });
        }
        publishPool();
      }
    })().finally(() => {
      pool.refreshing = false;
      poolRefresh = undefined;
      publishPool();
    });
    return poolRefresh;
  }
  async function refreshFor(run: Run) {
    let abort!: () => void;
    const stopped = new Promise<void>((resolve) => {
      abort = resolve;
      run.controller.signal.addEventListener('abort', abort, { once: true });
      if (run.controller.signal.aborted) resolve();
    });
    try {
      await Promise.race([refreshPool(), stopped]);
    } finally {
      run.controller.signal.removeEventListener('abort', abort);
    }
  }
  async function logoutAccount(id: string) {
    const claude = pool!.options(id);
    pool!.locked.add(id);
    publishPool();
    try {
      await accountLogout(claude.executable, claude.environment);
      pool!.update(id, {
        loggedIn: false,
        email: undefined,
        subscriptionType: undefined,
        limits: null,
        checkedAt: Date.now(),
        error: undefined,
        blockedUntil: null,
      });
    } finally {
      pool!.locked.delete(id);
      publishPool();
    }
  }
  async function poolCommand(peer: Peer, command: Extract<Command, { type: `pool.${string}` }>) {
    if (!pool) throw new DomainError('native_unavailable', '请连接已升级的 Claude Code 代理服务。');
    peer.poolClient = true;
    if (command.type === 'pool.status') {
      publishPool(peer);
      if (command.refresh || pool.accounts.some((account) => account.checkedAt === null))
        track(refreshPool());
      return;
    }
    if (command.type === 'pool.add') {
      pool.add(command.requestId, command.name);
      publishPool();
      return;
    }
    if (command.type === 'pool.configure') {
      pool.configure(command.values);
      for (const run of runs.values()) {
        run.controls.quotaPolicyChanged?.();
        run.wakeQuota?.();
      }
      publishPool();
      return;
    }
    const id = command.accountId;
    const account = pool.get(id);
    if (command.type === 'pool.account.update') {
      pool.update(id, {
        ...(command.name !== undefined ? { name: command.name } : {}),
        ...(command.enabled !== undefined ? { enabled: command.enabled } : {}),
      });
      publishPool();
      return;
    }
    if (id === 'default' && login)
      throw new DomainError('login_active', '原有账号正在其他页面登录，请先完成该流程。');
    const current = poolLogins.get(id);
    if (command.type === 'pool.account.code') {
      if (!current?.url || current.owner !== peer)
        throw new DomainError('login_inactive', '请在发起登录的窗口完成授权，或重新获取链接。');
      current.process.submit(command.code);
      return;
    }
    if (command.type === 'pool.account.cancel') {
      current?.process.cancel();
      return;
    }
    if (accountBusy(id) || pool.refreshing)
      throw new DomainError('account_busy', '请等待该账号的任务或额度检测结束，再管理登录。');
    if (current) throw new DomainError('login_active', '该账号已经在等待授权。');
    const claude = pool.options(id);
    if (command.type === 'pool.account.logout') {
      await logoutAccount(id);
      return;
    }
    pool.update(id, { error: undefined, limits: null });
    const signing: Login = {
      owner: peer,
      process: new NativeLogin(
        claude.executable,
        (succeeded) => {
          if (poolLogins.get(id) === signing) poolLogins.delete(id);
          if (closing) return;
          pool.update(id, {
            login: null,
            error:
              succeeded || signing.process.cancelled ? undefined : '登录未完成，请重新获取授权链接',
          });
          if (succeeded) completeOnboarding(claude.environment?.CLAUDE_CONFIG_DIR);
          publishPool();
          track(refreshPool());
        },
        (notice) => {
          if (!closing) {
            pool.update(id, { error: notice });
            publishPool();
          }
        },
        undefined,
        undefined,
        claude.environment,
      ),
    };
    poolLogins.set(id, signing);
    try {
      signing.url = await signing.process.url;
    } catch {
      throw new DomainError('login_failed', '官方登录命令未返回链接，请检查 CLI 和网络。');
    }
    pool.update(id, { login: { url: signing.url } });
    publishPool();
  }

  // Stores an event and sends it to the session's subscribers; quota readings also drive the usage periods.
  function record(sessionId: string, runId: string, payload: EventPayload) {
    const accountId = store.get(sessionId).session.accountId ?? 'default';
    if (payload.type === 'native.metrics' && pool) {
      pool.observe(accountId, payload.rateLimits, payload.errors?.usage);
      publishPool();
    }
    if (
      payload.type === 'native.metrics' &&
      payload.rateLimits?.available &&
      accountId === 'default'
    )
      usage.observe(payload.rateLimits);
    const event = store.append(sessionId, runId, payload);
    broadcast({ type: 'session.event', event }, sessionId);
    return event;
  }
  // Records what has arrived of the output the run is in the middle of.
  function settle(run: Run) {
    const open = run.open;
    if (!open) return;
    run.open = undefined;
    record(run.sessionId, run.id, open);
  }
  function emit(run: Run, payload: EventPayload) {
    // A background task's word of itself is for whoever is watching now.
    if (payload.type === 'native.progress') {
      broadcast(
        { type: 'session.fragment', sessionId: run.sessionId, runId: run.id, payload },
        run.sessionId,
      );
      return;
    }
    if (isFragment(payload)) {
      if (run.open && !continues(run.open, payload)) settle(run);
      run.open = run.open ? { ...run.open, text: run.open.text + payload.text } : payload;
      broadcast(
        { type: 'session.fragment', sessionId: run.sessionId, runId: run.id, payload },
        run.sessionId,
      );
      // Very long output is recorded a part at a time, so that what is held here stays small.
      if (run.open.text.length >= OPEN_LIMIT) settle(run);
      return;
    }
    settle(run);
    record(run.sessionId, run.id, payload);
    if (payload.type === 'native.session') store.handoffSubmitted(run.sessionId);
    if (payload.type === 'native.title' && store.get(run.sessionId).session.autoTitle)
      broadcast({
        type: 'session.updated',
        session: store.renameNative(run.sessionId, payload.title),
      });
    if (payload.type === 'native.compact') store.compacted(run.sessionId);
    if (payload.type === 'run.status') updated(run.sessionId);
  }
  // The CLI reports its model requests a moment after the turn ends. Wait for as many as the turn made, then
  // record what they add up to; whatever has not come by then is left out and the figures are marked partial.
  async function turnStats(
    run: Run,
    turn: {
      messageId?: string;
      startedAt: number;
      endedAt: number;
      requests: number;
      outputTokens: number;
      promptIds: string[];
    },
  ) {
    // Complete once every request of the main loop is there and the records add up to the output the CLI counted for the
    // turn, which includes its subagents. Subagent records must not stand in for a main request that is still on its way.
    const complete = (stats: { mainRequests: number; outputTokens: number }) =>
      stats.mainRequests >= turn.requests && stats.outputTokens >= turn.outputTokens;
    const nativeId = run.nativeId ?? run.sessionId;
    let stats = usage.turnStats(nativeId, turn);
    // Without a count of requests to wait for, give the usual export delay one chance.
    for (let waited = 0; waited < 8000; waited += 500) {
      if (turn.requests ? complete(stats) : waited >= 3000) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
      stats = usage.turnStats(nativeId, turn);
    }
    const { mainRequests, ...figures } = stats;
    if (figures.requests)
      emit(run, {
        type: 'turn.stats',
        messageId: turn.messageId,
        ...figures,
        partial: !complete(stats),
      });
  }
  function finish(run: Run, status: 'completed' | 'cancelled' | 'failed', reason?: string) {
    if (runs.get(run.sessionId) !== run) return;
    run.input?.close();
    if (run.toolId && !run.toolFinished) {
      emit(run, {
        type: 'tool.result',
        toolId: run.toolId,
        status: 'cancelled',
        output: '模拟工具未执行。',
        exitCode: null,
      });
    }
    emit(run, { type: 'run.status', status, reason, connectionId: run.connectionId });
    runs.delete(run.sessionId);
    publishPool();
    run.controller.abort();
    run.decide?.(false);
    for (const decide of run.approvals.values()) decide(false);
    run.approvals.clear();
  }
  // A native run ends through its own adapter, which reports what is known about in-flight tools first.
  function cancel(run: Run, reason: string) {
    if (!options.claude) {
      finish(run, 'cancelled', reason);
      return;
    }
    run.cancelReason = reason;
    run.input?.close();
    run.controller.abort();
    for (const decide of run.approvals.values()) decide(false);
    run.approvals.clear();
  }
  function nativeRoot(sessionId: string) {
    return store.get(sessionId).session.nativeRoot ?? sessionId;
  }
  function resumesAfterQuota(run: Run) {
    return projectQuota.enabled(run.device, store.get(run.sessionId).session.projectPath);
  }
  // The CLI has exited before this timer is armed; no process or tool is replayed while waiting.
  async function waitForQuotaReset(run: Run, resetsAt: string | undefined) {
    const reset = Date.parse(resetsAt ?? '');
    if (!Number.isFinite(reset)) {
      emit(run, { type: 'native.notice', text: '未取得额度重置时间，请检测账号额度后手动继续。' });
      return false;
    }
    // A stale rejection must not create a tight loop of billable requests.
    const deadline = reset > Date.now() ? reset + 1000 : Date.now() + 30_000;
    run.quotaWaiting = true;
    run.quotaDeadline = {
      accountId: store.get(run.sessionId).session.accountId ?? 'default',
      at: deadline,
    };
    publishPool();
    emit(run, {
      type: 'native.notice',
      text: `等待额度重置（${new Date(deadline).toISOString()}），随后自动发送 continue。`,
    });
    try {
      while (Date.now() < deadline && resumesAfterQuota(run) && !run.controller.signal.aborted) {
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            run.controller.signal.removeEventListener('abort', done);
            run.wakeQuota = undefined;
            resolve();
          };
          const timer = setTimeout(done, Math.min(deadline - Date.now(), 30_000));
          run.wakeQuota = done;
          run.controller.signal.addEventListener('abort', done, { once: true });
          if (run.controller.signal.aborted) done();
        });
      }
      return resumesAfterQuota(run) && !run.controller.signal.aborted;
    } finally {
      run.quotaWaiting = false;
      run.quotaDeadline = undefined;
      publishPool();
    }
  }
  async function native(run: Run) {
    try {
      while (!run.controller.signal.aborted) {
        const { session } = store.get(run.sessionId);
        const accountId = session.accountId ?? 'default';
        const claude = pool!.options(accountId);
        run.nativeId = session.nativeSessionId ?? session.id;
        const ssh = seats.get(run.device)!.door!.ssh!;
        const said = store.promptValues(run.sessionId);
        let quota: Extract<EventPayload, { type: 'run.error' }> | undefined;
        const status = await runClaude(claude, {
          sessionId: run.sessionId,
          nativeSessionId: run.nativeId,
          stopAtQuota: () => pool!.settings.enabled || resumesAfterQuota(run),
          nativeRoot: session.nativeRoot ?? session.id,
          projectPath: said.projectPath,
          platform: said.platform,
          permissionMode: session.permissionMode,
          model: session.model,
          effort: session.effort,
          input: run.input!,
          controls: run.controls,
          waiting: (background) =>
            emit(run, {
              type: 'run.status',
              status: 'running',
              connectionId: run.connectionId,
              ...(background ? { waiting: 'background' as const } : {}),
            }),
          turnEnded: (turn) => track(turnStats(run, turn).catch(() => {})),
          dataDir: store.directory,
          resume: store.hasNativeContext(run.sessionId),
          signal: run.controller.signal,
          ssh: sessionSsh(store.directory, run.sessionId, ssh),
          emit: (event) => {
            if (event.type === 'run.error' && event.code === 'quota_five_hour') quota = event;
            emit(run, event);
          },
          approve: (toolId, waiting) => {
            if (run.controller.signal.aborted) return Promise.resolve({ allowed: false });
            const approvalId = randomUUID();
            return new Promise((resolve) => {
              run.approvals.set(approvalId, (allowed, answers) => {
                emit(run, { type: 'approval.resolved', approvalId, allowed });
                resolve({ allowed, answers });
              });
              emit(run, { type: 'approval.requested', approvalId, toolId });
              emit(run, {
                type: 'run.status',
                status: 'awaiting_approval',
                connectionId: run.connectionId,
                waiting,
              });
            });
          },
        });
        const events = store.runEvents(run.sessionId, run.id);
        if (quota) {
          pool!.block(accountId, quota.resetsAt);
          publishPool();
        }
        const blocked = handoffBlockReason(events, run.id);
        if (
          status !== 'failed' ||
          run.controller.signal.aborted ||
          (!pool!.settings.enabled && !resumesAfterQuota(run)) ||
          !quota ||
          blocked
        ) {
          if (status === 'failed' && quota && !run.controller.signal.aborted)
            emit(run, {
              type: 'native.notice',
              text:
                !pool!.settings.enabled && !resumesAfterQuota(run)
                  ? '自动接力未开启。开启账号池自动接力后，可手动继续当前任务。'
                  : `自动接力已暂停：${blocked}`,
            });
          if (status === 'failed' && !quota)
            pool!.update(accountId, { error: '本次运行异常，请检测账号后再参与自动调度' });
          finish(run, status, run.cancelReason);
          return;
        }
        run.attempted ??= new Set();
        run.attempted.add(accountId);
        publishPool();
        if (pool!.settings.enabled) await refreshFor(run);
        let next = pool!.settings.enabled
          ? orderedAccounts(pool!.snapshot(), [...run.attempted, ...pool!.locked])[0]
          : undefined;
        let resumedAfterReset = false;
        let announcedProjectWait = false;
        if (!next && !resumesAfterQuota(run))
          emit(run, {
            type: 'native.notice',
            text: '账号池暂时没有可用额度，任务已暂停；服务端会检测额度恢复后继续。可以随时停止。',
          });
        while (
          !next &&
          !run.controller.signal.aborted &&
          (pool!.settings.enabled || resumesAfterQuota(run))
        ) {
          if (resumesAfterQuota(run) && !pool!.settings.enabled) {
            const resetsAt =
              quota.resetsAt ??
              pool!.get(accountId).limits?.windows.find((window) => window.name === 'five_hour')
                ?.resetsAt ??
              undefined;
            if (!(await waitForQuotaReset(run, resetsAt))) {
              finish(run, 'cancelled', run.cancelReason ?? '已取消额度重置后自动继续。');
              return;
            }
            const account = pool!.get(accountId);
            if (!account.enabled || account.loggedIn !== true || pool!.locked.has(accountId)) {
              finish(run, 'failed', '账号已停用或未登录，请手动继续。');
              return;
            }
            next = account;
            resumedAfterReset = true;
            break;
          }
          run.quotaWaiting = true;
          const reset = nextAccountReset(pool!.accounts, [...pool!.locked]);
          publishPool();
          const projectWait = resumesAfterQuota(run);
          if (projectWait && !announcedProjectWait) {
            announcedProjectWait = true;
            emit(run, {
              type: 'native.notice',
              text: '等待最早可用账号重置，随后自动发送 continue。',
            });
          }
          await new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(timer);
              run.controller.signal.removeEventListener('abort', done);
              run.wakeQuota = undefined;
              resolve();
            };
            const remaining = reset ? reset.at + 1000 - Date.now() : 30_000;
            const timer = setTimeout(done, remaining > 0 ? Math.min(remaining, 30_000) : 30_000);
            run.wakeQuota = done;
            run.controller.signal.addEventListener('abort', done, { once: true });
            if (run.controller.signal.aborted) done();
          });
          if (run.controller.signal.aborted) break;
          if (projectWait && !resumesAfterQuota(run)) {
            finish(run, 'cancelled', '已取消额度重置后自动继续。');
            return;
          }
          if (resumesAfterQuota(run) && !pool!.settings.enabled) continue;
          if (pool!.settings.enabled) {
            await refreshFor(run);
            next = orderedAccounts(pool!.snapshot(), [...pool!.locked])[0];
            resumedAfterReset = !!next;
          }
        }
        run.quotaWaiting = false;
        publishPool();
        if (
          !next ||
          run.controller.signal.aborted ||
          !seats.get(run.device)?.door?.ssh ||
          (!pool!.settings.enabled && !resumedAfterReset)
        ) {
          finish(
            run,
            run.controller.signal.aborted ? 'cancelled' : 'failed',
            run.cancelReason ?? '账号池续接已暂停。',
          );
          return;
        }
        const source = pool!.get(accountId).name;
        const selected = store.selectAccount(run.sessionId, next.id);
        emit(run, {
          type: 'native.notice',
          text:
            next.id === accountId
              ? resumedAfterReset
                ? `已到额度重置时间，向 ${next.name} 的原会话发送 continue。`
                : `账号 ${next.name} 的额度已恢复，继续原生会话。`
              : `账号池续接：${source} → ${next.name}。本机项目和当前会话保留，使用最近对话与任务进度继续。`,
        });
        updated(run.sessionId);
        const messageId = randomUUID();
        const prompt =
          next.id !== accountId
            ? `${poolHandoff(store.history(run.sessionId, randomUUID(), 0).events)}\n\ncontinue`
            : resumedAfterReset
              ? 'continue'
              : CONTINUE;
        run.input = new NativeInput(selected.nativeSessionId ?? selected.id, (event) =>
          emit(run, event),
        );
        emit(run, {
          type: 'message.user',
          messageId,
          text: 'continue',
          scenario: 'chat',
          continued: true,
        });
        run.input.submit(messageId, prompt);
      }
      finish(run, 'cancelled', run.cancelReason);
    } catch {
      emit(run, {
        type: 'run.error',
        code: 'native_adapter_failed',
        message: '原生进程适配失败；请检查服务配置和 CLI 版本。',
      });
      finish(run, run.controller.signal.aborted ? 'cancelled' : 'failed', run.cancelReason);
    }
  }

  async function publishAccount(target?: Peer, notice?: string) {
    const { accountStatus } = await import('./native-account.ts');
    const state: AccountState = {
      ...(await accountStatus(options.claude!.executable, options.claude!.environment)),
      login: login?.url ? { url: login.url } : null,
      notice,
    };
    if (pool)
      pool.update('default', {
        loggedIn: state.loggedIn,
        email: state.email,
        subscriptionType: state.subscriptionType,
      });
    if (target) send(target, { type: 'account.state', ...state });
    else broadcast({ type: 'account.state', ...state });
    publishPool();
  }
  async function account(peer: Peer, command: CommandOf<`account.${string}` & Command['type']>) {
    if (!options.claude) throw new DomainError('native_unavailable', '离线模拟没有原生账号。');
    if (command.type === 'account.status') {
      if (pool?.locked.has('default')) return;
      await publishAccount(peer);
      return;
    }
    if (poolLogins.has('default'))
      throw new DomainError('login_active', '原有账号正在账号池页面登录，请在那里完成。');
    if (command.type === 'account.code') {
      if (!login?.url) throw new DomainError('login_inactive', '登录流程已结束，请重新获取链接。');
      login.process.submit(command.code);
      return;
    }
    if (command.type === 'account.cancel') {
      login?.process.cancel();
      return;
    }
    if (
      terminals.size ||
      runs.size ||
      mutations.size ||
      pool?.refreshing ||
      pool?.locked.has('default')
    )
      throw new DomainError('native_busy', '请先结束原生运行或终端，再管理账号。');
    if (command.type === 'account.logout') {
      login?.process.cancel();
      try {
        await logoutAccount('default');
      } catch {
        throw new DomainError('logout_failed', '退出登录失败，请在原生终端执行 /logout 确认。');
      }
      await publishAccount();
      return;
    }
    if (!login) {
      const current: Login = {
        owner: peer,
        process: new NativeLogin(
          options.claude.executable,
          (succeeded) => {
            if (login === current) login = undefined;
            if (closing) return;
            if (succeeded) completeOnboarding(options.claude?.environment?.CLAUDE_CONFIG_DIR);
            track(
              publishAccount(
                undefined,
                succeeded || current.process.cancelled
                  ? undefined
                  : '登录未完成；请重新获取链接后再试。',
              ).catch(() => {}),
            );
          },
          (text) => {
            if (closing || login !== current) return;
            track(publishAccount(undefined, text).catch(() => {}));
          },
          undefined,
          undefined,
          options.claude.environment,
        ),
      };
      login = current;
      try {
        current.url = await current.process.url;
      } catch {
        throw new DomainError('login_failed', '官方登录命令没有给出授权链接，请检查 CLI 与网络。');
      }
    }
    await publishAccount();
  }

  // Starts the CLI without a prompt to read its account, model and quota state.
  async function readStatus(peer: Peer, command: CommandOf<'session.status'>) {
    if (!options.claude) throw new DomainError('native_unavailable', '离线模拟没有原生账号状态。');
    // During a run its own CLI answers, so quota can be reread without waiting for the turn to end.
    const active =
      runs.get(command.sessionId) ??
      [...runs.values()].find(
        (run) =>
          run.controls.refresh &&
          (store.get(run.sessionId).session.accountId ?? 'default') ===
            (store.get(command.sessionId).session.accountId ?? 'default'),
      );
    if (active?.controls.refresh && !mutations.size) {
      await active.controls.refresh();
      return;
    }
    if (terminals.size || runs.size || mutations.size)
      throw new DomainError('native_busy', '运行结束后再刷新原生状态。');
    mutations.add(command.sessionId);
    const controller = new AbortController();
    const closed = () => controller.abort();
    peer.socket.once('close', closed);
    try {
      const events = await readNativeStatus(
        pool!.options(store.get(command.sessionId).session.accountId ?? 'default'),
        store.directory,
        nativeRoot(command.sessionId),
        store.get(command.sessionId).session.nativeSessionId ?? command.sessionId,
        controller.signal,
      );
      for (const payload of events) {
        const event = record(command.sessionId, command.requestId, payload);
        if (!peer.subscriptions.has(command.sessionId))
          send(peer, { type: 'session.event', event });
      }
      updated(command.sessionId);
    } finally {
      peer.socket.removeListener('close', closed);
      mutations.delete(command.sessionId);
    }
  }
  async function closeTerminal(peer: Peer, command: CommandOf<'terminal.close'>) {
    const terminal = terminals.get(command.sessionId);
    if (!terminal || terminal.id !== command.terminalId)
      throw new DomainError('terminal_inactive', '原生终端已结束。');
    if (terminal.owner !== peer) throw new DomainError('not_owner', '原生终端属于另一连接。');
    await terminal.process?.close();
  }
  // The terminal occupies its session like a run does, so other connections see it as busy.
  async function openTerminal(peer: Peer, command: CommandOf<'terminal.open'>, session: Session) {
    if (!options.claude) throw new DomainError('native_unavailable', '离线模拟不启动原生终端。');
    if (terminals.has(command.sessionId) || runs.has(command.sessionId) || mutations.size)
      throw new DomainError('native_busy', '请先结束这个会话的运行或会话管理，再打开终端。');
    const ssh = peer.tunnel?.ssh && seats.get(deviceOf(peer).id)?.door?.ssh;
    if (!ssh) throw new DomainError('execution_offline', '本机的执行通道尚未就绪。');
    onDevice(peer, session);
    room();
    const selectedAccount = pool!.choose(
      session.accountId ?? (store.hasNativeContext(session.id) ? 'default' : undefined),
    );
    if (poolLogins.has(selectedAccount.id) || (selectedAccount.id === 'default' && login))
      throw new DomainError('login_active', '请先完成此账号的登录。');
    session = store.selectAccount(session.id, selectedAccount.id);
    const current: Terminal = { id: randomUUID(), sessionId: command.sessionId, owner: peer };
    terminals.set(current.sessionId, current);
    try {
      const { NativeTerminal, terminalArguments, terminalEnvironment } =
        await import('./native-terminal.ts');
      if (closing || peer.socket.readyState !== WebSocket.OPEN)
        throw new Error('Connection closed');
      const claude = pool!.options(session.accountId ?? pool!.settings.preferredId);
      completeOnboarding(claude.environment?.CLAUDE_CONFIG_DIR);
      current.process = new NativeTerminal(
        claude.executable,
        terminalArguments(claude, session, sessionSsh(store.directory, session.id, ssh)),
        {
          cwd: prepareNativeDirectory(claude, store.directory, nativeRoot(session.id)),
          cols: command.cols,
          rows: command.rows,
          env: terminalEnvironment(claude),
        },
        (data, bytes) =>
          send(peer, {
            type: 'terminal.data',
            sessionId: current.sessionId,
            terminalId: current.id,
            data,
            bytes,
          }),
        (exitCode) => {
          if (terminals.get(current.sessionId) !== current) return;
          store.append(current.sessionId, current.id, {
            type: 'run.status',
            status: 'completed',
            surface: 'terminal',
            connectionId: peer.id,
          });
          updated(current.sessionId);
          send(peer, {
            type: 'terminal.closed',
            sessionId: current.sessionId,
            terminalId: current.id,
            exitCode,
          });
          terminals.delete(current.sessionId);
        },
      );
      store.append(command.sessionId, current.id, {
        type: 'run.status',
        status: 'running',
        surface: 'terminal',
        connectionId: peer.id,
      });
      updated(command.sessionId);
      send(peer, { type: 'terminal.opened', sessionId: command.sessionId, terminalId: current.id });
    } catch {
      await current.process?.close();
      if (terminals.get(current.sessionId) === current) terminals.delete(current.sessionId);
      throw new DomainError('terminal_failed', '原生终端启动失败，请检查 Linux PTY 组件与 CLI。');
    }
  }
  // Rename and delete change the native session first; the proxy record follows only when that succeeded.
  async function manageSession(
    command: CommandOf<'session.delete' | 'session.rename'>,
    session: Session,
  ) {
    if (session.activeRun) throw new DomainError('run_active', '请先结束当前运行再管理会话。');
    mutations.add(command.sessionId);
    try {
      if (options.claude) {
        const segments =
          command.type === 'session.delete'
            ? store.nativeSegments(session.id)
            : [
                {
                  id: session.nativeSessionId ?? session.id,
                  accountId: session.accountId ?? 'default',
                  root: nativeRoot(session.id),
                },
              ];
        for (const segment of segments) {
          const claude = pool!.options(segment.accountId);
          const nativeOptions = { dir: nativeDirectory(store.directory, segment.root) };
          if (!(await nativeStore(claude, 'info', segment.id, nativeOptions))) continue;
          if (command.type === 'session.delete')
            await nativeStore(claude, 'delete', segment.id, nativeOptions);
          else await nativeStore(claude, 'rename', segment.id, nativeOptions, command.title);
        }
      }
      if (command.type === 'session.delete') {
        store.delete(command.sessionId);
        rmSync(sessionSshPath(store.directory, command.sessionId), { force: true });
        broadcast({ type: 'session.deleted', sessionId: command.sessionId });
        for (const other of peers) other.subscriptions.delete(command.sessionId);
      } else {
        broadcast({
          type: 'session.updated',
          session: store.rename(command.sessionId, command.title),
        });
      }
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        'native_mutation_failed',
        '原生会话更新失败，代理记录保留。请检查原生存储与权限。',
      );
    } finally {
      mutations.delete(command.sessionId);
    }
  }
  // A fork is the native session copied under a new ID, together with the proxy's record of it. The SDK cuts
  // a copy after a message and only knows the source's message IDs, so stopping before a message takes two
  // copies: one through that message, then one of it up to the entry before its last.
  async function fork(peer: Peer, command: CommandOf<'session.fork'>, session: Session) {
    if (session.activeRun) throw new DomainError('run_active', '请先结束当前运行再分叉会话。');
    const place = { device: deviceOf(peer), projectPath: command.projectPath };
    const existing = store.created(command.requestId);
    if (existing) return existing.id;
    const before = command.beforeMessageId
      ? store.forkPoint(command.sessionId, command.beforeMessageId)
      : undefined;
    const title = `${session.title.slice(0, 116)}（分叉）`;
    let id: string = randomUUID();
    let resumable = false;
    mutations.add(command.sessionId);
    try {
      if (options.claude && store.hasNativeContext(command.sessionId)) {
        const dir = nativeDirectory(store.directory, nativeRoot(command.sessionId));
        const claude = pool!.options(session.accountId ?? 'default');
        const nativeId = session.nativeSessionId ?? session.id;
        if (!command.beforeMessageId) {
          id = (await nativeStore(claude, 'fork', nativeId, { dir, title })).sessionId;
          resumable = true;
        } else {
          const through = await nativeStore(claude, 'fork', nativeId, {
            dir,
            upToMessageId: command.beforeMessageId,
          });
          try {
            const kept = (await nativeStore(claude, 'messages', through.sessionId, { dir })).at(-2);
            // Nothing before the message: the fork starts a native session of its own.
            if (kept) {
              id = (
                await nativeStore(claude, 'fork', through.sessionId, {
                  dir,
                  upToMessageId: kept.uuid,
                  title,
                })
              ).sessionId;
              resumable = true;
            }
          } finally {
            await nativeStore(claude, 'delete', through.sessionId, { dir });
          }
        }
      }
      const created = store.fork(
        command.requestId,
        command.sessionId,
        id,
        title,
        resumable,
        place,
        before,
      );
      broadcast({ type: 'session.updated', session: created });
      return created.id;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        'native_mutation_failed',
        '原生会话分叉失败，未创建新会话。该位置可能不在原生记录中。',
      );
    } finally {
      mutations.delete(command.sessionId);
    }
  }
  // Prefixing a slash command with a handoff or a move notice turns it into ordinary prompt text.
  function assertCommandContext(session: Session, text: string) {
    if (!options.claude || !/^\/[a-z][\w:-]*(?:\s|$)/i.test(text)) return;
    const known = session.prompt?.told ?? session.prompt;
    if (
      session.accountHandoff ||
      (known &&
        !session.prompt?.compacted &&
        (known.projectPath !== session.projectPath || known.device !== session.device?.id))
    )
      throw new DomainError(
        'command_context_changed',
        '账号或项目已切换，请先发送一条普通消息衔接上下文，再使用指令。',
      );
  }
  // A message starts a run, or joins the native run this connection already owns. Compacting is the native
  // /compact command sent as a message.
  function submit(
    peer: Peer,
    command: CommandOf<'message.send' | 'session.compact' | 'run.continue'>,
    session: Session,
  ) {
    if (command.type === 'session.compact' && !options.claude)
      throw new DomainError('native_unavailable', '离线模拟不提供原生上下文压缩。');
    if (command.type === 'session.compact' && !store.hasNativeContext(command.sessionId))
      throw new DomainError('native_context_missing', '先建立原生会话再压缩上下文。');
    const continued = command.type === 'run.continue';
    if (continued && session.activeRun) throw new DomainError('run_active', '当前会话正在运行。');
    const text =
      command.type === 'session.compact' ? '/compact' : continued ? CONTINUE : command.text;
    const scenario = command.type === 'message.send' ? command.scenario : 'chat';
    // A repeated request ID is the same message arriving again, not a second message.
    const existing = store.userMessage(command.sessionId, command.requestId);
    if (existing?.payload.type === 'message.user') {
      if (existing.payload.text !== text || existing.payload.scenario !== scenario)
        throw new DomainError('request_conflict', '请求 ID 已被其他内容使用。');
      return;
    }
    if (session.activeRun) {
      const active = runs.get(command.sessionId);
      if (!options.claude || command.type !== 'message.send' || !active?.input)
        throw new DomainError('run_active', '当前会话正在运行。');
      if (active.device !== deviceOf(peer).id)
        throw new DomainError('not_owner', '该运行属于另一台设备。');
      if (active.controller.signal.aborted)
        throw new DomainError('run_finishing', '原生运行正在停止，请稍后发送。');
      if (active.quotaWaiting)
        throw new DomainError(
          'quota_waiting',
          '正在等待额度重置；如需发送其他消息，请先停止等待。',
        );
      assertCommandContext(session, text);
      active.input.assertWritable();
      peer.subscriptions.add(command.sessionId);
      emit(active, { type: 'message.user', messageId: command.requestId, text, scenario });
      active.input.submit(command.requestId, store.notice(command.sessionId) + text);
      return;
    }
    if (options.claude && mutations.size)
      throw new DomainError('native_busy', '原生状态正在读取，请稍后发送。');
    if (options.claude && !(peer.tunnel?.ssh && seats.get(deviceOf(peer).id)?.door?.ssh))
      throw new DomainError(
        'execution_offline',
        '本机的执行通道尚未就绪，请稍候；客户端正在建立或重新建立连接。',
      );
    onDevice(peer, session);
    room();
    if (pool) {
      const current =
        session.accountId ?? (store.hasNativeContext(session.id) ? 'default' : undefined);
      const selected = pool.choose(current);
      if (poolLogins.has(selected.id) || (selected.id === 'default' && login))
        throw new DomainError('login_active', '所选账号正在登录，请稍后发送。');
      const previous = session.accountId ?? 'default';
      const changed = store.selectAccount(session.id, selected.id);
      if (previous !== selected.id && changed.accountHandoff)
        record(session.id, command.requestId, {
          type: 'native.notice',
          text: `任务使用 ${selected.name} 继续；当前会话和本机项目保留，最近上下文将用于续接。`,
        });
      session = changed;
      updated(session.id);
    }
    assertCommandContext(session, text);
    peer.subscriptions.add(command.sessionId);
    const run: Run = {
      id: randomUUID(),
      sessionId: command.sessionId,
      device: deviceOf(peer).id,
      connectionId: peer.id,
      controller: new AbortController(),
      toolFinished: false,
      approvals: new Map(),
      controls: {},
    };
    runs.set(command.sessionId, run);
    if (options.claude)
      run.input = new NativeInput(session.nativeSessionId ?? run.sessionId, (event) =>
        emit(run, event),
      );
    emit(run, {
      type: 'message.user',
      messageId: command.requestId,
      text,
      scenario,
      ...(continued ? { continued } : {}),
    });
    emit(run, { type: 'run.status', status: 'running', connectionId: run.connectionId });
    // What Claude's system prompt no longer has right is told to it with this message; the transcript shows the
    // user's own text.
    run.input?.submit(
      command.requestId,
      session.accountHandoff
        ? poolHandoff(store.history(session.id, randomUUID(), 0).events)
        : store.notice(command.sessionId) + text,
    );
    track(
      options.claude
        ? native(run)
        : simulate(
            run,
            { ...command, type: 'message.send', text, scenario },
            {
              stepMs: options.stepMs ?? 110,
              projectPath: () => store.get(run.sessionId).session.projectPath,
              emit: (payload) => emit(run, payload),
              finish: (status, reason) => finish(run, status, reason),
            },
          ),
    );
  }
  function controlRun(
    peer: Peer,
    command: CommandOf<'run.cancel' | 'run.task.stop' | 'approval.reply'>,
  ) {
    const run = runs.get(command.sessionId);
    if (!run || run.id !== command.runId)
      throw new DomainError('run_inactive', '运行已结束，操作未生效。');
    if (run.device !== deviceOf(peer).id)
      throw new DomainError('not_owner', '该运行属于另一台设备。');
    if (command.type === 'run.task.stop') {
      if (!run.controls.stopTask) throw new DomainError('task_inactive', '后台任务已经结束。');
      // The CLI reports the task gone through its task list; a task already over is not an error.
      void run.controls.stopTask(command.taskId).catch(() => {});
      return;
    }
    if (command.type === 'run.cancel') {
      cancel(
        run,
        options.claude
          ? '用户停止；已发出的 SSH 命令可能继续执行，副作用未撤销，不能自动重试。'
          : '用户停止',
      );
      return;
    }
    if (options.claude) {
      const decide = run.approvals.get(command.approvalId);
      if (!decide) throw new DomainError('approval_inactive', '审批已失效。');
      run.approvals.delete(command.approvalId);
      decide(command.allowed, command.answers);
      if (!run.approvals.size)
        emit(run, { type: 'run.status', status: 'running', connectionId: peer.id });
      return;
    }
    if (!run.decide || run.approvalId !== command.approvalId)
      throw new DomainError('approval_inactive', '审批已失效。');
    const decide = run.decide;
    run.decide = undefined;
    decide(command.allowed, command.answers);
  }

  // Resolves to the session ID carried in the response frame; account and usage commands have none.
  async function execute(peer: Peer, command: Command): Promise<string | undefined> {
    switch (command.type) {
      case 'project.quotaResume': {
        if (!pool) throw new DomainError('native_unavailable', '此服务不支持自动继续。');
        peer.poolClient = true;
        const device = deviceOf(peer);
        projectQuota.set(device.id, command.projectPath, command.enabled);
        for (const run of runs.values()) {
          run.controls.quotaPolicyChanged?.();
          run.wakeQuota?.();
        }
        publishPool();
        return undefined;
      }
      case 'pool.status':
      case 'pool.add':
      case 'pool.configure':
      case 'pool.account.update':
      case 'pool.account.login':
      case 'pool.account.logout':
      case 'pool.account.cancel':
      case 'pool.account.code':
        await poolCommand(peer, command);
        return undefined;
      case 'account.status':
      case 'account.login':
      case 'account.code':
      case 'account.cancel':
      case 'account.logout':
        await account(peer, command);
        return undefined;
      case 'settings.get':
      case 'settings.update': {
        if (!options.claude) throw new DomainError('native_unavailable', '离线模拟没有原生设置。');
        try {
          const path = settingsPath(
            pool!.options(command.accountId ?? 'default').environment?.CLAUDE_CONFIG_DIR,
          );
          const values =
            command.type === 'settings.get'
              ? readNativeSettings(path)
              : updateNativeSettings(command.values, path);
          send(peer, { type: 'settings.state', requestId: command.requestId, values });
        } catch {
          throw new DomainError(
            'settings_failed',
            '原生设置文件无法读取或写入；请在原生终端用 /config 检查。',
          );
        }
        return undefined;
      }
      case 'usage.summary':
        send(peer, { type: 'usage.summary', requestId: command.requestId, ...usage.summary() });
        return undefined;
      case 'service.update.check':
        if (!updates) throw new DomainError('updates_unavailable', '此服务未启用版本跟踪。');
        await updates.check();
        return undefined;
      case 'service.update.install':
        if (!updates) throw new DomainError('updates_unavailable', '此服务未启用版本跟踪。');
        // The restart at the end would cut these off.
        if (
          terminals.size ||
          runs.size ||
          mutations.size ||
          login ||
          poolLogins.size ||
          pool?.refreshing
        )
          throw new DomainError('native_busy', '请先结束运行、终端或登录流程，再升级服务端。');
        try {
          updates.install(command.version);
        } catch (error) {
          throw new DomainError('update_unavailable', (error as Error).message);
        }
        return undefined;
      case 'usage.query': {
        const titles = new Map(store.list().map((session) => [session.id, session.title]));
        const logical = new Map(
          store.database
            .prepare('SELECT native_id, session_id FROM native_segments')
            .all()
            .map((row) => [String(row.native_id), String(row.session_id)]),
        );
        const page = usage.query(command, (id) => titles.get(logical.get(id) ?? id) ?? null);
        page.rows = page.rows.map((row) => ({
          ...row,
          sessionId: row.sessionId ? (logical.get(row.sessionId) ?? row.sessionId) : null,
        }));
        send(peer, {
          type: 'usage.page',
          requestId: command.requestId,
          ...page,
        });
        return undefined;
      }
      case 'session.create': {
        const session = store.create(
          command.requestId,
          command.title,
          command.projectPath,
          deviceOf(peer),
        );
        peer.subscriptions.clear();
        peer.subscriptions.add(session.id);
        broadcast({ type: 'session.updated', session });
        return session.id;
      }
    }
    const { session } = store.get(command.sessionId);
    if (mutations.has(command.sessionId))
      throw new DomainError('session_busy', '会话正在更新，请稍后重试。');
    switch (command.type) {
      case 'session.account': {
        if (!pool) throw new DomainError('native_unavailable', '此服务不支持账号池。');
        if (session.activeRun)
          throw new DomainError('run_active', '请先停止当前任务，再手动切换账号。');
        onDevice(peer, session);
        const account = pool.get(command.accountId);
        if (
          !account.enabled ||
          account.loggedIn !== true ||
          poolLogins.has(account.id) ||
          pool.locked.has(account.id)
        )
          throw new DomainError('account_unavailable', '请先登录并启用这个账号。');
        if ((session.accountId ?? 'default') !== account.id) {
          store.selectAccount(session.id, account.id);
          record(session.id, command.requestId, {
            type: 'native.notice',
            text: `已选择 ${account.name}。下一条消息会携带最近对话和任务进度，在同一本机项目继续。`,
          });
          updated(session.id);
        }
        return session.id;
      }
      case 'session.status':
        await readStatus(peer, command);
        return command.sessionId;
      case 'terminal.close':
        await closeTerminal(peer, command);
        return command.sessionId;
      case 'terminal.open':
        await openTerminal(peer, command, session);
        return command.sessionId;
      case 'session.subscribe':
        peer.subscriptions.clear();
        peer.subscriptions.add(command.sessionId);
        send(peer, {
          type: 'session.snapshot',
          ...store.history(command.sessionId, command.requestId, command.afterSequence),
        });
        // The history ends where the run's unfinished output begins.
        {
          const run = runs.get(command.sessionId);
          if (run?.open)
            send(peer, {
              type: 'session.fragment',
              sessionId: run.sessionId,
              runId: run.id,
              payload: run.open,
            });
        }
        return command.sessionId;
      case 'session.history':
        send(peer, {
          type: 'session.snapshot',
          ...store.history(command.sessionId, command.requestId, 0, command.beforeSequence),
        });
        return command.sessionId;
      case 'run.cancel':
      case 'run.task.stop':
      case 'approval.reply':
        controlRun(peer, command);
        return command.sessionId;
    }
    if (terminals.has(command.sessionId))
      throw new DomainError('native_busy', '这个会话的原生终端开着，请先关闭终端再操作它。');
    if (
      updates?.installing &&
      (command.type === 'message.send' || command.type === 'session.compact')
    )
      throw new DomainError('service_upgrading', '服务端正在升级，重启完成后再发送。');
    switch (command.type) {
      case 'session.configure':
        broadcast({
          type: 'session.updated',
          session: store.configure(
            command.sessionId,
            command.permissionMode,
            command.model,
            command.effort,
          ),
        });
        break;
      case 'session.move':
        broadcast({
          type: 'session.updated',
          session: store.move(command.sessionId, command.projectPath, deviceOf(peer)),
        });
        break;
      case 'session.delete':
      case 'session.rename':
        await manageSession(command, session);
        break;
      case 'session.fork':
        return fork(peer, command, session);
      case 'message.send':
      case 'session.compact':
      case 'run.continue':
        submit(peer, command, session);
        break;
    }
    return command.sessionId;
  }

  const installer = () =>
    releases.current
      ? (({ version, size, sha256 }) => ({ version, size, sha256 }))(releases.current)
      : undefined;
  // The first frame must authenticate; a desktop client also asks for its execution channel here.
  function authenticate(peer: Peer, value: unknown) {
    const auth = authSchema.safeParse(value);
    // Only a wrong token counts against the address: an outdated client holding the right one is not guessing.
    const token = (value as { token?: unknown } | null)?.token;
    if (typeof token !== 'string' || !authorized(token)) refuse(peer.address);
    else throttle.succeed(peer.address);
    if (!auth.success || !authorized(auth.data.token)) {
      send(peer, {
        type: 'connection.error',
        code: 'unauthorized',
        message:
          '服务凭据不正确。\n请核对安装时给出的服务凭据，注意不要带上首尾空格；在服务器上更换过凭据后要用新的。连续失败多次会被暂时拒绝。',
      });
      peer.socket.close(4001, 'Unauthorized');
      return false;
    }
    // A client of another version is told which version runs here and, if held, the installer to fetch.
    if (auth.data.protocolVersion !== PROTOCOL_VERSION) {
      // The installer of this version may still be on its way here, or its download may have failed: the
      // client is told how far it is and the download is started again if it is not running.
      const held = installer();
      if (held?.version !== version) updates?.prepareInstaller();
      send(peer, {
        type: 'connection.error',
        code: 'version_mismatch',
        message: `客户端与服务端（${version}）的版本不一致，需要升级其中一方。`,
        service: version,
        client: held,
        ...(held?.version !== version && updates?.preparing
          ? { preparing: updates.preparing }
          : {}),
      });
      peer.socket.close(4002, 'Version mismatch');
      return false;
    }
    peer.authenticated = true;
    peer.name = auth.data.deviceName;
    send(peer, {
      type: 'ready',
      protocolVersion: PROTOCOL_VERSION,
      connectionId: peer.id,
      adapter,
      model: options.claude?.model,
      version,
      update: updates?.state,
      client: installer(),
      sessions: store.list(),
      ...(pool ? { features: ['account-pool', 'project-quota-resume'] } : {}),
    });
    // Every connection that asks has an execution channel of its own, to the computer it comes from.
    if (auth.data.tunnel && options.tunnel) {
      peer.tunnel = new Tunnel(
        options.tunnel,
        store.directory,
        peer.id,
        (channelId) => {
          if (peer.socket.readyState !== WebSocket.OPEN) return false;
          send(peer, { type: 'tunnel.open', connectionId: peer.id, channelId });
          return true;
        },
        () => peer.socket.close(4003, 'Tunnel closed'),
      );
      track(
        peer.tunnel
          .start()
          .then((offer) => send(peer, offer))
          .catch(() => {
            send(peer, {
              type: 'connection.error',
              code: 'tunnel_failed',
              message:
                '服务端没能准备好执行通道。\n请查看服务日志；数据目录不可写或服务器资源耗尽时会出现这种情况。',
            });
            peer.socket.close(4003, 'Tunnel failed');
          }),
        tunnelTasks,
      );
    }
    return true;
  }
  // A connection whose first frame attaches it to a device's tunnel carries one SSH connection and nothing
  // else: it is no peer, receives no message and sends none. Only a wrong secret for a live tunnel counts
  // against the address; a channel arriving after its tunnel ended is an ordinary race of disconnecting.
  function attachChannel(peer: Peer, value: unknown) {
    const attach = tunnelAttachSchema.safeParse(value);
    const tunnel = attach.success
      ? [...peers].find((owner) => owner.authenticated && owner.id === attach.data.connectionId)
          ?.tunnel
      : undefined;
    if (!attach.success || !tunnel) {
      peer.socket.close(TUNNEL_CLOSE.unknown, 'Unknown tunnel');
      return false;
    }
    if (!tunnel.matches(attach.data.secret)) {
      refuse(peer.address, 'tunnel secret');
      peer.socket.close(TUNNEL_CLOSE.refused, 'Unauthorized');
      return false;
    }
    peers.delete(peer);
    peer.socket.removeAllListeners('message');
    if (!tunnel.attach(attach.data.channelId, peer.socket)) {
      peer.socket.close(TUNNEL_CLOSE.unknown, 'Unknown channel');
      return false;
    }
    return true;
  }
  function registerTunnel(peer: Peer, credentials: TunnelCredentials) {
    if (!peer.tunnel || peer.registering || credentials.connectionId !== peer.id) {
      peer.socket.close(4002, 'Inactive tunnel registration');
      return;
    }
    peer.registering = true;
    track(
      peer.tunnel
        .accept(credentials, peer.device?.platform)
        .then(() => adopt(peer))
        .then(() => {
          send(peer, { type: 'tunnel.ready', connectionId: peer.id });
        })
        .catch(() => {
          send(peer, {
            type: 'connection.error',
            code: 'ssh_failed',
            message:
              platformOf(peer.device) === 'win32'
                ? '服务端经隧道连不上本机的 SSH 服务。\n隧道已经建立，但探测命令没有得到应答：常见于安全软件拦截了内置的 sshd.exe 或 PowerShell，请检查保护记录后重新连接。'
                : '服务端经隧道连不上本机的 SSH 服务。\n隧道已经建立，但探测命令没有得到应答：请重新连接；反复出现时在“设置 → 常规”里打开连接日志查看原因。',
          });
          peer.socket.close(4003, 'SSH probe failed');
        }),
      tunnelTasks,
    );
  }
  // Keystrokes, resizes and flow-control acknowledgments carry no request ID and get no response.
  function controlTerminal(peer: Peer, control: TerminalControl) {
    const current = terminals.get(control.sessionId);
    if (!current || current.owner !== peer || current.id !== control.terminalId) {
      send(peer, {
        type: 'connection.error',
        code: 'terminal_inactive',
        message: '原生终端已结束或属于另一连接。',
      });
      return;
    }
    try {
      if (control.type === 'terminal.input') current.process?.write(control.data);
      else if (control.type === 'terminal.resize')
        current.process?.resize(control.cols, control.rows);
      else current.process?.acknowledge(control.bytes);
    } catch {
      const task = current.process?.close();
      if (task) track(task);
    }
  }
  // A request ID is answered once: a resend gets the same response, never a second execution.
  function dispatch(peer: Peer, command: Command) {
    const serialized = JSON.stringify(command);
    const previous = peer.responses.get(command.requestId);
    if (previous) {
      if (previous.command === serialized)
        void previous.response.then((response) => send(peer, response));
      else
        send(peer, {
          type: 'response',
          requestId: command.requestId,
          ok: false,
          code: 'request_conflict',
          message: '请求 ID 已被其他内容使用。',
        });
      return;
    }
    const response = execute(peer, command).then(
      (sessionId): ServerMessage => ({
        type: 'response',
        requestId: command.requestId,
        ok: true,
        sessionId,
      }),
      (error): ServerMessage => ({
        type: 'response',
        requestId: command.requestId,
        ok: false,
        code: error instanceof DomainError ? error.code : 'internal_error',
        message: error instanceof DomainError ? error.message : '服务处理失败。',
      }),
    );
    peer.responses.set(command.requestId, { command: serialized, response });
    // A resend follows its request closely: the latest few are all that can still be asked for again.
    if (peer.responses.size > REMEMBERED)
      peer.responses.delete(peer.responses.keys().next().value!);
    track(response.then((value) => send(peer, value)));
  }
  // The computer's place here, made when the first of its connections says which computer it is.
  function enter(peer: Peer) {
    const device = deviceOf(peer).id;
    let seat = seats.get(device);
    if (!seat) {
      seat = { device, peers: new Set() };
      seats.set(device, seat);
      if (options.tunnel) {
        seat.door = new Door(options.tunnel, store.directory, device);
        seat.opening = seat.door.start();
        seat.opening.catch(() => {});
      }
    }
    clearTimeout(seat.away);
    seat.away = undefined;
    seat.peers.add(peer);
    return seat;
  }
  // The device's commands go through this connection's tunnel from now on: the newest that is ready.
  async function adopt(peer: Peer) {
    if (!peer.device || !peer.tunnel?.ssh) return;
    const seat = seats.get(peer.device.id);
    if (!seat?.door) return;
    await seat.opening;
    if (peers.has(peer) && seat.peers.has(peer)) seat.door.use(peer.tunnel);
  }
  // Nothing more is kept for a computer: its runs end and its door closes.
  function vacate(seat: Seat, reason: string) {
    clearTimeout(seat.away);
    if (seats.get(seat.device) !== seat) return;
    seats.delete(seat.device);
    for (const run of runs.values()) if (run.device === seat.device) cancel(run, reason);
    if (seat.door) track(seat.door.close(), tunnelTasks);
  }
  // What belongs to the connection itself ends with it: its terminal, a sign-in it began, its tunnel. The runs
  // of its computer go on. If no other connection of that computer is here they are given `graceMs` for one
  // to come back, unless the client said it was leaving; nothing is replayed for a later connection either way.
  function release(peer: Peer) {
    peers.delete(peer);
    if (login?.owner === peer) login.process.cancel();
    for (const item of poolLogins.values()) if (item.owner === peer) item.process.cancel();
    for (const terminal of terminals.values())
      if (terminal.owner === peer) {
        const task = terminal.process?.close();
        if (task) track(task);
      }
    const seat = peer.device && seats.get(peer.device.id);
    if (seat?.peers.delete(peer)) {
      if (seat.door?.uses(peer.tunnel))
        seat.door.use([...seat.peers].findLast((other) => other.tunnel?.ssh)?.tunnel);
      if (!seat.peers.size) {
        const waiting = [...runs.values()].some((run) => run.device === seat.device);
        const gone = options.claude
          ? '连接断开，运行未重放；在途命令结果可能未知。'
          : '连接断开，运行未重放。';
        if (peer.left || !waiting || !graceMs) vacate(seat, gone);
        else
          seat.away = setTimeout(
            () =>
              vacate(
                seat,
                `设备离线超过 ${Math.round(graceMs / 1000)} 秒，运行已停止；在途命令结果可能未知。`,
              ),
            graceMs,
          );
      }
    }
    if (peer.tunnel) track(peer.tunnel.close(), tunnelTasks);
  }

  wss.on('connection', (socket: WebSocket, address: string) => {
    void releases.refresh();
    const peer: Peer = {
      socket,
      id: randomUUID(),
      address,
      authenticated: false,
      name: '',
      registering: false,
      left: false,
      subscriptions: new Set(),
      responses: new Map(),
    };
    peers.add(peer);
    const opened = Date.now();
    const authTimer = setTimeout(() => socket.close(4001, 'Authentication timeout'), 5000);
    // A long unattended run should survive a brief network stall: only two pings in a row without an answer,
    // about 45 seconds of silence, end the connection.
    let missed = 0;
    let timedOut = false;
    // Whether this connection still holds one of the places for those that have not signed in.
    let signedIn = false;
    let greeted = false;
    socket.on('pong', () => {
      missed = 0;
    });
    const heartbeat = setInterval(() => {
      if (missed >= 2) {
        timedOut = true;
        socket.terminate();
        return;
      }
      missed++;
      socket.ping();
    }, 15000);
    socket.on('error', () => socket.terminate());
    socket.on('message', (data, isBinary) => {
      let value: unknown;
      try {
        if (isBinary) throw new Error('Binary frame');
        value = JSON.parse(data.toString('utf8'));
      } catch {
        send(peer, {
          type: 'connection.error',
          code: 'invalid_json',
          message: '消息必须是 JSON 文本。',
        });
        socket.close(4002, 'Invalid frame');
        return;
      }
      if (!peer.authenticated) {
        // Only the first frame signs in. What a refused client sent after it is not another attempt.
        if (greeted) return;
        greeted = true;
        const channel = (value as { type?: unknown } | null)?.type === 'tunnel.attach';
        if (channel ? attachChannel(peer, value) : authenticate(peer, value)) {
          clearTimeout(authTimer);
          signedIn = true;
          throttle.leave(address);
        }
        return;
      }
      const credentials = tunnelCredentialsSchema.safeParse(value);
      if (credentials.success) {
        registerTunnel(peer, credentials.data);
        return;
      }
      const identity = deviceIdentitySchema.safeParse(value);
      if (identity.success) {
        peer.device = {
          id: identity.data.id,
          name: peer.name,
          ...(identity.data.platform ? { platform: identity.data.platform } : {}),
        };
        // With the line written when it closes, this tells which computer a connection was and how long it held.
        if (!closing)
          console.log(
            `Connection ${peer.id.slice(0, 8)} opened: device "${peer.name}" (${identity.data.id.slice(0, 8)}) from ${address}`,
          );
        for (const session of store.named(peer.device))
          broadcast({ type: 'session.updated', session });
        enter(peer);
        track(adopt(peer), tunnelTasks);
        return;
      }
      if (leaveSchema.safeParse(value).success) {
        peer.left = true;
        return;
      }
      const control = terminalControlSchema.safeParse(value);
      if (control.success) {
        controlTerminal(peer, control.data);
        return;
      }
      const command = commandSchema.safeParse(value);
      if (!command.success) {
        send(peer, {
          type: 'connection.error',
          code: 'invalid_command',
          message: '请求格式无效。',
        });
        return;
      }
      dispatch(peer, command.data);
    });
    socket.on('close', (code) => {
      clearTimeout(authTimer);
      clearInterval(heartbeat);
      if (!signedIn) throttle.leave(address);
      // Why a connection ended is the first thing needed when a run was cut short.
      const device = peer.device?.id;
      const before = [...runs.values()].filter((run) => run.device === device).length;
      release(peer);
      // A native run that is being ended takes a moment to go: what became of the runs is told by whether the
      // computer still has a place here.
      const seat = device ? seats.get(device) : undefined;
      if (peer.authenticated && !closing)
        console.log(
          `Connection ${peer.id.slice(0, 8)} closed after ${Math.round((Date.now() - opened) / 1000)} s: ${peer.left ? 'the client left' : timedOut ? 'no heartbeat answer for 45s' : `code ${code}`}; runs of its device: ${before}${!before ? '' : !seat ? ', ended' : seat.away ? `, kept for ${Math.round(graceMs / 1000)} s` : ', going on over another connection'}`,
        );
    });
  });
  return {
    store,
    async listen(port = 8787): Promise<string> {
      await releases.refresh();
      updates?.start();
      if (usageReceiver)
        options.claude!.environment = {
          ...options.claude!.environment,
          ...telemetryEnvironment(await usageReceiver.listen()),
        };
      if (pool)
        poolTimer = setInterval(() => {
          if ([...peers].some((peer) => peer.poolClient) || runs.size) track(refreshPool());
        }, 60_000);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, options.host ?? '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No listening address');
      return `${options.tls ? 'https' : 'http'}://${options.host ?? '127.0.0.1'}:${address.port}`;
    },
    async close() {
      closing = true;
      clearInterval(poolTimer);
      for (const item of poolLogins.values()) item.process.cancel();
      for (const controller of poolProbes.values()) controller.abort();
      updates?.stop();
      login?.process.cancel();
      const terminalCleanup = Promise.all(
        [...terminals.values()].map((terminal) => terminal.process?.close()),
      );
      for (const run of runs.values()) cancel(run, '服务停止，运行未重放。');
      for (const seat of seats.values()) clearTimeout(seat.away);
      const cleanup = [
        ...[...peers].map((peer) => peer.tunnel?.close()),
        ...[...seats.values()].map((seat) => seat.door?.close()),
      ];
      for (const peer of peers) peer.socket.terminate();
      await Promise.all([...tasks]);
      await poolRefresh;
      await terminalCleanup;
      await Promise.all([...tunnelTasks]);
      await Promise.all(cleanup);
      await usageReceiver?.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      store.close();
    },
  };
}
