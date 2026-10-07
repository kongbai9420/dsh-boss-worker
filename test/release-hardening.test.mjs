import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { LeadWorkerHostService } from '../src/host.mjs';
import { isolatedTestRuntime } from '../src/host-runtime.mjs';
import { resolveStorePath } from '../src/profile-storage.mjs';

// Context profiles are the primary isolation boundary. Environment hints are
// conflicting, temporary tripwires as well, so a regression cannot touch the
// developer's inherited APPDATA or a live DSH profile.
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'boss-release-hardening-'));
  const hints = {
    APPDATA: join(root, 'forbidden-appdata'),
    DSH_PROFILE_DIR: join(root, 'forbidden-env-profile'),
    DSH_HOME: join(root, 'forbidden-env-home'),
    DSH_PROFILE: 'inherited-profile',
  };
  const inherited = Object.fromEntries(Object.keys(hints).map(key => [key, process.env[key]]));
  Object.assign(process.env, hints);
  t.after(() => {
    try {
      for (const directory of [hints.APPDATA, hints.DSH_PROFILE_DIR, hints.DSH_HOME]) {
        assert.equal(existsSync(directory), false, `host wrote outside its context profile: ${directory}`);
      }
    } finally {
      for (const [key, value] of Object.entries(inherited)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
  return {
    root,
    hints,
    create(name) {
      const ctx = mockContext(join(root, name));
      const service = new LeadWorkerHostService(ctx, {});
      const routes = ctx.webServer.routes;
      assert.equal(routes.length, 1);
      assert.equal(routes[0].kind, 'prefixes');
      assert.equal(routes[0].path, '/api/lead-worker');
      assert.equal(typeof routes[0].handler, 'function');
      return { ctx, service, handler: routes[0].handler, store: resolveStorePath(ctx) };
    },
  };
}

function mockContext(dir) {
  return {
    profileContext: { dir },
    logger: { info() {}, warn() {}, error() {} },
    tools: { guard() {}, register() {} },
    userQuestions: { ask: async () => ({ answers: [] }) },
    systemPrompt: { section() {} },
    webServer: { routes: [], register(route) { this.routes.push(route); } },
    inject(_keys, callback) { callback(this); },
    get(name) { return this[name]; },
  };
}

const authority = '127.0.0.1:43129';
const sameOriginHeaders = {
  host: authority,
  origin: `http://${authority}`,
  'sec-fetch-site': 'same-origin',
};

async function request(handler, { method = 'POST', path = '/api/lead-worker/action', headers = sameOriginHeaders, body = {} } = {}) {
  const req = Readable.from([JSON.stringify(body)]);
  Object.assign(req, { method, url: path, headers: { ...headers } });
  let bodyRead = false;
  const setEncoding = req.setEncoding.bind(req);
  req.setEncoding = encoding => { bodyRead = true; return setEncoding(encoding); };
  const res = {
    statusCode: undefined,
    headers: {},
    ended: false,
    writeHead(statusCode, responseHeaders) {
      this.statusCode = statusCode;
      this.headers = responseHeaders;
    },
    end(value = '') {
      this.ended = true;
      this.body = value ? JSON.parse(value) : null;
    },
  };
  await handler(req, res);
  assert.equal(res.ended, true, 'registered handler must finish its response');
  assert.ok(Number.isInteger(res.statusCode));
  for (const [key, value] of Object.entries(res.headers)) {
    if (key.toLowerCase().startsWith('access-control-')) {
      assert.equal(String(value).includes('*'), false, `${key} must not expose wildcard CORS`);
    }
  }
  return { ...res, bodyRead };
}

const view = handler => request(handler, {
  method: 'GET', path: '/api/lead-worker/view?sessionId=shared-session',
});
const configure = (handler, config, expectedConfigRevision) => request(handler, {
  body: { sessionId: 'shared-session', action: 'configure', config, expectedConfigRevision },
});

function successful(response, status = 200) {
  assert.equal(response.statusCode, status);
  assert.equal(response.body.ok, true);
}

test('release hardening: registered host handler rejects cross-origin POST without reading or mutating', async t => {
  assert.equal(isolatedTestRuntime, true, 'node --test permits the isolated host dependency mocks');
  const { handler, store } = fixture(t).create('security-profile');
  const initial = await view(handler);
  successful(initial);
  const before = readFileSync(store.file, 'utf8');
  for (const metadata of ['same-origin', 'cross-site']) {
    const denied = await request(handler, {
      headers: { ...sameOriginHeaders, origin: 'https://attacker.example', 'sec-fetch-site': metadata },
      body: {
        sessionId: 'shared-session', action: 'configure',
        config: { ...initial.body.config, maxParallel: 1 },
        expectedConfigRevision: initial.body.configRevision,
      },
    });
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.body.ok, false);
    assert.equal(denied.bodyRead, false, 'origin guard must run before parsing the POST body');
    assert.equal(readFileSync(store.file, 'utf8'), before);
  }
  const accepted = await configure(handler, { ...initial.body.config, maxParallel: 2 }, initial.body.configRevision);
  successful(accepted);
  assert.equal(accepted.bodyRead, true);
  assert.equal(accepted.body.result.config.maxParallel, 2);
  assert.equal(accepted.body.result.configRevision, initial.body.configRevision + 1);
  const current = await view(handler);
  successful(current);
  assert.equal(current.body.config.maxParallel, 2);
});

test('release hardening: removed debug route returns 404 and host responses never advertise wildcard CORS', async t => {
  const { handler } = fixture(t).create('routes-profile');
  for (const method of ['GET', 'POST']) {
    const response = await request(handler, { method, path: '/api/lead-worker/debug-sessions' });
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.body, { ok: false, error: 'Not found' });
    assert.equal(response.bodyRead, false);
  }
  const options = await request(handler, { method: 'OPTIONS' });
  assert.equal(options.statusCode, 204);
  assert.equal(options.body, null);
  assert.equal(options.bodyRead, false);
  const rejectedOptions = await request(handler, {
    method: 'OPTIONS', headers: { ...sameOriginHeaders, origin: 'https://attacker.example' },
  });
  assert.equal(rejectedOptions.statusCode, 403);
  successful(await view(handler));
});

test('release hardening: stale expectedConfigRevision rejects configure and leaves memory, board and disk unchanged', async t => {
  const { handler, service, store } = fixture(t).create('revision-profile');
  const initial = await view(handler);
  successful(initial);
  const first = await configure(handler, { ...initial.body.config, maxParallel: 2 }, initial.body.configRevision);
  successful(first);
  const latest = await view(handler);
  successful(latest);
  const before = readFileSync(store.file, 'utf8');
  const staleConfig = { ...latest.body.config, enabled: false, maxParallel: 1, members: [] };
  // HTTP errors currently use 500: assert rejection, not a not-yet-promised 409 contract.
  const rejected = await configure(handler, staleConfig, initial.body.configRevision);
  assert.equal(rejected.statusCode, 500);
  assert.equal(rejected.body.ok, false);
  assert.match(rejected.body.error, /配置已被其他入口更新/);
  assert.deepEqual(service.getConfig('shared-session'), latest.body.config);
  assert.deepEqual(service.getOrCreateBoard('shared-session').snapshot(), latest.body.board);
  assert.equal(readFileSync(store.file, 'utf8'), before);
  const after = await view(handler);
  successful(after);
  assert.deepEqual(after.body.config, latest.body.config);
  assert.deepEqual(after.body.board, latest.body.board);
  assert.equal(after.body.configRevision, latest.body.configRevision);
  assert.equal(readFileSync(store.file, 'utf8'), before);
});

test('release hardening: context profiles override inherited env, persist independently and survive both restarts', async t => {
  const f = fixture(t);
  const first = f.create('profile-a');
  const second = f.create('profile-b');
  for (const instance of [first, second]) {
    assert.equal(instance.store.source, 'profileContext');
    assert.equal(instance.store.file, join(instance.ctx.profileContext.dir, 'dsh-lead-worker', 'session-configs.json'));
  }
  assert.notEqual(first.store.file, second.store.file);
  const initialA = await view(first.handler);
  const initialB = await view(second.handler);
  successful(initialA);
  successful(initialB);
  successful(await configure(first.handler, { ...initialA.body.config, maxParallel: 2, leadPrompt: 'profile A only' }, initialA.body.configRevision));
  const savedA = readFileSync(first.store.file, 'utf8');
  // Updating the very same session ID in B must neither overwrite nor merge A.
  successful(await configure(second.handler, { ...initialB.body.config, maxParallel: 3, leadPrompt: 'profile B only' }, initialB.body.configRevision));
  assert.equal(readFileSync(first.store.file, 'utf8'), savedA);
  const savedB = readFileSync(second.store.file, 'utf8');
  assert.notEqual(savedA, savedB);
  const restartedA = f.create('profile-a');
  const restartedB = f.create('profile-b');
  const restoredA = await view(restartedA.handler);
  const restoredB = await view(restartedB.handler);
  successful(restoredA);
  successful(restoredB);
  assert.equal(restoredA.body.config.maxParallel, 2);
  assert.equal(restoredA.body.config.leadPrompt, 'profile A only');
  assert.equal(restoredB.body.config.maxParallel, 3);
  assert.equal(restoredB.body.config.leadPrompt, 'profile B only');
  assert.equal(restoredA.body.configRevision, initialA.body.configRevision + 1);
  assert.equal(restoredB.body.configRevision, initialB.body.configRevision + 1);
  assert.equal(readFileSync(first.store.file, 'utf8'), savedA);
  assert.equal(readFileSync(second.store.file, 'utf8'), savedB);
  for (const directory of [f.hints.APPDATA, f.hints.DSH_PROFILE_DIR, f.hints.DSH_HOME]) {
    assert.equal(existsSync(directory), false, 'context storage must not create any inherited-env storage');
  }
});
