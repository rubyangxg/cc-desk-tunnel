const { contextBridge, ipcRenderer, webFrame, webUtils } = require('electron');

const filesFor = (profileId = 'default') => ({
  list: (target, directory) => ipcRenderer.invoke('panel:list', target, directory, profileId),
  home: (target) => ipcRenderer.invoke('panel:home', target, profileId),
  chooseFolder: () => ipcRenderer.invoke('panel:choose-folder'),
  stat: (target, file) => ipcRenderer.invoke('panel:stat', target, file, profileId),
  read: (target, file, limit) => ipcRenderer.invoke('panel:read', target, file, limit, profileId),
  mkdir: (target, directory) => ipcRenderer.invoke('panel:mkdir', target, directory, profileId),
  rename: (target, from, to) => ipcRenderer.invoke('panel:rename', target, from, to, profileId),
  remove: (target, files) => ipcRenderer.invoke('panel:remove', target, files, profileId),
  exists: (target, directory, names) =>
    ipcRenderer.invoke('panel:exists', target, directory, names, profileId),
  transfer: (id, request) => ipcRenderer.invoke('panel:transfer', id, request, profileId),
  cancel: (id) => ipcRenderer.invoke('panel:cancel', id, profileId),
  changes: (directory) => ipcRenderer.invoke('panel:changes', directory),
  drag: (file) => ipcRenderer.send('panel:drag', file),
  onProgress: (callback) => {
    const listener = (_event, id, report, source = 'default') => {
      if (source === profileId) callback(id, report);
    };
    ipcRenderer.on('panel:progress', listener);
    return () => ipcRenderer.removeListener('panel:progress', listener);
  },
});
contextBridge.exposeInMainWorld('desktop', {
  dev: process.argv.includes('--cc-desk-tunnel-dev'),
  platform: process.platform,
  // Read once, before the page draws: see `boot` in main.cjs.
  boot: ipcRenderer.sendSync('boot'),
  saveShared: (key, value) => ipcRenderer.invoke('shared:save', key, value),
  onSharedChanged: (callback) => {
    const listener = (_event, key, value) => callback(key, value);
    ipcRenderer.on('shared:changed', listener);
    return () => ipcRenderer.removeListener('shared:changed', listener);
  },
  setBusy: (runs, profileId) => ipcRenderer.invoke('busy:set', runs, profileId),
  connections: () => ipcRenderer.invoke('connections:list'),
  createConnection: (name) => ipcRenderer.invoke('connections:create', name),
  openConnection: (id) => ipcRenderer.invoke('connections:open', id),
  renameConnection: (id, name) => ipcRenderer.invoke('connections:rename', id, name),
  removeConnection: (id) => ipcRenderer.invoke('connections:remove', id),
  chooseProject: () => ipcRenderer.invoke('project:choose'),
  asOnDisk: (path) => ipcRenderer.invoke('project:spelling', path),
  foldersExist: (folders) => ipcRenderer.invoke('folders:exist', folders),
  chooseFiles: () => ipcRenderer.invoke('files:choose'),
  loadSharedDocument: () => ipcRenderer.invoke('document:load'),
  saveSharedDocument: (text, version) => ipcRenderer.invoke('document:save', text, version),
  importSharedDocument: () => ipcRenderer.invoke('document:import'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  saveFile: (name, text) => ipcRenderer.invoke('file:save', name, text),
  saveImage: (type, bytes) => ipcRenderer.invoke('image:save', type, bytes),
  openFolder: (directory) => ipcRenderer.invoke('folder:open', directory),
  openLogs: () => ipcRenderer.invoke('log:open'),
  openDevTools: () => ipcRenderer.invoke('devtools:open'),
  gitBranch: (directory) => ipcRenderer.invoke('git:branch', directory),
  files: filesFor(),
  filesFor,
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  openExternal: (url) => ipcRenderer.invoke('external:open', url),
  openWeb: (url) => ipcRenderer.invoke('web:open', url),
  openLink: (url) => ipcRenderer.invoke('link:open', url),
  inspectPath: (path) => ipcRenderer.invoke('path:inspect', path),
  actOnPath: (action, path, options) => ipcRenderer.invoke('path:act', action, path, options),
  workspaceRoots: () => ipcRenderer.invoke('workspace:roots'),
  chooseWorkspace: (reset) => ipcRenderer.invoke('workspace:choose', reset),
  createWorkspace: () => ipcRenderer.invoke('workspace:create'),
  removeWorkspace: (directory) => ipcRenderer.invoke('workspace:remove', directory),
  loadProfiles: () => ipcRenderer.invoke('profiles:load'),
  saveProfiles: (profiles) => ipcRenderer.invoke('profiles:save', profiles),
  profilePool: (id, command) => ipcRenderer.invoke('profiles:pool', id, command),
  probeQuota: (id) => ipcRenderer.invoke('profiles:quota', id),
  profileSessions: (id) => ipcRenderer.invoke('profiles:sessions', id),
  loadDrafts: (id) => ipcRenderer.invoke('drafts:load', id),
  saveDrafts: (drafts, id) => ipcRenderer.invoke('drafts:save', drafts, id),
  loadSchedules: (initial, id) => ipcRenderer.invoke('schedules:load', initial, id),
  saveSchedules: (text, id) => ipcRenderer.invoke('schedules:save', text, id),
  onSchedulesChanged: (callback, id = 'default') => {
    const listener = (_event, text, scope) => {
      if (scope === id) callback(text);
    };
    ipcRenderer.on('schedules:changed', listener);
    return () => ipcRenderer.removeListener('schedules:changed', listener);
  },
  windowSettings: () => ipcRenderer.invoke('window:settings'),
  setWindowSettings: (values) => ipcRenderer.invoke('window:settings:set', values),
  notify: (notice) => ipcRenderer.invoke('notify:show', notice),
  onNotifyClicked: (callback, id = 'default') => {
    const listener = (_event, sessionId, scope) => {
      if (scope === id) callback(sessionId);
    };
    ipcRenderer.on('notify:clicked', listener);
    return () => ipcRenderer.removeListener('notify:clicked', listener);
  },
  zoom: (direction) =>
    webFrame.setZoomLevel(direction ? webFrame.getZoomLevel() + Math.sign(direction) * 0.5 : 0),
  quit: (all) => ipcRenderer.invoke('app:quit', all),
  version: () => ipcRenderer.invoke('app:version'),
  releaseNotes: (version) => ipcRenderer.invoke('release:notes', version),
  device: () => ipcRenderer.invoke('device:get'),
  installUpdate: (version, profileId) => ipcRenderer.invoke('update:install', version, profileId),
  onUpdateProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('update:progress', listener);
    return () => ipcRenderer.removeListener('update:progress', listener);
  },
  upgradeService: (config) => ipcRenderer.invoke('service:upgrade', config),
  openInCcdt: (request) => ipcRenderer.invoke('ccdt:open', request),
  onServiceUpgrade: (callback) => {
    const listener = (_event, update) => callback(update);
    ipcRenderer.on('service:upgrade-progress', listener);
    return () => ipcRenderer.removeListener('service:upgrade-progress', listener);
  },
  connectProxy: (config) => ipcRenderer.invoke('proxy:connect', config),
  disconnectProxy: (profileId) => ipcRenderer.invoke('proxy:disconnect', profileId),
  onProxyClosed: (callback) => {
    const listener = (_event, profileId) => callback(profileId);
    ipcRenderer.on('proxy:closed', listener);
    return () => ipcRenderer.removeListener('proxy:closed', listener);
  },
});
// Kept apart from `desktop`: the replies' translation, with the user's own API (see translation.cjs in main).
contextBridge.exposeInMainWorld('translator', {
  settings: () => ipcRenderer.invoke('translation:settings'),
  save: (change) => ipcRenderer.invoke('translation:save', change),
  models: (draft) => ipcRenderer.invoke('translation:models', draft),
  test: (draft) => ipcRenderer.invoke('translation:test', draft),
  cached: (text) => ipcRenderer.invoke('translation:cached', text),
  translate: (text) => ipcRenderer.invoke('translation:translate', text),
});
