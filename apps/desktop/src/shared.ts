import { useSyncExternalStore } from 'react';

// What all of this computer's connections have in common. Each connection is a window of its own with its own
// profile (see electron/connections.cjs); these values are also shared between the service workspaces
// kept alive in the same window.
export type Connection = { id: string; name: string };
export type ListedConnection = Connection & { current: boolean; open: boolean };
// A running session of a connection and the folder on this computer it works in.
export type Run = { id: string; folder: string };
export type Shared = {
  prefs?: unknown;
  projects?: unknown;
  connections: Connection[];
  // What the other connections have running now, by their names.
  busy: { name: string; runs: Run[] }[];
};

const boot = window.desktop?.boot;
const values: Shared = { connections: [], busy: [], ...boot?.shared };
const listeners = new Set<() => void>();
const changes = new Set<(key: keyof Shared, value: unknown) => void>();
function changed(key: keyof Shared, value: unknown) {
  for (const listener of listeners) listener();
  for (const listener of changes) listener(key, value);
}
window.desktop?.onSharedChanged((key, value) => {
  values[key] = value as never;
  changed(key, value);
});
function onShared(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
// Notify all mounted service workspaces, including changes from another desktop window.
export function onSharedChange<K extends keyof Shared>(key: K, take: (value: Shared[K]) => void) {
  const listener = (changed: keyof Shared, value: unknown) => {
    if (changed === key) take(value as Shared[K]);
  };
  changes.add(listener);
  return () => {
    changes.delete(listener);
  };
}
export const shared = <K extends keyof Shared>(key: K) => values[key];
export const useShared = <K extends keyof Shared>(key: K) =>
  useSyncExternalStore(onShared, () => values[key]);
export function saveShared(key: 'prefs' | 'projects', value: unknown) {
  if (JSON.stringify(values[key]) === JSON.stringify(value)) return;
  values[key] = value;
  changed(key, value);
  void window.desktop?.saveShared(key, value).catch(() => {});
}
// The first connection had these values to itself before they were shared, and brings them along.
export function shareOnce(key: 'prefs' | 'projects', value: unknown) {
  if (boot?.connection === '' && values[key] === undefined) saveShared(key, value);
}
// The connection's name, once there are several to tell apart.
export function useConnectionName() {
  const connections = useShared('connections');
  return connections.length > 1
    ? (connections.find((entry) => entry.id === boot?.connection)?.name ?? '')
    : '';
}
