const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  nativeImage,
  powerSaveBlocker,
  safeStorage,
  session,
  ipcMain,
  dialog,
  shell,
  clipboard,
  net,
} = require('electron');
const path = require('node:path');
const {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} = require('node:fs');
const { mkdtemp, stat, writeFile } = require('node:fs/promises');
const { gitBranch } = require('./git-branch.cjs');
const { asOnDisk } = require('./disk-path.cjs');
const { openLog } = require('./client-log.cjs');
const { loadProfiles, encodeProfiles, profileFile } = require('./connection-profiles.cjs');
const { hostname, tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { mkdir, readdir, rmdir, unlink } = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
let bridge;
// The last connection, kept for its installer download after a service refused this client's version.
let lastBridge;
let connectionGeneration = 0;
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
function showWindow() {
  const window = BrowserWindow.getAllWindows()[0];
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
app.on('second-instance', showWindow);
// macOS: a click on the Dock icon while the window is hidden.
app.on('activate', showWindow);

// Window preferences and the optional saved sign-in live in the user's profile, outside the install directory.
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
function readSettings() {
  try {
    return JSON.parse(readFileSync(settingsPath(), 'utf8'));
  } catch {
    return {};
  }
}
function writeSettings(values) {
  const settings = { ...readSettings(), ...values };
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  return settings;
}

// See client-log.cjs. Opened on first use, once the profile directory is known.
let record;
function log(text) {
  record ??= openLog(path.join(app.getPath('userData'), 'logs'));
  record.write(text);
  return record.directory;
}

// A remote connection carries long unattended runs; the computer must not go to sleep underneath it.
// The display may still turn off.
let awake;
function keepAwake(on) {
  if (on && awake === undefined) awake = powerSaveBlocker.start('prevent-app-suspension');
  if (!on && awake !== undefined) {
    powerSaveBlocker.stop(awake);
    awake = undefined;
  }
}

// These channels answer only the application's own page.
function handle(channel, listener) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!event.senderFrame.url.startsWith('file://')) throw new Error('Untrusted renderer');
    return listener(event, ...args);
  });
}

handle('project:choose', async (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(window, {
    title: '添加项目',
    properties: ['openDirectory'],
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
});
handle('project:spelling', (_event, written) => asOnDisk(String(written)));
// Files the user wants to mention in a message: only their paths go to the page.
handle('files:choose', async (event) => {
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    title: '添加文件',
    properties: ['openFile', 'multiSelections'],
  });
  return result.canceled ? [] : result.filePaths;
});
// A picture that is only on the clipboard has no file Claude could be pointed at. It is written into the
// profile, from where Claude reads it like any other attached file; a week later it is removed at start.
const pastedDirectory = () => path.join(app.getPath('userData'), 'pasted');
const pictureTypes = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
};
handle('image:save', async (_event, type, bytes) => {
  const extension = pictureTypes[String(type)];
  if (!extension || !(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 20 << 20)
    throw new Error('只能粘贴不超过 20 MB 的图片。');
  await mkdir(pastedDirectory(), { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const target = path.join(pastedDirectory(), `${stamp}-${randomUUID().slice(0, 6)}.${extension}`);
  await writeFile(target, bytes);
  return target;
});
async function clearPastedPictures() {
  for (const name of await readdir(pastedDirectory()).catch(() => [])) {
    const file = path.join(pastedDirectory(), name);
    const age = Date.now() - (await stat(file).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs;
    if (age > 7 * 24 * 3600 * 1000) await unlink(file).catch(() => {});
  }
}
// Writes text the page produced (an exported session) where the user chooses.
handle('file:save', async (event, name, text) => {
  const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
    title: '导出',
    defaultPath: path.join(app.getPath('downloads'), path.basename(String(name))),
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (result.canceled || !result.filePath) return false;
  await writeFile(result.filePath, String(text), 'utf8');
  return true;
});
handle('folder:open', async (_event, directory) => {
  const target = path.resolve(String(directory));
  if (!(await stat(target)).isDirectory()) throw new Error('不是文件夹。');
  const failure = await shell.openPath(target);
  if (failure) throw new Error(failure);
});
handle('log:open', async () => {
  const failure = await shell.openPath(log('The log folder was opened.'));
  if (failure) throw new Error(failure);
});
// The installed program has no menu that opens the developer tools, and none of the page's shortcuts does:
// they open from the settings page, in a window of their own, for looking into a problem of the interface.
handle('devtools:open', (event) => {
  log('The developer tools were opened.');
  event.sender.openDevTools({ mode: 'detach' });
});
handle('git:branch', (_event, directory) => gitBranch(directory));
handle('clipboard:write', (_event, text) => {
  if (typeof text !== 'string') throw new Error('Expected clipboard text');
  clipboard.writeText(text);
});
// The official sign-in page and this project's own page open in the user's browser; nothing else is handed to the
// system.
handle('external:open', async (event, target) => {
  const url = new URL(String(target));
  if (
    url.protocol !== 'https:' ||
    !/(^|\.)(claude\.com|claude\.ai|anthropic\.com)$|^github\.com$/.test(url.hostname)
  )
    throw new Error('Unexpected link');
  await shell.openExternal(url.toString());
});
// Sessions without a project still need a working directory on this computer; they get one under Documents, grouped by
// day, unless the user chose another folder. Folders used before are remembered: their sessions are still
// sessions without a project.
const defaultRoot = () => path.join(app.getPath('documents'), 'CC Desk Tunnel');
function workspaceRoots() {
  const saved = readSettings().workspaceRoots;
  const roots = [...(Array.isArray(saved) ? saved : []), defaultRoot()].filter(
    (root) => typeof root === 'string' && root,
  );
  // Windows and macOS take a path in any case; Linux tells the cases apart.
  const key = (root) => (process.platform === 'linux' ? root : root.toLowerCase());
  return roots.filter(
    (root, index) => roots.findIndex((item) => key(item) === key(root)) === index,
  );
}
handle('workspace:roots', () => workspaceRoots());
handle('workspace:choose', async (event, reset) => {
  let chosen = defaultRoot();
  if (reset !== true) {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: '普通会话的文件夹',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return workspaceRoots();
    chosen = result.filePaths[0];
  }
  writeSettings({ workspaceRoots: [chosen, ...workspaceRoots()] });
  return workspaceRoots();
});
handle('workspace:create', async (event) => {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const day = path.join(
    workspaceRoots()[0],
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
  );
  await mkdir(day, { recursive: true });
  const name = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  for (let attempt = 0; ; attempt++) {
    const directory = path.join(day, attempt ? `${name}-${attempt}` : name);
    try {
      await mkdir(directory);
      return directory;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
});
handle('workspace:remove', async (event, directory) => {
  const target = path.resolve(String(directory));
  if (
    !workspaceRoots().some((root) =>
      /^\d{4}-\d{2}-\d{2}[\\/][^\\/]+$/.test(path.relative(root, target)),
    )
  )
    return;
  // rmdir only removes empty directories, so anything the session produced stays.
  try {
    await rmdir(target);
    await rmdir(path.dirname(target));
  } catch {}
});
handle('proxy:connect', async (event, config) => {
  if (!config || typeof config.url !== 'string' || typeof config.fingerprint !== 'string')
    throw new Error('Invalid proxy configuration');
  const generation = ++connectionGeneration;
  const previous = bridge;
  bridge = null;
  await previous?.close();
  if (generation !== connectionGeneration) throw new Error('Connection cancelled');
  const { openProxyBridge } = await import(
    pathToFileURL(path.join(__dirname, 'proxy-bridge.mjs')).href
  );
  const vendor =
    process.env.PROXY_VENDOR_DIR ??
    (app.isPackaged
      ? path.join(process.resourcesPath, 'vendor')
      : path.join(__dirname, '../vendor'));
  const openssh = process.env.PROXY_OPENSSH_DIR ?? path.join(vendor, 'openssh');
  const powershell = app.isPackaged ? path.join(vendor, 'pwsh/pwsh.exe') : 'pwsh.exe';
  const connection = await openProxyBridge(
    config,
    {
      openssh,
      powershell,
      scriptDirectory: app.isPackaged
        ? path.join(process.resourcesPath, 'app.asar.unpacked/electron')
        : undefined,
      // Where Claude finds the scheduled tasks to edit; the service names the variable, not the path.
      environment: { CC_DESK_TUNNEL_SCHEDULES: schedulesPath(config.profileId) },
      log,
      // The system's proxy settings (manual, script or automatic detection) as Chromium reads them.
      resolveProxy: (url) => session.defaultSession.resolveProxy(url),
    },
    () => {
      if (bridge !== connection) return;
      bridge = null;
      keepAwake(false);
      if (!event.sender.isDestroyed()) event.sender.send('proxy:closed');
    },
  );
  if (generation !== connectionGeneration) {
    await connection.close();
    throw new Error('Connection cancelled');
  }
  bridge = lastBridge = connection;
  keepAwake(true);
  return { url: bridge.url };
});
// Each token uses the current OS account's secure storage. The old single login becomes the default profile.
handle('profiles:load', () => loadProfiles(readSettings(), safeStorage));
handle('profiles:save', (_event, profiles) => {
  writeSettings({ connectionProfiles: encodeProfiles(profiles, safeStorage), login: undefined });
});
handle('profiles:quota', async (_event, id) => {
  const profile = loadProfiles(readSettings(), safeStorage)?.profiles.find(
    (item) => item.id === id,
  );
  if (!profile?.token) throw new Error('请先为此账号保存服务凭据。');
  const { probeQuota } = await import(pathToFileURL(path.join(__dirname, 'quota-probe.mjs')).href);
  return probeQuota(profile, (url) => session.defaultSession.resolveProxy(url));
});
// Replaces a file whole through a flushed temporary file, so a crash or power loss in the middle of a write
// leaves the previous content in place.
function replaceFile(target, text) {
  const temporary = `${target}.tmp`;
  const file = openSync(temporary, 'w');
  try {
    writeSync(file, text);
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  renameSync(temporary, target);
}
// Unsent message text, per session.
const draftsPath = (id) => profileFile(app.getPath('userData'), 'drafts', id);
handle('drafts:load', (_event, id) => {
  try {
    return JSON.parse(readFileSync(draftsPath(id), 'utf8'));
  } catch {
    return {};
  }
});
handle('drafts:save', (_event, drafts, id) => replaceFile(draftsPath(id), JSON.stringify(drafts)));
// Scheduled tasks are one JSON file that the window, the user and Claude over SSH may all edit. The window
// decides what the text means; here it is only read, written and watched. An editor's byte-order mark is
// dropped.
const schedulesPath = (id) => profileFile(app.getPath('userData'), 'schedules', id);
const readSchedules = (id) => readFileSync(schedulesPath(id), 'utf8').replace(/^\uFEFF/, '');
const schedules = new Map();
let scheduleWatcher;
handle('schedules:load', (_event, initial, id = 'default') => {
  if (!existsSync(schedulesPath(id))) replaceFile(schedulesPath(id), String(initial));
  // An edit made outside the window is noticed by looking at the file every two seconds.
  if (!scheduleWatcher) {
    scheduleWatcher = setInterval(() => {
      for (const [scope, previous] of schedules) {
        try {
          const text = readSchedules(scope);
          if (text === previous) continue;
          schedules.set(scope, text);
          BrowserWindow.getAllWindows()[0]?.webContents.send('schedules:changed', text, scope);
        } catch {}
      }
    }, 2000);
  }
  const text = readSchedules(id);
  schedules.set(id, text);
  return { path: schedulesPath(id), text };
});
handle('schedules:save', (_event, text, id = 'default') => {
  replaceFile(schedulesPath(id), String(text));
  schedules.set(id, String(text));
});
handle('app:version', () => app.getVersion());
// Which of the user's computers this is to the service: an ID made once and kept, under the computer's name.
handle('device:get', () => ({
  id: readSettings().deviceId ?? writeSettings({ deviceId: randomUUID() }).deviceId,
  name: hostname(),
}));
handle('app:quit', () => app.quit());
let refreshTray = () => {};
handle('window:settings', () => ({ closeToTray: readSettings().closeToTray !== false }));
handle('window:settings:set', (_event, values) => {
  writeSettings({ closeToTray: values?.closeToTray !== false });
  refreshTray();
});
// What the user should know while the window is not in front goes through the system's own notifications.
// A notification is kept until it closes, or it could be collected before it is clicked.
const toasts = new Set();
handle('notify:show', (event, notice) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || !Notification.isSupported()) return;
  const inFront = window.isVisible() && window.isFocused() && !window.isMinimized();
  if (inFront && notice?.always !== true) return;
  const toast = new Notification({
    title: String(notice?.title ?? '').slice(0, 80),
    body: String(notice?.body ?? '').slice(0, 300),
    silent: notice?.silent === true,
    icon: path.join(__dirname, 'icon.png'),
  });
  toasts.add(toast);
  toast.on('close', () => toasts.delete(toast));
  toast.on('click', () => {
    toasts.delete(toast);
    showWindow();
    if (!event.sender.isDestroyed())
      event.sender.send(
        'notify:clicked',
        notice?.sessionId ? String(notice.sessionId) : null,
        notice?.profileId ?? 'default',
      );
  });
  toast.show();
  // What waits for the user also asks for attention in the taskbar or the Dock, from a window left open
  // behind others. The rest is said by the notification alone: an icon that flashes long after the
  // notification went away, or where the system shows none, points at nothing.
  if (notice?.attention === true && window.isVisible() && !inFront) {
    window.flashFrame(true);
    window.once('focus', () => window.flashFrame(false));
  }
});
// Upgrades in place: the installer runs silently over the current install and starts the new version. It
// comes from the connected service, or, when the user chooses so, straight from the release page: `version`
// is then the one to fetch, which the service's refusal of this client named.
handle('update:install', async (event, version) => {
  if (!app.isPackaged) throw new Error('源码运行不支持自升级；请重新打包安装。');
  // Only the Windows installer can be run over an installation. Elsewhere the user installs a new package.
  if (process.platform !== 'win32')
    throw new Error('这个系统上的客户端不能在应用内升级，请到发布页下载新版本。');
  const directory = await mkdtemp(path.join(tmpdir(), 'cc-desk-tunnel-update-'));
  let installer;
  if (version === undefined) {
    if (!lastBridge) throw new Error('请先连接服务。');
    installer = await lastBridge.downloadInstaller(directory);
  } else {
    const { downloadRelease } = await import(
      pathToFileURL(path.join(__dirname, 'release-download.mjs')).href
    );
    let told = 0;
    // Chromium's network stack: the Windows proxy settings apply, as they do to the connection itself.
    installer = await downloadRelease((url, init) => net.fetch(url, init), version, directory, {
      announced: lastBridge?.release(),
      progress(received, size) {
        if (Date.now() - told < 500 && received < size) return;
        told = Date.now();
        if (!event.sender.isDestroyed()) event.sender.send('update:progress', { received, size });
      },
    });
  }
  spawn(installer, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
  app.quit();
});
ipcMain.handle('proxy:disconnect', async () => {
  keepAwake(false);
  connectionGeneration++;
  const previous = bridge;
  bridge = null;
  await previous?.close();
});

// Windows files notifications under this identity; the installer gives the shortcut the same one.
if (process.platform === 'win32')
  app.setAppUserModelId(app.isPackaged ? 'io.github.ccdesktunnel.desktop' : process.execPath);
app.whenReady().then(() => {
  log(`Client ${app.getVersion()} started.`);
  void clearPastedPictures();
  if (!ownsInstance) return;
  // Shortcuts are the page's, where the user can change them or turn them off; Electron's default menu would
  // add its own on top (zoom, reload, close). A run from source keeps reload and the developer tools.
  // macOS has one menu bar for every program and takes the keys of copying, pasting, hiding and quitting from
  // what is in it: without these entries they do nothing. The page's own menus stay in its title bar.
  const development = app.isPackaged
    ? []
    : [{ label: '开发', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }] }];
  Menu.setApplicationMenu(
    process.platform === 'darwin'
      ? Menu.buildFromTemplate([
          {
            label: app.name,
            submenu: [
              { role: 'about', label: '关于 CC Desk Tunnel' },
              { type: 'separator' },
              { role: 'hide', label: '隐藏 CC Desk Tunnel' },
              { role: 'hideOthers', label: '隐藏其他' },
              { role: 'unhide', label: '全部显示' },
              { type: 'separator' },
              { role: 'quit', label: '退出 CC Desk Tunnel' },
            ],
          },
          {
            label: '编辑',
            submenu: [
              { role: 'undo', label: '撤销' },
              { role: 'redo', label: '重做' },
              { type: 'separator' },
              { role: 'cut', label: '剪切' },
              { role: 'copy', label: '复制' },
              { role: 'paste', label: '粘贴' },
              { role: 'selectAll', label: '全选' },
            ],
          },
          { role: 'windowMenu', label: '窗口' },
          ...development,
        ])
      : development.length
        ? Menu.buildFromTemplate(development)
        : null,
  );
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  const window = new BrowserWindow({
    width: 1240,
    height: 850,
    minWidth: 380,
    minHeight: 560,
    backgroundColor: '#edf0f6',
    title: 'CC Desk Tunnel',
    // The page draws the title bar; the system adds only its window buttons: over the bar's right end on
    // Windows, at its left end on macOS, where the page leaves them room (see `.titlebar` in style.css).
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#edf0f6', symbolColor: '#22262e', height: 40 },
    trafficLightPosition: { x: 14, y: 13 },
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    show: !process.argv.includes('--smoke-test'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // A hidden window keeps its connection timers at full rate.
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.cjs'),
      // Only a build run from the source tree offers the login page's simulation mode.
      additionalArguments: app.isPackaged ? [] : ['--cc-desk-tunnel-dev'],
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // Electron does not provide an editing menu by default. Native roles keep text selection, undo and paste
  // in the focused input, without exposing clipboard reads to the renderer.
  window.webContents.on('context-menu', (_event, params) => {
    if (!params.isEditable) return;
    Menu.buildFromTemplate([
      { role: 'undo', label: '撤销', enabled: params.editFlags.canUndo },
      { role: 'redo', label: '重做', enabled: params.editFlags.canRedo },
      { type: 'separator' },
      { role: 'cut', label: '剪切', enabled: params.editFlags.canCut },
      { role: 'copy', label: '复制', enabled: params.editFlags.canCopy },
      { role: 'paste', label: '粘贴', enabled: params.editFlags.canPaste },
      { role: 'selectAll', label: '全选' },
    ]).popup({ window });
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.loadFile(path.join(__dirname, '../dist/index.html'));

  // Long tasks keep running with the window closed: closing hides it, and the tray icon brings it back or quits.
  const closeToTray = () => readSettings().closeToTray !== false;
  // The macOS menu bar takes a small shape in one colour, which it tints itself for light and dark.
  const tray = new Tray(
    process.platform === 'darwin'
      ? require('./tray-icon.cjs').terminalTemplate(nativeImage)
      : nativeImage
          .createFromPath(path.join(__dirname, 'icon.png'))
          .resize({ width: 32, height: 32 }),
  );
  const buildMenu = () =>
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '显示窗口', click: showWindow },
        {
          label: '关闭窗口时留在后台',
          type: 'checkbox',
          checked: closeToTray(),
          click: (item) => {
            writeSettings({ closeToTray: item.checked });
            buildMenu();
          },
        },
        { type: 'separator' },
        { label: '退出', click: () => app.quit() },
      ]),
    );
  tray.setToolTip('CC Desk Tunnel');
  tray.on('click', showWindow);
  buildMenu();
  refreshTray = buildMenu;
  window.on('close', (event) => {
    if (quitting || !closeToTray()) return;
    event.preventDefault();
    window.hide();
    if (!readSettings().trayHintShown) {
      writeSettings({ trayHintShown: true });
      // Balloons are a thing of the Windows tray.
      if (process.platform === 'win32')
        tray.displayBalloon({
          title: 'CC Desk Tunnel 仍在后台运行',
          content: '点击托盘图标恢复窗口；右键图标选择“退出”才会结束连接。',
        });
    }
  });
});
let quitting = false;
let exiting = false;
app.on('before-quit', (event) => {
  quitting = true;
  if (exiting || !bridge) return;
  event.preventDefault();
  exiting = true;
  bridge.close().finally(() => app.quit());
});
app.on('window-all-closed', () => app.quit());
