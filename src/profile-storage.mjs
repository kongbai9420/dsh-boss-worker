import { join } from 'node:path';
import { homedir } from 'node:os';

// Only resolve paths: loading/saving remains the owning service's responsibility.
// In particular, selecting a different profile must never copy or merge its data.
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const STORE_SUBDIRECTORY = 'dsh-lead-worker';
const STORE_FILENAME = 'session-configs.json';

/**
 * Resolve the legacy-named store inside the active DSH profile.
 * Both home and profile name must be explicit for the named-profile env branch;
 * do not silently assign real runtime state to the legacy web profile.
 * `source: 'fallback'` identifies the old web/test compatibility path.
 * This function performs no filesystem operations or migration.
 */
export function resolveStorePath(ctx, env = process.env) {
  const profileDir = typeof ctx?.get === 'function'
    ? ctx.get('profileContext')?.dir : undefined;
  let directory;
  let source;
  if (nonempty(profileDir)) {
    directory = join(profileDir, STORE_SUBDIRECTORY);
    source = 'profileContext';
  } else if (nonempty(env?.DSH_PROFILE_DIR)) {
    directory = join(env.DSH_PROFILE_DIR, STORE_SUBDIRECTORY);
    source = 'DSH_PROFILE_DIR';
  } else if (nonempty(env?.DSH_HOME) && nonempty(env?.DSH_PROFILE)) {
    directory = join(env.DSH_HOME, 'profiles', env.DSH_PROFILE, STORE_SUBDIRECTORY);
    source = 'DSH_HOME/DSH_PROFILE';
  } else {
    directory = nonempty(env?.APPDATA)
      ? join(env.APPDATA, 'dsh-desktop', 'harness', 'profiles', 'web', STORE_SUBDIRECTORY)
      : join(homedir(), '.dsh-lead-worker');
    source = 'fallback';
  }
  return { directory, file: join(directory, STORE_FILENAME), source };
}
