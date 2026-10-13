// A path tells its own system: a Windows one begins with a drive letter or two backslashes, anything else is
// a POSIX one. Sessions of both kinds can be in one list, each from the computer it is on.
const isWindowsPath = (path: string) => /^[a-z]:[\\/]|^\\\\/i.test(path);
// Windows paths compare case-insensitively and may arrive with either separator; a POSIX path is taken as
// written, where a backslash is a character of a name like any other.
export { projectPathKey as pathKey } from '@cc-desk-tunnel/protocol';
import { projectPathKey as pathKey } from '@cc-desk-tunnel/protocol';
export const folderName = (path: string) =>
  path
    .split(isWindowsPath(path) ? /[\\/]/ : '/')
    .filter(Boolean)
    .at(-1) || path;
// Whether a path lies under one of the folders that hold the sessions without a project.
export const isInside = (path: string, roots: string[]) =>
  roots.some((root) =>
    pathKey(path).startsWith(`${pathKey(root)}${isWindowsPath(root) ? '\\' : '/'}`),
  );
// Dotted numeric versions, e.g. 0.10.1 is newer than 0.9.0.
export function isNewer(candidate: string, current: string) {
  const [a, b] = [candidate, current].map((version) => version.split('.').map(Number));
  for (let index = 0; index < 3; index++)
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0);
  return false;
}
// How long ago, in the fewest words that still tell recent from old.
export function ago(time: number) {
  const minutes = Math.floor((Date.now() - time) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)} 小时`;
  if (minutes < 60 * 24 * 30) return `${Math.floor(minutes / 60 / 24)} 天`;
  return new Date(time).toLocaleDateString('zh-CN');
}
export const withProject = (projects: string[], path: string) =>
  projects.some((item) => pathKey(item) === pathKey(path)) ? projects : [...projects, path];
