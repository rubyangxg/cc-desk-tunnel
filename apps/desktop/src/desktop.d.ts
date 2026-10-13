export {};
declare global {
  interface Window {
    desktop?: {
      // Run from the source tree, not installed: the login page then also offers the simulation service.
      dev: boolean;
      platform: 'win32' | 'darwin' | 'linux';
      chooseProject: () => Promise<string | null>;
      asOnDisk: (path: string) => Promise<string>;
      // Files to mention in a message; the paths of the ones chosen.
      chooseFiles: () => Promise<string[]>;
      pathForFile: (file: File) => string;
      // Asks where to save and writes the text there; false when the dialog was cancelled.
      saveFile: (name: string, text: string) => Promise<boolean>;
      openFolder: (path: string) => Promise<void>;
      openLogs: () => Promise<void>;
      openDevTools: () => Promise<void>;
      saveImage: (type: string, bytes: Uint8Array) => Promise<string>;
      // The branch a project's working tree is on, or null outside a repository.
      gitBranch: (path: string) => Promise<string | null>;
      copyText: (text: string) => Promise<void>;
      openExternal: (url: string) => Promise<void>;
      // The folders holding sessions without a project; new ones are made in the first.
      workspaceRoots: () => Promise<string[]>;
      // Asks for another folder, or goes back to the one under Documents; the folders as they are afterwards.
      chooseWorkspace: (reset: boolean) => Promise<string[]>;
      createWorkspace: () => Promise<string>;
      removeWorkspace: (directory: string) => Promise<void>;
      loadProfiles: () => Promise<import('./connections.ts').ConnectionProfiles | null>;
      saveProfiles: (profiles: import('./connections.ts').ConnectionProfiles) => Promise<void>;
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
      quit: () => Promise<void>;
      version: () => Promise<string>;
      // This computer as the service knows it.
      device: () => Promise<import('@cc-desk-tunnel/protocol').Device>;
      // Fetches and runs an installer: the one the connected service holds, or, given a version, that
      // version's from the release page.
      installUpdate: (version?: string) => Promise<void>;
      onUpdateProgress: (
        callback: (progress: { received: number; size: number }) => void,
      ) => () => void;
      connectProxy: (config: {
        profileId?: string;
        url: string;
        fingerprint: string;
        // Seconds allowed for reaching the service, for the local SSH service to start, and for the whole.
        waits?: { connect: number; ssh: number; ready: number };
      }) => Promise<{ url: string }>;
      disconnectProxy: () => Promise<void>;
      onProxyClosed: (callback: () => void) => () => void;
    };
  }
}
