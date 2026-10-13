import { withProject } from './paths.ts';

const storageKey = 'proxy-local-projects';
const legacyKey = 'proxy-projects';

function read(storage: Storage, key: string): string[] | null {
  try {
    const value: unknown = JSON.parse(storage.getItem(key) ?? 'null');
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string' && !!item.trim())
      : null;
  } catch {
    return null;
  }
}

// Local folders belong to this computer. Merge all old profile lists on the first load, including
// lists left behind by removed profiles. Keep those original keys intact as a migration backup.
export function loadProjects(storage: Storage, computerProjects?: unknown): string[] {
  if (Array.isArray(computerProjects))
    return computerProjects
      .filter((item): item is string => typeof item === 'string' && !!item.trim())
      .reduce(withProject, [] as string[]);
  const shared = read(storage, storageKey);
  if (shared) return shared.reduce(withProject, [] as string[]);
  let projects = read(storage, legacyKey) ?? [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith(`${legacyKey}:`)) projects.push(...(read(storage, key) ?? []));
  }
  return projects.reduce(withProject, [] as string[]);
}

export function saveProjects(storage: Storage, projects: string[]) {
  storage.setItem(storageKey, JSON.stringify(projects));
}
