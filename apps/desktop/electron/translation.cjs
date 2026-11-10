// Translates the AI's English replies into Simplified Chinese with an OpenAI-compatible API of the user's own: the
// address, key and model are set in the client and the call goes from this computer straight to that address, never
// through the service or its accounts. The key is kept with the OS account's secure storage, as connection tokens are.
const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync, renameSync } = require('node:fs');

const defaultModel = 'grok-4.20-0309-non-reasoning';
const sample =
  'The build passed. Run `npm test` again after editing src/app.ts, then open https://example.com.';

// `https://host:port`, `https://host:port/`, `https://host/v1/`, even a pasted `/v1/chat/completions`: all name
// the same service, whose endpoints are `{base}/v1/...`.
function normalizeBase(value) {
  let text = String(value ?? '').trim();
  if (!text) return '';
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error('接口地址无效，应以 http:// 或 https:// 开头。');
  }
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('接口地址无效，应以 http:// 或 https:// 开头。');
  url.search = '';
  url.hash = '';
  let path = url.pathname.replace(/\/+$/, '');
  path = path.replace(/\/(chat\/completions|models)$/i, '').replace(/\/v1$/i, '');
  return `${url.origin}${path}`;
}
const endpoint = (base, name) => `${normalizeBase(base)}/v1/${name}`;

// Fenced code blocks are taken out before the text is sent and put back unchanged afterwards, so the model cannot
// touch them; what it is told to keep (inline code, paths, commands, addresses) it is asked to leave alone.
const fence =
  /(^|\n)([ \t]{0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]{0,3}\3[`~]*[ \t]*(?=\n|$)|$)/g;
const token = (index) => `@@CODE_BLOCK_${index}@@`;
function protect(text) {
  const blocks = [];
  const masked = String(text).replace(fence, (match, before) => {
    blocks.push(match.slice(before.length));
    return `${before}${token(blocks.length - 1)}`;
  });
  return { masked, blocks };
}
function restore(text, blocks) {
  const missing = [];
  let result = String(text);
  blocks.forEach((block, index) => {
    if (result.includes(token(index))) result = result.split(token(index)).join(block);
    else missing.push(block);
  });
  // A block the model dropped is still shown, after the translation, rather than lost.
  return missing.length ? `${result.trimEnd()}\n\n${missing.join('\n\n')}` : result;
}

const systemPrompt = [
  'You are a translation engine. Translate the user message from English into Simplified Chinese.',
  'Output only the translation, with no explanation, preface or quotes.',
  'Preserve the Markdown structure exactly: headings, lists, tables, emphasis, links and line breaks.',
  'Keep unchanged: inline code in backticks, file paths, shell commands, URLs, identifiers, version numbers, ' +
    'product names and any placeholder like @@CODE_BLOCK_0@@ (copy placeholders verbatim, each on its own line where it was).',
  'If a part is already Chinese, keep it as it is.',
].join('\n');

// What went wrong, in words for the user; the key never appears in it.
function failure(status, body, key) {
  let detail = '';
  try {
    const value = JSON.parse(body);
    detail = String(value?.error?.message ?? value?.message ?? value?.error ?? '');
  } catch {
    detail = String(body ?? '');
  }
  detail = detail.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (key) detail = detail.split(key).join('***');
  const reason =
    status === 401 || status === 403
      ? 'API Key 无效或没有权限'
      : status === 404
        ? '接口地址或模型不存在'
        : status === 429
          ? '请求太频繁或额度不足'
          : `接口返回 ${status}`;
  return new Error(detail ? `${reason}：${detail}` : reason);
}

async function call(fetcher, url, init, timeoutMs, key) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, { ...init, signal: controller.signal });
    const body = await response.text();
    if (!response.ok) throw failure(response.status, body, key);
    try {
      return JSON.parse(body);
    } catch {
      throw new Error('接口返回的不是 JSON，请检查接口地址。');
    }
  } catch (error) {
    if (controller.signal.aborted)
      throw new Error(`翻译接口 ${Math.round(timeoutMs / 1000)} 秒内没有响应。`);
    const message = String(error?.message ?? error);
    throw new Error(key ? message.split(key).join('***') : message);
  } finally {
    clearTimeout(timer);
  }
}

function usable(config, { model = true } = {}) {
  const base = normalizeBase(config?.baseUrl);
  if (!base) throw new Error('请先在“设置 → 回复翻译”里填写接口地址。');
  if (!config?.key) throw new Error('请先在“设置 → 回复翻译”里填写 API Key。');
  if (model && !String(config.model ?? '').trim()) throw new Error('请先选择翻译模型。');
  return base;
}

async function listModels(config, { fetch: fetcher, timeoutMs = 20_000 } = {}) {
  const base = usable(config, { model: false });
  const value = await call(
    fetcher,
    endpoint(base, 'models'),
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${config.key}`, Accept: 'application/json' },
    },
    timeoutMs,
    config.key,
  );
  const list = Array.isArray(value?.data) ? value.data : Array.isArray(value) ? value : [];
  const ids = list
    .map((item) => (typeof item === 'string' ? item : item?.id))
    .filter((id) => typeof id === 'string' && id);
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

async function translate(config, text, { fetch: fetcher, timeoutMs = 60_000 } = {}) {
  const base = usable(config);
  const source = String(text ?? '');
  if (!source.trim()) return '';
  const { masked, blocks } = protect(source);
  // Nothing but code: there is nothing to translate.
  if (!masked.replace(/@@CODE_BLOCK_\d+@@/g, '').trim()) return source;
  const value = await call(
    fetcher,
    endpoint(base, 'chat/completions'),
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model: String(config.model).trim(),
        temperature: 0.2,
        stream: false,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: masked },
        ],
      }),
    },
    timeoutMs,
    config.key,
  );
  const content = value?.choices?.[0]?.message?.content;
  const answer = Array.isArray(content)
    ? content.map((part) => (typeof part === 'string' ? part : (part?.text ?? ''))).join('')
    : content;
  if (typeof answer !== 'string' || !answer.trim()) throw new Error('接口没有返回译文。');
  return restore(answer.trim(), blocks);
}

// At most `size` translations at a time; the rest wait their turn.
function limiter(size = 2) {
  let running = 0;
  const waiting = [];
  const next = () => {
    if (running >= size || !waiting.length) return;
    running++;
    const { task, resolve, reject } = waiting.shift();
    Promise.resolve()
      .then(task)
      .then(resolve, reject)
      .finally(() => {
        running--;
        next();
      });
  };
  return (task) =>
    new Promise((resolve, reject) => {
      waiting.push({ task, resolve, reject });
      next();
    });
}

const hashOf = (text) => createHash('sha256').update(String(text)).digest('hex').slice(0, 40);

// Translations already made, by the text they translate, kept on disk so a reconnect or another look at the same
// reply does not ask again. The oldest go once there are too many.
function cache(file, limit = 3000) {
  let entries;
  const load = () => {
    if (entries) return entries;
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      entries = new Map(Array.isArray(saved?.entries) ? saved.entries : []);
    } catch {
      entries = new Map();
    }
    return entries;
  };
  const save = () => {
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, JSON.stringify({ entries: [...entries] }));
    renameSync(temporary, file);
  };
  return {
    get: (text) => load().get(hashOf(text)) ?? null,
    set(text, translation) {
      const map = load();
      const key = hashOf(text);
      map.delete(key);
      map.set(key, translation);
      while (map.size > limit) map.delete(map.keys().next().value);
      save();
    },
    clear() {
      entries = new Map();
      save();
    },
  };
}

function encryptionAvailable(storage) {
  return storage.isEncryptionAvailable() && storage.getSelectedStorageBackend?.() !== 'basic_text';
}

// The settings as kept in settings.json: everything plain but the key, which is encrypted.
function loadConfig(saved, storage) {
  let key = '';
  try {
    if (saved?.key && encryptionAvailable(storage))
      key = storage.decryptString(Buffer.from(saved.key, 'base64'));
  } catch {
    // Another OS account cannot read it; it has to be entered again.
  }
  return {
    enabled: saved?.enabled === true,
    baseUrl: typeof saved?.baseUrl === 'string' ? saved.baseUrl : '',
    model: typeof saved?.model === 'string' && saved.model.trim() ? saved.model : defaultModel,
    key,
  };
}
// `change.key`: absent keeps the saved one, '' removes it.
function encodeConfig(change, saved, storage) {
  const current = saved ?? {};
  const next = {
    enabled: change?.enabled === undefined ? current.enabled === true : change.enabled === true,
    baseUrl:
      change?.baseUrl === undefined ? (current.baseUrl ?? '') : normalizeBase(change.baseUrl),
    model:
      change?.model === undefined
        ? (current.model ?? defaultModel)
        : String(change.model).trim() || defaultModel,
  };
  if (change?.key === undefined) {
    if (current.key) next.key = current.key;
  } else if (String(change.key).trim()) {
    if (!encryptionAvailable(storage)) throw new Error('系统安全存储不可用，无法保存 API Key。');
    next.key = storage.encryptString(String(change.key).trim()).toString('base64');
  }
  return next;
}
// What the window may know: never the key, only whether there is one.
const publicConfig = (config, storage) => ({
  enabled: config.enabled,
  baseUrl: config.baseUrl,
  model: config.model,
  hasKey: !!config.key,
  secure: encryptionAvailable(storage),
});

module.exports = {
  defaultModel,
  sample,
  normalizeBase,
  protect,
  restore,
  systemPrompt,
  listModels,
  translate,
  limiter,
  cache,
  loadConfig,
  encodeConfig,
  publicConfig,
};
