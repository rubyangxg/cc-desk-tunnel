export type ConnectionForm = {
  url: string;
  token: string;
  fingerprint: string;
  mode: 'local' | 'remote';
  remember: boolean;
  autoLogin: boolean;
};

export type ConnectionProfile = ConnectionForm & { id: string; name: string };
export type ConnectionProfiles = { profiles: ConnectionProfile[]; activeId: string };

// The original service keeps the existing drafts and scheduled tasks.
export function profileKey(key: string, id: string) {
  return id === 'default' ? key : `${key}:${id}`;
}

export function validateConnection(form: ConnectionForm) {
  let url: URL;
  try {
    url = new URL(form.url.trim());
  } catch {
    throw new Error('请输入有效的 WebSocket 服务地址。');
  }
  if (url.username || url.password || url.search || url.hash)
    throw new Error('服务地址不能包含凭据、查询参数或片段。');
  if (form.mode === 'remote' && url.protocol !== 'wss:')
    throw new Error('远程服务地址必须使用 wss://。');
  if (
    form.mode === 'local' &&
    (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  )
    throw new Error('本地模拟仅支持 ws:// 环回地址。');
  if (
    form.fingerprint.trim() &&
    !/^(?:[a-f\d]{64}|(?:[a-f\d]{2}:){31}[a-f\d]{2})$/i.test(form.fingerprint.trim())
  )
    throw new Error('SHA-256 指纹应为完整的 32 字节（64 个十六进制字符，可用冒号分隔）。');
  if (form.token.trim() && form.token.trim().length < 24)
    throw new Error('服务凭据至少 24 个字符。');
}
