import { useEffect, useState } from 'react';
import { Page, Row, Switch } from './ui.tsx';
import {
  loadTranslationSettings,
  setTranslationSettings,
  translator,
  useTranslationSettings,
} from './translation.ts';

// The replies' translation: the user's own OpenAI-compatible API, called from this computer. Nothing here reaches
// the service or uses Claude's accounts.
export default function TranslationSettings() {
  const settings = useTranslationSettings();
  const api = translator();
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [key, setKey] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const [filled, setFilled] = useState(false);
  useEffect(() => {
    void loadTranslationSettings();
  }, []);
  useEffect(() => {
    if (!settings || filled) return;
    setBaseUrl(settings.baseUrl);
    setModel(settings.model);
    setFilled(true);
  }, [settings, filled]);
  if (!api) return <Page title="回复翻译" intro="只有桌面客户端可以翻译回复。" />;
  const draft = () => ({ baseUrl, model, ...(key.trim() ? { key } : {}) });
  const dirty =
    !!settings && (baseUrl !== settings.baseUrl || model !== settings.model || !!key.trim());
  const run = async (name: string, work: () => Promise<void>) => {
    setBusy(name);
    setMessage(null);
    try {
      await work();
    } finally {
      setBusy('');
    }
  };
  const save = (change: Parameters<typeof api.save>[0], done?: string) =>
    run('save', async () => {
      const result = await api.save(change);
      if (result.error !== undefined) return setMessage({ error: true, text: result.error });
      setTranslationSettings(result.value);
      setBaseUrl(result.value.baseUrl);
      setModel(result.value.model);
      setKey('');
      if (done) setMessage({ error: false, text: done });
    });
  return (
    <Page
      title="回复翻译"
      intro="用你自己的 OpenAI 兼容接口（如 CPA、DeepSeek、OpenAI）把 AI 的英文回复和思考翻译成中文，与原文对照显示。由这台电脑直接调用该接口，不经过服务端，也不使用 Claude 账号或额度。"
    >
      <div className="card">
        <Row
          title="自动翻译 AI 回复为中文"
          detail="打开后，新完成的每段回复、中间说明和思考都会自动翻译；已是中文的、代码和命令输出不翻译。历史消息可点它下面的“翻译”"
        >
          <Switch
            label="自动翻译 AI 回复为中文"
            checked={!!settings?.enabled}
            disabled={!settings || !!busy}
            onChange={(enabled) => {
              if (enabled && !(settings?.baseUrl && settings.hasKey))
                return setMessage({ error: true, text: '请先填写并保存接口地址和 API Key。' });
              void save({ enabled });
            }}
          />
        </Row>
      </div>
      <h2 className="page-heading">接口</h2>
      <form
        className="card translation-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save(draft(), '已保存。');
        }}
      >
        <label>
          接口地址（Base URL）
          <input
            value={baseUrl}
            placeholder="https://api.example.com"
            spellCheck={false}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
          <small className="muted">
            带不带 /v1 都可以，请求发往 {'{地址}'}/v1/chat/completions
          </small>
        </label>
        <label>
          API Key
          <input
            type="password"
            value={key}
            autoComplete="off"
            spellCheck={false}
            placeholder={settings?.hasKey ? '已保存（留空保持不变）' : '未设置'}
            onChange={(event) => setKey(event.target.value)}
          />
          <small className="muted">
            {settings?.secure === false
              ? '系统安全存储不可用，无法保存 API Key。'
              : '经当前系统账户加密后保存在本机，不会显示或写入日志。'}
          </small>
        </label>
        <label>
          模型
          <span className="translation-model">
            <input
              aria-label="模型"
              value={model}
              list="translation-models"
              spellCheck={false}
              onChange={(event) => setModel(event.target.value)}
            />
            <datalist id="translation-models">
              {models.map((id) => (
                <option key={id} value={id} />
              ))}
            </datalist>
            <button
              type="button"
              className="button"
              disabled={!!busy}
              onClick={() =>
                void run('models', async () => {
                  const result = await api.models(draft());
                  if (result.error !== undefined)
                    return setMessage({ error: true, text: result.error });
                  setModels(result.value);
                  setMessage({
                    error: false,
                    text: result.value.length
                      ? `找到 ${result.value.length} 个模型，可在下拉里选择。`
                      : '接口没有列出模型。',
                  });
                })
              }
            >
              {busy === 'models' ? '获取中…' : '获取模型列表'}
            </button>
          </span>
          {models.length > 0 && (
            <select
              aria-label="选择模型"
              value={models.includes(model) ? model : ''}
              onChange={(event) => event.target.value && setModel(event.target.value)}
            >
              <option value="">从列表中选择…</option>
              {models.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          )}
        </label>
        <div className="setting-actions">
          <button
            type="button"
            className="button"
            disabled={!!busy}
            onClick={() =>
              void run('test', async () => {
                const result = await api.test(draft());
                if (result.error !== undefined)
                  return setMessage({ error: true, text: `测试失败：${result.error}` });
                setMessage({
                  error: false,
                  text: `测试成功（${(result.value.ms / 1000).toFixed(1)} 秒）：${result.value.text}`,
                });
              })
            }
          >
            {busy === 'test' ? '测试中…' : '测试'}
          </button>
          <button type="submit" className="button primary" disabled={!!busy || !dirty}>
            保存
          </button>
          {settings?.hasKey && (
            <button
              type="button"
              className="button danger"
              disabled={!!busy}
              onClick={() => void save({ key: '', enabled: false }, '已删除 API Key。')}
            >
              删除 Key
            </button>
          )}
        </div>
        {message && (
          <p
            className={message.error ? 'error-text' : 'muted'}
            role={message.error ? 'alert' : 'status'}
          >
            {message.text}
          </p>
        )}
      </form>
    </Page>
  );
}
