/// <reference types="vite/client" />
export {};
declare global {
  interface Window {
    desktop?: {
      // Run from the source tree, not installed: the login page then also offers the simulation service.
      dev: boolean;
      platform: 'win32' | 'darwin' | 'linux';
      // Which of this computer's connections the window is ('' the first), and what they all share.
      boot: { connection: string; shared: import('./shared.ts').Shared };
      saveShared: (key: 'prefs' | 'projects', value: unknown) => Promise<void>;
      // The computer's project list from before the service kept them, while this connection has yet to hand it
      // to its service, and the call that says it has (see App.tsx).
      legacyProjects: (
        profileId?: string,
        historyId?: string,
      ) => Promise<{ projects: string[]; names: Record<string, string>; key?: string } | null>;
      legacyProjectsMoved: (profileId?: string, historyId?: string, key?: string) => Promise<void>;
      onSharedChanged: (
        callback: (key: keyof import('./shared.ts').Shared, value: unknown) => void,
      ) => () => void;
      // The sessions running in this window, for the other connections' windows to warn about.
      setBusy: (runs: import('./shared.ts').Run[], profileId?: string) => Promise<void>;
      // Each connection is a window of its own; `open` tells whether it is running now.
      connections: () => Promise<import('./shared.ts').ListedConnection[]>;
      createConnection: (name: string) => Promise<import('./shared.ts').ListedConnection[]>;
      openConnection: (id: string) => Promise<void>;
      renameConnection: (
        id: string,
        name: string,
      ) => Promise<import('./shared.ts').ListedConnection[]>;
      removeConnection: (id: string) => Promise<import('./shared.ts').ListedConnection[]>;
      chooseProject: () => Promise<string | null>;
      asOnDisk: (path: string) => Promise<string>;
      // Whether each folder is on this computer, in the order given.
      foldersExist: (folders: string[]) => Promise<boolean[]>;
      // Files to mention in a message; the paths of the ones chosen.
      chooseFiles: () => Promise<string[]>;
      loadSharedDocument: () => Promise<import('./SharedDocument.tsx').DocumentState>;
      saveSharedDocument: (
        text: string,
        version: string,
      ) => Promise<import('./SharedDocument.tsx').DocumentState>;
      importSharedDocument: () => Promise<string | null>;
      pathForFile: (file: File) => string;
      // Asks where to save and writes the text there; false when the dialog was cancelled.
      saveFile: (name: string, text: string) => Promise<boolean>;
      openFolder: (path: string) => Promise<void>;
      openLogs: () => Promise<void>;
      openDevTools: () => Promise<void>;
      saveImage: (type: string, bytes: Uint8Array) => Promise<string>;
      // The branch a project's working tree is on, or null outside a repository.
      gitBranch: (path: string) => Promise<string | null>;
      // The file panel's files (see electron/files.mjs): `local` is this computer, `server` the service, any
      // other target one of the user's computers by its ID. Paths are as the target names them.
      filesFor?: (profileId: string) => NonNullable<Window['desktop']>['files'];
      files: {
        list: (target: string, directory: string) => Promise<import('./files.ts').FileEntry[]>;
        // The home directory a target starts in.
        home: (target: string) => Promise<string>;
        chooseFolder: () => Promise<string | null>;
        stat: (
          target: string,
          file: string,
        ) => Promise<{ kind: 'file' | 'directory'; size: number; mtime: number }>;
        read: (
          target: string,
          file: string,
          limit?: number,
        ) => Promise<{ bytes: Uint8Array; size: number; truncated: boolean }>;
        mkdir: (target: string, directory: string) => Promise<void>;
        rename: (target: string, from: string, to: string) => Promise<void>;
        remove: (target: string, files: string[]) => Promise<void>;
        exists: (target: string, directory: string, names: string[]) => Promise<boolean[]>;
        // Copies into a directory of another target; `onProgress` hears of it under `id`.
        transfer: (
          id: string,
          request: {
            from: { target: string; paths: string[] };
            to: { target: string; dir: string };
            conflict?: 'replace' | 'skip' | 'resume';
          },
        ) => Promise<{ files: number; bytes: number }>;
        cancel: (id: string) => Promise<void>;
        // What git sees changed in a project of this computer; null outside a repository or without git.
        changes: (directory: string) => Promise<{ path: string; status: string }[] | null>;
        // Starts dragging a file of this computer out of the window.
        drag: (file: string) => void;
        onProgress: (
          callback: (id: string, report: { done: number; total: number; name: string }) => void,
        ) => () => void;
      };
      copyText: (text: string) => Promise<void>;
      openExternal: (url: string) => Promise<void>;
      openWeb: (url: string) => Promise<void>;
      // A web address a reply links to, in the user's browser.
      openLink: (url: string) => Promise<void>;
      // What a path a reply links to is on this computer; `runs` when opening it would run something.
      // `editors` are the installed code editors, the one to use first.
      inspectPath: (path: string) => Promise<{
        kind: 'file' | 'directory' | 'missing';
        runs: boolean;
        editors: { scheme: string; name: string }[];
        openWith: boolean;
      }>;
      // Does something with a linked path; what to tell the user, or ''.
      actOnPath: (
        action: 'open' | 'default' | 'editor' | 'with' | 'reveal' | 'content' | 'save',
        path: string,
        options?: { line?: number; column?: number; editor?: string },
      ) => Promise<string>;
      // The folders holding sessions without a project; new ones are made in the first.
      workspaceRoots: () => Promise<string[]>;
      // Asks for another folder, or goes back to the one under Documents; the folders as they are afterwards.
      chooseWorkspace: (reset: boolean) => Promise<string[]>;
      createWorkspace: () => Promise<string>;
      removeWorkspace: (directory: string) => Promise<void>;
      loadProfiles: () => Promise<import('./connections.ts').ConnectionProfiles | null>;
      saveProfiles: (profiles: import('./connections.ts').ConnectionProfiles) => Promise<void>;
      profileSessions: (id: string) => Promise<import('@cc-desk-tunnel/protocol').Session[]>;
      profilePool: (
        id: string,
        command?: import('./UnifiedAccountPool.tsx').PoolCommand,
      ) => Promise<import('./UnifiedAccountPool.tsx').PoolSnapshot>;
      probeQuota: (
        id: string,
      ) => Promise<import('@cc-desk-tunnel/protocol').NativeMetrics['rateLimits']>;
      loadDrafts: (profileId?: string) => Promise<Record<string, string>>;
      saveDrafts: (drafts: Record<string, string>, profileId?: string) => Promise<void>;
      loadSchedules: (
        initial: string,
        profileId?: string,
      ) => Promise<{ path: string; text: string }>;
      saveSchedules: (text: string, profileId?: string) => Promise<void>;
      onSchedulesChanged: (callback: (text: string) => void, profileId?: string) => () => void;
      windowSettings: () => Promise<{ closeToTray: boolean }>;
      setWindowSettings: (values: { closeToTray: boolean }) => Promise<void>;
      // A system notification, shown unless the window is in front (`always` shows it regardless). `attention`
      // also flashes the taskbar button, or bounces the Dock icon, of a window left open behind others.
      notify: (notice: {
        profileId?: string;
        title: string;
        body: string;
        sessionId: string | null;
        silent: boolean;
        always?: boolean;
        attention?: boolean;
      }) => Promise<void>;
      onNotifyClicked: (
        callback: (sessionId: string | null) => void,
        profileId?: string,
      ) => () => void;
      // 1 and -1 step the interface size, 0 restores it.
      zoom: (direction: number) => void;
      // `all` also closes the windows of the other connections.
      quit: (all?: boolean) => Promise<void>;
      version: () => Promise<string>;
      // The notes of a released version, read from its page on GitHub.
      releaseNotes: (version: string) => Promise<string>;
      // This computer as the service knows it.
      device: () => Promise<import('@cc-desk-tunnel/protocol').Device>;
      // Fetches and runs an installer: the one the connected service holds, or, given a version, that
      // version's from the release page. Ends `cancelled` when stopped with `cancelUpdate`; otherwise the
      // client quits for the installer.
      installUpdate: (version?: string, profileId?: string) => Promise<{ cancelled?: boolean }>;
      cancelUpdate: (profileId?: string) => Promise<void>;
      onUpdateProgress: (
        callback: (step: import('./client-upgrade.ts').UpgradeStep) => void,
      ) => () => void;
      // What a service that refused this client says to it now (see probeService in electron/service-upgrade.mjs).
      probeService: (config: {
        url: string;
        fingerprint: string;
        token: string;
        deviceName: string;
      }) => Promise<
        | { status: 'ready' | 'unreachable' }
        | { status: 'failed'; error: string }
        | {
            status: 'refused';
            service: string | null;
            release: string | null;
            preparing: number | null;
          }
      >;
      // Has a service that refused this client as the newer one upgrade itself to the newest release, given
      // the service's version from the refusal; ends with the version installed or why it was not.
      upgradeService: (config: {
        url: string;
        fingerprint: string;
        token: string;
        deviceName: string;
        service: string;
        // Upgrades even while sessions are at work (see FORCED_UPGRADE_SINCE).
        force?: boolean;
      }) => Promise<{ version?: string; error?: string; code?: string }>;
      // Opens the session in ccdt, the terminal client, signed in to this window's service with its token; says
      // instead when ccdt is not installed, or not of this client's release.
      openInCcdt: (request: {
        url: string;
        fingerprint: string;
        token: string;
        sessionId: string;
        projectPath?: string;
      }) => Promise<{ status: 'opened' | 'missing' } | { status: 'outdated'; installed: string }>;
      onServiceUpgrade: (
        callback: (update: import('@cc-desk-tunnel/protocol').ServiceUpdate) => void,
      ) => () => void;
      connectProxy: (config: {
        profileId?: string;
        url: string;
        fingerprint: string;
        // Seconds allowed for reaching the service, for the local SSH service to start, and for the whole.
        waits?: { connect: number; ssh: number; ready: number };
      }) => Promise<{ url: string }>;
      disconnectProxy: (profileId?: string) => Promise<void>;
      onProxyClosed: (callback: (profileId: string) => void) => () => void;
    };
  }
}
