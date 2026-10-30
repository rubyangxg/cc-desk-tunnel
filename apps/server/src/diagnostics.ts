// What the service writes to its log when something fails. A message can carry what a command or the network
// printed, so anything that looks like a credential is masked before it is written; nothing else of a failure
// (stdout, request bodies, prompts) is logged.
const secrets: [RegExp, string][] = [
  [/\b(sk-ant-[A-Za-z0-9_-]{4})[A-Za-z0-9_-]+/g, '$1…'],
  [/\b(gh[opusr]_)[A-Za-z0-9]{8,}/g, '$1…'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 …'],
  [
    /("?(?:access_?token|refresh_?token|token|secret|password|api_?key|authorization|privateKey)"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}&]+)/gi,
    '$1…',
  ],
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    '[private key]',
  ],
  // Long opaque strings (JWTs, OAuth tokens, base64 keys) without the words around them.
  [/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}(\.[A-Za-z0-9_-]+)?\b/g, '…'],
  [/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, '…'],
];

export function redact(text: string) {
  let value = text;
  for (const [pattern, replacement] of secrets) value = value.replace(pattern, replacement);
  return value;
}

function textOf(error: unknown) {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return `${error.name}${code !== undefined ? ` (${String(code)})` : ''}: ${error.message}`;
  }
  return typeof error === 'string' ? error : String(error);
}

// One line, masked and bounded, naming what failed.
export function describeError(error: unknown, limit = 500) {
  const text = redact(textOf(error)).replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

// `stack` adds where it was thrown (masked too), for faults nothing else explains.
export function logFailure(context: string, error: unknown, stack = false) {
  const where =
    stack && error instanceof Error && error.stack
      ? `\n${redact(error.stack.split('\n').slice(1, 9).join('\n'))}`
      : '';
  console.warn(`[${context}] ${describeError(error)}${where}`);
}

// Keeps a background task in `group` until it settles. A task that fails is logged under `label` rather than left
// unhandled: an unhandled rejection ends the Node process, and with it every run and tunnel of the service.
export function trackTask(
  group: Set<Promise<unknown>>,
  task: Promise<unknown>,
  label = 'background task',
  log: (context: string, error: unknown) => void = logFailure,
) {
  const settled = task.then(
    () => {},
    (error) => log(label, error),
  );
  group.add(settled);
  void settled.finally(() => group.delete(settled));
  return settled;
}

export type ProbeFailure = 'auth' | 'timeout' | 'spawn' | 'unknown';

// Why an account check failed, from the error the official CLI or the SDK gave.
export function classifyProbeFailure(error: unknown): ProbeFailure {
  const text = textOf(error);
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  const status =
    error && typeof error === 'object'
      ? ((error as { status?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode)
      : undefined;
  if (
    status === 401 ||
    status === 403 ||
    /\b(401|403)\b|authentication_error|permission_error|invalid api key|unauthori[sz]ed|forbidden|\/login\b|not logged in|token (has )?(expired|revoked)|refresh token/i.test(
      text,
    )
  )
    return 'auth';
  if (
    code === 'ENOENT' ||
    code === 'EACCES' ||
    /\bENOENT\b|\bEACCES\b|spawn .* (failed|error)|executable not found|command not found/i.test(
      text,
    )
  )
    return 'spawn';
  if (
    code === 'ETIMEDOUT' ||
    code === 'ABORT_ERR' ||
    (error instanceof Error && error.name === 'AbortError') ||
    /timed? ?out|timeout|aborted|超时/i.test(text)
  )
    return 'timeout';
  // A bare mention of OAuth, with no timeout or spawn failure behind it, is the sign-in itself failing.
  if (/oauth/i.test(text)) return 'auth';
  return 'unknown';
}

export const probeFailureMessages: Record<ProbeFailure, string> = {
  auth: '登录已失效（官方服务拒绝了此账号的凭据），请重新登录此账号',
  timeout: '检测超时：连接 Claude 服务未在限定时间内完成，请检查服务端网络或代理',
  spawn: '检测失败：服务端无法启动 Claude CLI，请检查 CLI 安装与路径',
  unknown: '检测失败，请检查此账号的登录状态与服务网络',
};

export type CommandFailure = { code?: string; killed: boolean };
// Output that is not the status JSON is reported by why the command failed (it never started, it was stopped at
// the time limit), never by what it printed.
export function statusFailure({
  code,
  failure,
}: {
  code: number | null;
  failure?: CommandFailure;
}) {
  if (failure?.code === 'ENOENT' || failure?.code === 'EACCES')
    return Object.assign(new Error(`claude auth status could not start (${failure.code})`), {
      code: failure.code,
    });
  if (failure?.killed)
    return Object.assign(new Error('claude auth status timed out'), { code: 'ETIMEDOUT' });
  return new Error(`claude auth status printed no readable status (exit ${code ?? 'signal'})`);
}
