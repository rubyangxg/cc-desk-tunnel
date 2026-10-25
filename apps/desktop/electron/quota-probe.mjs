import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import {
  compareQuotaReset,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  clientServerMessageSchema,
  commandSchema,
  fallbackServerProtocol,
} from '@cc-desk-tunnel/protocol';
import { certificateMatches, connectService } from './proxy-bridge.mjs';

// A telemetry-only peer: it never registers a device, opens a tunnel or submits a model prompt.
export async function probeQuota(config, resolveProxy, timeoutMs = 25000) {
  return probe(config, resolveProxy, timeoutMs, 'quota');
}

// Reading the greeting lists sessions without registering a device or interrupting its execution tunnel.
export async function probeSessions(config, resolveProxy, timeoutMs = 12000) {
  return probe(config, resolveProxy, timeoutMs, 'sessions');
}

// Only bounded account metadata operations are accepted; no device/tunnel or model commands.
export async function probePool(
  config,
  resolveProxy,
  command = { type: 'pool.status', refresh: true },
  timeoutMs = 25000,
) {
  if (!['pool.status', 'pool.configure', 'pool.account.update'].includes(command?.type))
    throw new Error('不支持此后台账号操作。');
  const validated = commandSchema.parse({ ...command, requestId: randomUUID() });
  return probe(config, resolveProxy, timeoutMs, validated);
}

async function probe(config, resolveProxy, timeoutMs, catalog) {
  const address = new URL(config.url);
  if (
    address.protocol !== 'wss:' ||
    address.username ||
    address.password ||
    address.search ||
    address.hash
  )
    throw new Error('账号池仅支持不含凭据的 WSS 地址。');
  const deadline = Date.now() + timeoutMs;
  try {
    return await queryQuota(config, address, resolveProxy, timeoutMs, PROTOCOL_VERSION, catalog);
  } catch (error) {
    const remaining = deadline - Date.now();
    if (!(error instanceof LegacyProtocolError) || remaining <= 0) throw error;
    return queryQuota(config, address, resolveProxy, remaining, error.protocolVersion, catalog);
  }
}

// A service represents its schedulable pool, not whichever account last emitted telemetry.
export function poolQuota(state) {
  const now = state.serverTime ?? Date.now();
  const order = [...new Set([...state.settings.order, ...state.accounts.map((a) => a.id)])];
  const eligible = state.accounts.filter(
    (account) =>
      account.enabled &&
      account.loggedIn === true &&
      !account.login &&
      !account.error &&
      account.checkedAt !== null &&
      now - account.checkedAt < 120000 &&
      account.limits?.available &&
      (state.settings.enabled || account.id === state.settings.preferredId),
  );
  const ready = eligible.filter(
    (account) =>
      !(account.blockedUntil > now) &&
      account.limits.windows.some(
        (window) =>
          window.name === 'five_hour' &&
          typeof window.utilization === 'number' &&
          window.utilization < 100,
      ) &&
      !account.limits.windows.some(
        (window) => ['five_hour', 'seven_day'].includes(window.name) && window.utilization >= 100,
      ),
  );
  ready.sort(
    (a, b) =>
      (state.settings.strategy === 'reset' ? compareQuotaReset(a.limits, b.limits, now) : 0) ||
      order.indexOf(a.id) - order.indexOf(b.id),
  );
  return ready[0]?.limits ?? null;
}

class LegacyProtocolError extends Error {
  constructor(protocolVersion) {
    super('Older service protocol');
    this.protocolVersion = protocolVersion;
  }
}

function queryQuota(config, address, resolveProxy, timeoutMs, protocolVersion, catalog) {
  return new Promise((resolve, reject) => {
    let complete = false;
    let ready = false;
    let quota = null;
    let sessionId;
    let poolMode = false;
    let refreshingPool = false;
    let poolState = null;
    let acknowledged = false;
    const fullPool = typeof catalog === 'object';
    const needsRefresh = !fullPool || (catalog.type === 'pool.status' && catalog.refresh);
    const finishPool = () => {
      if (
        poolState &&
        acknowledged &&
        (!needsRefresh || (refreshingPool && !poolState.refreshing))
      ) {
        quota = fullPool ? poolState : poolQuota(poolState);
        finish();
      }
    };
    const subscriptionId = randomUUID();
    const requestId = randomUUID();
    const socket = new WebSocket(address, {
      maxPayload: MAX_FRAME_BYTES,
      handshakeTimeout: timeoutMs,
      createConnection: (_options, callback) => {
        connectService(address, config, resolveProxy).then((tls) => {
          if (complete) {
            tls.destroy();
            return;
          }
          callback(null, tls);
        }, callback);
      },
    });
    const finish = (error) => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      socket.terminate();
      if (error) reject(error);
      else resolve(quota);
    };
    const timer = setTimeout(() => finish(new Error('额度查询超时。')), timeoutMs);
    socket.on('error', () => finish(new Error('无法连接服务器或验证证书。')));
    socket.on('close', () => finish(new Error('额度查询连接已关闭。')));
    socket.on('open', () => {
      if (
        config.fingerprint &&
        !certificateMatches(socket._socket.getPeerCertificate().fingerprint256, config.fingerprint)
      ) {
        finish(new Error('服务证书指纹不匹配；未发送服务凭据。'));
        return;
      }
      socket.send(
        JSON.stringify({
          type: 'auth',
          protocolVersion,
          token: config.token,
          deviceName: catalog === 'sessions' ? '会话列表查询' : '账号池额度查询',
        }),
      );
    });
    socket.on('message', (raw) => {
      let message;
      try {
        message = clientServerMessageSchema.parse(JSON.parse(raw.toString()));
        if (message.type === 'ready' && message.protocolVersion !== protocolVersion)
          throw new Error('Unexpected service protocol');
      } catch {
        finish(new Error('服务消息格式不兼容。'));
        return;
      }
      if (message.type === 'connection.error') {
        finish(
          !ready && fallbackServerProtocol(message, protocolVersion) !== null
            ? new LegacyProtocolError(fallbackServerProtocol(message, protocolVersion))
            : new Error(message.message),
        );
        return;
      }
      if (message.type === 'ready') {
        ready = true;
        if (catalog === 'sessions') {
          quota = message.sessions;
          finish();
          return;
        }
        if (message.adapter !== 'claude-code') {
          finish(new Error('模拟服务没有 Claude 订阅额度。'));
          return;
        }
        if (message.features?.includes('account-pool')) {
          poolMode = true;
          socket.send(
            JSON.stringify(
              fullPool
                ? { ...catalog, requestId }
                : { type: 'pool.status', requestId, refresh: true },
            ),
          );
          return;
        }
        if (fullPool) {
          finish(new Error('此服务不支持账号池，请升级服务端。'));
          return;
        }
        const session =
          message.sessions.find(
            (item) => item.activeRun?.surface !== 'terminal' && item.activeRun,
          ) ??
          message.sessions.find((item) => !item.activeRun) ??
          message.sessions[0];
        if (!session) {
          finish(new Error('请先连接此账号并创建一个会话，再查询额度。'));
          return;
        }
        sessionId = session.id;
        // During an active run, status is emitted to its subscribers by the running CLI.
        socket.send(
          JSON.stringify({ type: 'session.subscribe', requestId: subscriptionId, sessionId }),
        );
      }
      if (poolMode) {
        if (message.type === 'pool.state') {
          poolState = message;
          if (message.refreshing) refreshingPool = true;
        }
        if (message.type === 'response' && message.requestId === requestId) {
          if (!message.ok) {
            finish(new Error(message.message ?? '账号池操作失败。'));
            return;
          }
          acknowledged = true;
        }
        finishPool();
        return;
      }
      if (message.type === 'session.event' && message.event.payload.type === 'native.metrics')
        quota = message.event.payload.rateLimits;
      if (message.type === 'response' && message.requestId === subscriptionId) {
        if (!message.ok) finish(new Error(message.message ?? '额度查询失败。'));
        else socket.send(JSON.stringify({ type: 'session.status', requestId, sessionId }));
      }
      if (message.type === 'response' && message.requestId === requestId)
        finish(message.ok ? null : new Error(message.message ?? '额度查询失败。'));
    });
  });
}
