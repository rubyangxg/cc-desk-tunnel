import { useEffect, useState } from 'react';

export type DocumentState = { path: string; text: string; version: string };
type Editor = { saved: DocumentState; text: string };
// Keep unsaved edits when visiting a conversation or another settings page, but never persist a
// second plaintext copy in browser storage. All windows save through the main-process version check.
let draft: Editor | null = null;

export default function SharedDocument() {
  const [editor, setEditor] = useState<Editor | null>(draft);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [status, setStatus] = useState('');
  const desktop = window.desktop;
  const dirty = !!editor && editor.text !== editor.saved.text;
  function change(value: Editor) {
    draft = value;
    setEditor(value);
  }
  async function act(work: () => Promise<void>) {
    setBusy(true);
    setFailure('');
    setStatus('');
    try {
      await work();
    } catch (error) {
      setFailure(String(error instanceof Error ? error.message : error));
    } finally {
      setBusy(false);
    }
  }
  async function load() {
    if (!desktop) return;
    const saved = await desktop.loadSharedDocument();
    change({ saved, text: saved.text });
  }
  useEffect(() => {
    if (!draft) void act(load);
  }, []);
  // Refresh clean views when revisited. A dirty draft always retains the version it started from.
  useEffect(() => {
    if (!desktop || !editor || dirty) return;
    let cancelled = false;
    void desktop.loadSharedDocument().then(
      (saved) => {
        if (!cancelled && saved.version !== editor.saved.version)
          change({ saved, text: saved.text });
      },
      (error) => {
        if (!cancelled) setFailure(String(error?.message ?? error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [desktop, editor?.saved.version, dirty]);
  const discard = () => !dirty || window.confirm('替换当前未保存的草稿？');
  return (
    <section className="page" aria-label="共享文档">
      <div className="page-body">
        <h1 className="page-title">共享文档</h1>
        <p className="muted">本机所有账号与会话共享，Claude 按需读取。文档以明文保存在本机。</p>
        {!desktop ? (
          <p className="muted">请在桌面客户端中编辑共享文档。</p>
        ) : (
          <div className="card instructions-card shared-document-card">
            <div className="setting-actions">
              <span className="muted" role="status">
                {busy ? '处理中…' : dirty ? '未保存' : status}
              </span>
              <button
                type="button"
                className="button"
                disabled={busy || !editor}
                onClick={() => {
                  if (discard())
                    void act(async () => {
                      const text = await desktop.importSharedDocument();
                      if (text !== null && editor) {
                        change({ ...editor, text });
                        setStatus('已导入，保存后生效');
                      }
                    });
                }}
              >
                导入 Markdown
              </button>
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => {
                  if (discard()) void act(load);
                }}
              >
                重新载入
              </button>
              <button
                type="button"
                className="button primary"
                disabled={busy || !dirty}
                onClick={() =>
                  void act(async () => {
                    if (!editor) return;
                    const saved = await desktop.saveSharedDocument(
                      editor.text,
                      editor.saved.version,
                    );
                    change({ saved, text: saved.text });
                    setStatus('已保存');
                  })
                }
              >
                保存
              </button>
            </div>
            <textarea
              className="instructions-editor"
              aria-label="共享 Markdown 文档"
              rows={22}
              spellCheck={false}
              disabled={busy || !editor}
              value={editor?.text ?? ''}
              placeholder={'# 共享资料\n\n在这里记录服务器信息、项目约定等。'}
              onChange={(event) => {
                if (editor) change({ ...editor, text: event.target.value });
                setStatus('');
              }}
            />
            {failure && (
              <p className="error-text" role="alert">
                {failure}
              </p>
            )}
            {editor && (
              <details className="muted">
                <summary>保存位置</summary>
                <p className="shared-document-path">{editor.saved.path}</p>
              </details>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
