import { lazy, Suspense, useEffect } from 'react';
import { ChevronRight, Languages, LoaderCircle, RotateCw } from 'lucide-react';
import {
  configured,
  lookUpTranslation,
  needsTranslation,
  requestTranslation,
  toggleTranslation,
  translator,
  useTranslation,
  useTranslationSettings,
} from './translation.ts';

const RichText = lazy(() => import('./RichText.tsx'));

// The Chinese of one block of the AI's text, under the English it translates: the same Markdown renderer, so lists,
// code and tables look as they do above. Without a translation yet, a button asks for one; it works with automatic
// translation off too.
export default function ReplyTranslation({ id, text }: { id: string; text: string }) {
  const settings = useTranslationSettings();
  const entry = useTranslation(id);
  const wanted = !!translator() && needsTranslation(text);
  useEffect(() => {
    if (wanted) lookUpTranslation(id, text);
  }, [id, text, wanted]);
  if (!wanted) return null;
  if (!entry) {
    if (!configured(settings)) return null;
    return (
      <div className="translation-bar" data-search-ignore>
        <button
          type="button"
          className="translation-action"
          aria-label="翻译"
          title="翻译成中文"
          onClick={() => requestTranslation(id, text)}
        >
          <Languages />
          翻译
        </button>
      </div>
    );
  }
  if (entry.status === 'pending')
    return (
      <div className="translation-bar" role="status" data-search-ignore>
        <span className="translation-note">
          <LoaderCircle className="spinning" />
          翻译中…
        </span>
      </div>
    );
  if (entry.status === 'error')
    return (
      <div className="translation-bar failed" role="alert" data-search-ignore>
        <span className="translation-note">翻译失败：{entry.error}</span>
        <button
          type="button"
          className="translation-action"
          aria-label="重试翻译"
          onClick={() => requestTranslation(id, text)}
        >
          <RotateCw />
          重试
        </button>
      </div>
    );
  return (
    <section className={`translation${entry.open ? ' open' : ''}`} aria-label="中文译文">
      <button
        type="button"
        className="translation-toggle"
        aria-expanded={entry.open}
        onClick={() => toggleTranslation(id)}
        data-search-ignore
      >
        <ChevronRight />
        <Languages />
        中文
      </button>
      {entry.open && (
        <div className="message-content translation-content" lang="zh-CN" data-search-content>
          <Suspense fallback={<p>{entry.text}</p>}>
            <RichText text={entry.text} />
          </Suspense>
        </div>
      )}
    </section>
  );
}
