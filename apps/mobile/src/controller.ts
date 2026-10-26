import { ProxyClient } from '../../desktop/src/client.ts';
import { NativeSocket, type Profile, type Setup } from './native.ts';
export class Controllers {
  entries = new Map<string, { profile: Profile; client: ProxyClient; dispose: () => void }>();
  version = 0;
  listeners = new Set<() => void>();
  deviceId = '';
  snapshot = () => this.version;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  changed = () => {
    this.version++;
    for (const f of this.listeners) f();
  };
  configure(setup: Setup) {
    this.deviceId = setup.deviceId;
    for (const [id, entry] of this.entries) {
      if (!setup.profiles.some((p) => p.id === id)) {
        entry.dispose();
        entry.client.disconnect();
        this.entries.delete(id);
      }
    }
    for (const profile of setup.profiles) {
      const old = this.entries.get(profile.id);
      if (old) {
        old.profile = profile;
        continue;
      }
      const client = new ProxyClient();
      let connected = false;
      const dispose = client.subscribe(() => {
        const now = client.state.status === 'connected';
        if (now && !connected) {
          connected = true;
          if (client.state.features.includes('account-pool'))
            void client.request({ type: 'pool.status' }).catch(() => {});
        } else if (!now) connected = false;
        this.changed();
      });
      this.entries.set(profile.id, { profile, client, dispose });
      this.connect(profile.id);
    }
    this.changed();
  }
  connect(id: string) {
    this.entries
      .get(id)
      ?.client.connectController(
        { id: this.deviceId, name: 'Android 手机' },
        () => new NativeSocket(id),
      );
  }
}
