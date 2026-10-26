import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { posix, win32 } from 'node:path';

const { editorUrl, runs, localPath, pictureOf } = createRequire(import.meta.url)(
  '../electron/file-links.cjs',
);

test('an editor opens a file at a line from its own address', () => {
  assert.equal(editorUrl('vscode', 'C:\\a b\\#1.ts', 12, 3), 'vscode://file/C:/a%20b/%231.ts:12:3');
  assert.equal(editorUrl('cursor', '/Users/me/a.ts'), 'cursor://file/Users/me/a.ts');
});

test('what would run is told from what the system says, and from the kinds it does not list', () => {
  const windows = { platform: 'win32', pathext: '.COM;.EXE;.BAT;.CMD;.PY' };
  assert.equal(runs('C:\\a\\setup.EXE', windows), true);
  // An interpreter installed on the computer adds its own type to PATHEXT.
  assert.equal(runs('C:\\a\\tool.py', windows), true);
  assert.equal(runs('C:\\a\\go.lnk', windows), true);
  assert.equal(runs('C:\\a\\x.ps1', windows), true);
  assert.equal(runs('C:\\a\\report.pdf', windows), false);
  assert.equal(runs('C:\\a\\Makefile', windows), false);
  // Without PATHEXT, Windows' own list stands in.
  assert.equal(runs('C:\\a\\x.vbs', { platform: 'win32' }), true);
  assert.equal(runs('C:\\a\\folder.exe', { ...windows, directory: true }), false);
  // Elsewhere, the permission to execute; on a Mac, an application is a folder.
  assert.equal(runs('/a/build', { platform: 'linux', mode: 0o100755 }), true);
  assert.equal(runs('/a/notes.md', { platform: 'linux', mode: 0o100644 }), false);
  assert.equal(runs('/a/x.desktop', { platform: 'linux', mode: 0o100644 }), true);
  assert.equal(runs('/a/Calc.app', { platform: 'darwin', directory: true }), true);
  assert.equal(runs('/a/run.command', { platform: 'darwin', mode: 0o100644 }), true);
});

test('only absolute paths on this computer are taken', () => {
  assert.equal(localPath('C:\\a\\b.txt', win32.isAbsolute), 'C:\\a\\b.txt');
  assert.equal(localPath('\\\\server\\share\\a', win32.isAbsolute), null);
  assert.equal(localPath('//server/share/a', posix.isAbsolute), null);
  assert.equal(localPath('a\\b.txt', win32.isAbsolute), null);
  assert.equal(localPath('/a/b\0c', posix.isAbsolute), null);
});

test('the picture address serves pictures and nothing else', () => {
  assert.deepEqual(pictureOf('local-image://file/C%3A%5Ca%20b%5Cx.PNG'), {
    file: 'C:\\a b\\x.PNG',
    type: 'image/png',
  });
  assert.equal(pictureOf('local-image://file/C%3A%5Ca%5Cx.txt'), null);
  // A path of macOS or Linux comes back as written, through the address the page makes of it.
  assert.deepEqual(pictureOf(`local-image://file/${encodeURIComponent('/Users/me/图 1.webp')}`), {
    file: '/Users/me/图 1.webp',
    type: 'image/webp',
  });
  assert.equal(pictureOf('local-image://other/C%3A%5Ca%5Cx.png'), null);
});
