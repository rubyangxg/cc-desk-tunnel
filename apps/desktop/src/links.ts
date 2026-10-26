import { createContext } from 'react';
import { isWindowsPath } from '@cc-desk-tunnel/protocol';

// Where the links of a conversation lead from: the session's project folder, whether this window can open what
// is in it (a desktop window on the computer the project is on), and whether it is a browser.
export type Place = { projectPath: string; here: boolean; browser: boolean };
export const LinkPlace = createContext<Place | null>(null);

export type Link =
  | { kind: 'web'; url: string }
  | { kind: 'path'; path: string; line?: number; column?: number }
  // A path this window cannot open; it can still be copied.
  | { kind: 'elsewhere'; path: string; reason: string };

// A line, and a column, at the end of a path: a.ts:12, a.ts:12:3, a.ts#L12, a.ts#L12C3, a.ts#L12-L20.
const position = /(?:#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?|:(\d+)(?::(\d+))?(?:-\d+)?)$/;

function decoded(text: string) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

// file:///C:/a%20b/c.md is C:\a b\c.md; file://host/share is a path on another computer's share.
function fromFileUrl(written: string) {
  try {
    const url = new URL(written);
    const path = decoded(url.pathname);
    if (url.host && url.host !== 'localhost') return `\\\\${url.host}${path.replaceAll('/', '\\')}`;
    return /^\/[a-z]:\//i.test(path) ? path.slice(1) : path;
  } catch {
    return null;
  }
}

// A path written relative to the project folder, as replies about a project often are.
function joined(base: string, relative: string) {
  const windows = isWindowsPath(base);
  const parts = base.split(windows ? /[\\/]/ : '/').filter((part, index) => !index || part);
  for (const part of relative.split(/[\\/]/)) {
    if (part === '..' && parts.length > 1) parts.pop();
    else if (part && part !== '.' && part !== '..') parts.push(part);
  }
  return parts.join(windows ? '\\' : '/') || '/';
}

// What a link in a reply leads to, as written in its Markdown (which may have percent-encoded it). A web address
// opens anywhere. A path is on the computer the session's project is on, unless it is plainly of another system:
// a reply may name a file on the service, where Claude Code runs, which is no file of the user's.
export function linkTarget(href: string, place: Place | null): Link | null {
  const written = href.trim();
  if (/^(?:https?|mailto):/i.test(written)) {
    try {
      return { kind: 'web', url: new URL(written).href };
    } catch {
      return null;
    }
  }
  if (!place || !written || written.startsWith('#')) return null;
  const found = position.exec(written);
  const bare = found ? written.slice(0, found.index) : written;
  let path = /^file:/i.test(bare) ? fromFileUrl(bare) : decoded(bare);
  // Another kind of address; a drive letter is one letter.
  if (!path || /^[a-z][a-z\d+.-]+:/i.test(path)) return null;
  const elsewhere = (reason: string): Link => ({ kind: 'elsewhere', path: path!, reason });
  if (/^[\\/]{2}/.test(path)) return elsewhere('这是网络共享上的路径，不直接打开。');
  if (/^[~\\]/.test(path)) return elsewhere('这个路径不完整，没法确定在哪里。');
  const windows = isWindowsPath(place.projectPath);
  if (/^[a-z]:\//i.test(path) && windows) path = path.replaceAll('/', '\\');
  if (!isWindowsPath(path) && !path.startsWith('/')) path = joined(place.projectPath, path);
  if (isWindowsPath(path) !== windows)
    return elsewhere(
      windows
        ? '这是服务端上的路径，本机没有这个文件。'
        : '这是 Windows 上的路径，不在这个会话的电脑上。',
    );
  if (!place.here)
    return elsewhere(
      place.browser ? '在浏览器里打不开电脑上的文件。' : '这个会话的项目在另一台电脑上。',
    );
  const [line, column] = [found?.[1] ?? found?.[3], found?.[2] ?? found?.[4]].map(
    (value) => Number(value) || undefined,
  );
  return { kind: 'path', path, line, column };
}

// A picture on this computer reaches the page by an address the desktop serves (see file-links.cjs).
export const isPicture = (path: string) => /\.(?:png|jpe?g|gif|webp|bmp|avif|ico|svg)$/i.test(path);
export const localPicture = (path: string) => `local-image://file/${encodeURIComponent(path)}`;
