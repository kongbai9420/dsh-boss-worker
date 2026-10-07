import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolveStorePath } from '../src/profile-storage.mjs';

// Synthetic paths only. No mkdir, reads, writes, copies, or migrations.
const root = join(homedir(), '__profile_storage_test_not_created__');
const profile = name => join(root, 'profiles', name);
const context = dir => ({ get(key) {
  assert.equal(key, 'profileContext');
  return { dir };
} });
const expected = (base, source) => {
  const directory = join(base, 'dsh-lead-worker');
  return { directory, file: join(directory, 'session-configs.json'), source };
};

describe('resolveStorePath (path resolution only)', () => {
  it('isolates two context profile directories and overrides every env hint', () => {
    const env = { DSH_PROFILE_DIR: profile('env'), DSH_HOME: root, DSH_PROFILE: 'named', APPDATA: join(root, 'appdata') };
    const first = resolveStorePath(context(profile('first')), env);
    const second = resolveStorePath(context(profile('second')), env);
    assert.deepEqual(first, expected(profile('first'), 'profileContext'));
    assert.deepEqual(second, expected(profile('second'), 'profileContext'));
    assert.notEqual(first.directory, second.directory);
    assert.notEqual(first.file, second.file);
  });

  it('prefers DSH_PROFILE_DIR over home/name and APPDATA', () => {
    const env = { DSH_PROFILE_DIR: profile('explicit'), DSH_HOME: root, DSH_PROFILE: 'named', APPDATA: join(root, 'appdata') };
    assert.deepEqual(resolveStorePath(undefined, env), expected(profile('explicit'), 'DSH_PROFILE_DIR'));
    assert.deepEqual(resolveStorePath({ get: () => undefined }, env), expected(profile('explicit'), 'DSH_PROFILE_DIR'));
  });

  it('resolves an explicit DSH_HOME and DSH_PROFILE before the legacy web path', () => {
    assert.deepEqual(resolveStorePath({}, { DSH_HOME: root, DSH_PROFILE: 'custom', APPDATA: join(root, 'appdata') }),
      expected(profile('custom'), 'DSH_HOME/DSH_PROFILE'));
    assert.deepEqual(resolveStorePath(null, { DSH_HOME: root, DSH_PROFILE: 'web' }),
      expected(profile('web'), 'DSH_HOME/DSH_PROFILE'));
  });

  it('treats empty, whitespace, null and non-string paths as absent', () => {
    for (const blank of ['', '   ', '\t\n', undefined, null, 0, false, {}]) {
      assert.deepEqual(resolveStorePath(context(blank), { DSH_PROFILE_DIR: profile('env') }),
        expected(profile('env'), 'DSH_PROFILE_DIR'));
      assert.deepEqual(resolveStorePath(undefined, { DSH_PROFILE_DIR: blank, DSH_HOME: root, DSH_PROFILE: 'named' }),
        expected(profile('named'), 'DSH_HOME/DSH_PROFILE'));
      for (const env of [{ DSH_HOME: blank, DSH_PROFILE: 'named' }, { DSH_HOME: root, DSH_PROFILE: blank }]) {
        assert.deepEqual(resolveStorePath(undefined, env), {
          directory: join(homedir(), '.dsh-lead-worker'),
          file: join(homedir(), '.dsh-lead-worker', 'session-configs.json'), source: 'fallback',
        });
      }
    }
  });

  it('preserves valid path whitespace rather than rewriting real profile names', () => {
    const spaced = join(root, ' profile with spaces ');
    assert.deepEqual(resolveStorePath(context(spaced), {}), expected(spaced, 'profileContext'));
  });

  it('keeps the exact APPDATA web legacy path and marks it as fallback', () => {
    const appdata = join(root, 'appdata');
    assert.deepEqual(resolveStorePath(undefined, { APPDATA: appdata }),
      expected(join(appdata, 'dsh-desktop', 'harness', 'profiles', 'web'), 'fallback'));
  });

  it('does not invent a profile from only one explicit home/name hint', () => {
    const appdata = join(root, 'appdata');
    const legacy = expected(join(appdata, 'dsh-desktop', 'harness', 'profiles', 'web'), 'fallback');
    assert.deepEqual(resolveStorePath(undefined, { DSH_HOME: root, APPDATA: appdata }), legacy);
    assert.deepEqual(resolveStorePath(undefined, { DSH_PROFILE: 'custom', APPDATA: appdata }), legacy);
  });

  it('falls back to homedir without a usable APPDATA and tolerates missing ctx/env', () => {
    const fallback = { directory: join(homedir(), '.dsh-lead-worker'),
      file: join(homedir(), '.dsh-lead-worker', 'session-configs.json'), source: 'fallback' };
    for (const appdata of [undefined, '', ' ', null]) {
      assert.deepEqual(resolveStorePath(undefined, { APPDATA: appdata }), fallback);
    }
    assert.deepEqual(resolveStorePath(null, null), fallback);
    assert.deepEqual(resolveStorePath({ get: null }, {}), fallback);
  });

  it('defaults env to process.env while keeping real profile context authoritative', () => {
    assert.deepEqual(resolveStorePath(context(profile('ctx'))), expected(profile('ctx'), 'profileContext'));
  });
});
