// How much of the work behind a reply the conversation shows. `standard` is how it has always looked: while a turn
// runs its steps are in groups, folded; once it ends they fold into one line, "用时 …". `expanded` lays every call
// and thought out one after another, folds nothing, and shows the first line of each folded thought.
export type ViewMode = 'standard' | 'expanded';
export type TranscriptView = { mode: ViewMode };

export const defaultView: TranscriptView = { mode: 'standard' };

export const viewModes: { mode: ViewMode; label: string; detail: string }[] = [
  { mode: 'standard', label: '标准', detail: '运行中按连续的操作分组，结束后折成“用时 …”' },
  {
    mode: 'expanded',
    label: '全部展开',
    detail: '命令和思考一条条平铺，不分组，也不自动收起；思考显示第一行',
  },
];

// The first line that says something, without the Markdown around it. Only a list marker is taken off the start, so
// a line that begins with a number keeps it.
export function firstLine(text: string) {
  for (const line of text.split('\n')) {
    const plain = line
      .replace(/^\s*(?:>\s*)*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)?/, '')
      .replace(/\*\*|__|`/g, '')
      .trim();
    if (plain) return plain;
  }
  return '';
}
