import type { Turn } from './transcript.ts';

// Whether a text is already Chinese enough to need no translation: its letters outside code, counted Han against
// Latin. Text with no letters at all (only code, numbers or symbols) has nothing to translate either.
export function mostlyChinese(text: string) {
  const prose = text
    .replace(
      /(^|\n)[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(\n[ \t]{0,3}\2[`~]*[ \t]*(?=\n|$)|$)/g,
      '\n',
    )
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ');
  const han = prose.match(/[\u3400-\u9fff\uf900-\ufaff]/g)?.length ?? 0;
  const latin = prose.match(/[A-Za-z]/g)?.length ?? 0;
  if (han + latin === 0) return true;
  // A Han character carries about as much as a short English word.
  return han * 3 >= latin;
}

// A block of the conversation that may be translated: the AI's text (along the way or as the answer) and its
// thinking. Tool calls and their output are not. `complete` once anything followed it or its turn ended: a block
// still streaming is left until it is whole.
export type Translatable = {
  id: string;
  kind: 'assistant' | 'thinking';
  text: string;
  at: string;
  complete: boolean;
};
export function translatable(turns: Turn[]): Translatable[] {
  const blocks: Translatable[] = [];
  for (const turn of turns) {
    const sequence: { id: string; kind: string; text?: string; at: string }[] = [];
    for (const step of turn.steps)
      if (step.kind === 'work') sequence.push(...step.items);
      else sequence.push(step);
    if (turn.answer) sequence.push(turn.answer);
    sequence.forEach((item, index) => {
      if (item.kind !== 'assistant' && item.kind !== 'thinking') return;
      if (!item.text?.trim()) return;
      blocks.push({
        id: item.id,
        kind: item.kind,
        text: item.text,
        at: item.at,
        complete: !!turn.endedAt || index < sequence.length - 1,
      });
    });
  }
  return blocks;
}
