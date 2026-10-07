import { createRequire } from 'node:module';
import { isAbsolute, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

export const isolatedTestRuntime = process.env.NODE_TEST_CONTEXT !== undefined || process.env.DSH_BOSS_WORKER_TEST_RUNTIME === '1';

// Prefer host loader resolution. An installed DSH entry can anchor an external
// workspace plugin without assuming a drive, installation folder or exports.
export async function loadHostModule(specifier, entry = process.argv.slice(1).find(value => isAbsolute(value) && basename(value) === 'bin.js')) {
  try { return await import(specifier); }
  catch (original) {
    if (entry && isAbsolute(entry) && basename(entry) === 'bin.js') {
      try {
        const resolved = createRequire(pathToFileURL(entry)).resolve(specifier);
        return await import(pathToFileURL(resolved).href);
      } catch { /* report the original dependency failure below */ }
    }
    throw new Error(`Missing DSH host dependency ${specifier}; load this plugin through the running DSH installation. ${original.message}`, { cause: original });
  }
}
