import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadHostModule } from '../src/host-runtime.mjs';

test('host dependency fallback resolves an arbitrary installation anchor with spaces', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'boss host resolver '));
  try {
    const dep = join(dir, 'node_modules', 'boss-resolver-fixture');
    mkdirSync(dep, { recursive: true });
    writeFileSync(join(dep, 'package.json'), JSON.stringify({ name: 'boss-resolver-fixture', exports: { import: './index.mjs', require: './index.cjs' } }));
    writeFileSync(join(dep, 'index.cjs'), 'module.exports = { marker: 42 };');
    const mod = await loadHostModule('boss-resolver-fixture', join(dir, 'bin.js'));
    assert.equal(mod.default.marker, 42);
    await assert.rejects(loadHostModule('boss-resolver-fixture', join(dir, 'unknown.js')), /Missing DSH host dependency/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('missing dependency reports an actionable error instead of silently mocking runtime', async () => {
  await assert.rejects(loadHostModule('boss-does-not-exist', undefined), /Missing DSH host dependency/);
});
