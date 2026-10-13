import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import {
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  clientServerMessageSchema,
  fallbackServerProtocol,
} from '@cc-desk-tunnel/protocol';
import { certificateMatches, connectService } from './proxy-bridge.mjs';

// A telemetry-only peer: it never registers a device, opens a tunnel or submits a model prompt.
export async function probeQuota(config, resolveProxy, timeoutMs = 25000) {
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
    return await queryQuota(config, address, resolveProxy, timeoutMs, PROTOCOL_VERSION);
  } catch (error) {
    const remaining = deadline - Date.now();
    if (!(error instanceof LegacyProtocolError) || remaining <= 0) throw error;
    return queryQuota(config, address, resolveProxy, remaining, 16);
  }
}

class LegacyProtocolError extends Error {}

function queryQuota(config, address, resolveProxy, timeoutMs, protocolVersion) {
  return new Promise((resolve, reject) => {
    let complete = false;
    let ready = false;
    let quota = null;
    let sessionId;
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
          deviceName: '账号池额度查询',
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
            ? new LegacyProtocolError(message.message)
            : new Error(message.message),
        );
        return;
      }
      if (message.type === 'ready') {
        ready = true;
        if (message.adapter !== 'claude-code') {
          finish(new Error('模拟服务没有 Claude 订阅额度。'));
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
