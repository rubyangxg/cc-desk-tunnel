import type { ClientSocket } from '../../desktop/src/client.ts';
export type Profile = { id: string; name: string; url: string; fingerprint: string };
export type Setup = { profiles: Profile[]; deviceId: string; notifications: boolean };
declare global {
  interface Window {
    MobileNative?: { postMessage: (text: string) => void };
    __nativeReceive: (text: string) => void;
  }
}
type Reply = {
  id: string;
  ok?: boolean;
  result?: unknown;
  error?: string;
  event?: string;
  data?: string;
  code?: number;
};
const requests = new Map<
  string,
  {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
const sockets = new Map<string, NativeSocket>();
window.__nativeReceive = (text) => {
  const reply = JSON.parse(text) as Reply;
  if (reply.event) {
    sockets.get(reply.id)?.receive(reply);
    return;
  }
  const pending = requests.get(reply.id);
  if (!pending) return;
  requests.delete(reply.id);
  clearTimeout(pending.timer);
  if (reply.ok) pending.resolve(reply.result);
  else pending.reject(new Error(reply.error ?? '操作失败，请重试。'));
};
export function native<T>(method: string, args: unknown = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!window.MobileNative) {
      reject(new Error('请安装 Android 版打开。'));
      return;
    }
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      requests.delete(id);
      reject(new Error('操作超时，请重试。'));
    }, 15000);
    requests.set(id, { resolve, reject, timer });
    window.MobileNative.postMessage(JSON.stringify({ id, method, args }));
  });
}
export class NativeSocket implements ClientSocket {
  id = crypto.randomUUID();
  readyState: number = WebSocket.CONNECTING;
  onopen: WebSocket['onopen'] = null;
  onmessage: WebSocket['onmessage'] = null;
  onclose: WebSocket['onclose'] = null;
  onerror: WebSocket['onerror'] = null;
  constructor(profileId: string) {
    sockets.set(this.id, this);
    void native('socket.open', { socketId: this.id, profileId }).catch((error) =>
      this.receive({ id: this.id, event: 'close', code: 4003, data: error.message }),
    );
  }
  receive(reply: Reply) {
    const self = this as unknown as WebSocket;
    if (reply.event === 'open' && this.readyState === WebSocket.CONNECTING) {
      this.readyState = WebSocket.OPEN;
      this.onopen?.call(self, new Event('open'));
    } else if (reply.event === 'message' && this.readyState === WebSocket.OPEN) {
      this.onmessage?.call(self, new MessageEvent('message', { data: reply.data }));
    } else if (reply.event === 'error') {
      // Deliver a protocol error so the same client handles auth/TLS failures without losing the reason.
      this.onmessage?.call(
        self,
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'connection.error',
            code: 'transport_failed',
            message: reply.data,
          }),
        }),
      );
    } else if (reply.event === 'close' && this.readyState !== WebSocket.CLOSED) {
      this.readyState = WebSocket.CLOSED;
      sockets.delete(this.id);
      this.onclose?.call(
        self,
        new CloseEvent('close', { code: reply.code ?? 1006, reason: reply.data ?? '' }),
      );
    }
  }
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (typeof data !== 'string' || this.readyState !== WebSocket.OPEN)
      throw new Error('连接尚未就绪。');
    void native('socket.send', { socketId: this.id, data }).catch((error) =>
      this.receive({ id: this.id, event: 'error', data: error.message }),
    );
  }
  close() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSING;
    void native('socket.close', { socketId: this.id })
      .catch(() => {})
      .finally(() => this.receive({ id: this.id, event: 'close', code: 1000 }));
  }
}
export function external(url: string) {
  if (/^https?:\/\//i.test(url)) void native('external', { url }).catch(() => {});
}
