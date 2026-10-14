import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Database } from 'lucide-react';
import type { TurnStats as Stats } from '@cc-desk-tunnel/protocol';
import { usePrefs } from './prefs.ts';
import { statFields, summaryText } from './turnStats.ts';

// The button under a reply: what the turn used and how fast the model was. Opens a card with the full figures.
export default function TurnStats({ stats }: { stats: Stats }) {
  const { stats: prefs } = usePrefs();
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  // The card opens upward; with no room above, it opens below the button instead. The room ends where the
  // conversation's scrolling area begins, under the title bar, not at the top of the window.
  useLayoutEffect(() => {
    const node = card.current;
    if (!node) return;
    const top = node.closest('.conversation')?.getBoundingClientRect().top ?? 0;
    node.classList.toggle('below', node.getBoundingClientRect().top < top + 8);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  if (!prefs.enabled) return null;
  const rows = statFields.flatMap((field) => {
    const value = field.value(stats);
    return value == null ? [] : [{ field, value }];
  });
  const summary = summaryText(stats, prefs.summary);

  const total = rows.find(({ field }) => field.key === 'tokens');
  return (
    <div className="turn-stats" ref={container}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Database />
        {summary || '用量明细'}
      </button>
      {open && (
        <div className="turn-stats-card" role="dialog" aria-label="本轮用量" ref={card}>
          <header>
            <Database />
            <strong>本轮用量</strong>
            {total && <b>{total.value}</b>}
          </header>
          <dl>
            {rows
              .filter((row) => row !== total)
              .map(({ field, value }) => (
                <div key={field.key}>
                  <dt>{field.label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
          </dl>
          {stats.partial && <p>部分模型请求的记录还没有到达，以上数字可能偏小。</p>}
        </div>
      )}
    </div>
  );
}
