import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateApiRequest } from '../src/api-security.mjs';

// No host service import, sockets, filesystem, persistence or runtime dependencies.
const request = (method = 'GET', headers = {}, extra = {}) => ({
  method, headers: { host: '127.0.0.1:43129', ...headers }, ...extra,
});
const allowed = req => assert.deepEqual(validateApiRequest(req), { ok: true, status: 200, error: null });
const rejected = (req, status) => {
  const result = validateApiRequest(req);
  assert.equal(result.ok, false);
  assert.equal(result.status, status);
  assert.equal(typeof result.error, 'string');
  assert.ok(result.error.length > 0);
};

describe('API same-origin guard (isolated mock requests)', () => {
  it('allows exactly GET, POST and OPTIONS; method errors use 405', () => {
    for (const method of ['GET', 'POST', 'OPTIONS']) allowed(request(method));
    for (const method of ['PUT', 'PATCH', 'DELETE', 'HEAD', 'TRACE', 'CONNECT', 'get', '', undefined]) {
      rejected({ method, headers: { host: 'localhost:43129' } }, 405);
    }
    rejected(undefined, 405);
  });

  it('accepts matching http and https origins with explicit ports', () => {
    for (const method of ['GET', 'POST', 'OPTIONS']) {
      for (const scheme of ['http', 'https']) {
        allowed(request(method, { origin: `${scheme}://127.0.0.1:43129`, 'sec-fetch-site': 'same-origin' }));
      }
    }
    allowed(request('POST', { host: 'LOCALHOST:43129', origin: 'https://localhost:43129' }));
    allowed(request('GET', { host: '[::1]:43129', origin: 'http://[::1]:43129' }));
    allowed(request('GET', { host: '[::1]:43129', origin: 'https://[0:0:0:0:0:0:0:1]:43129' }));
  });

  it('uses origin default-port semantics without ignoring non-default ports', () => {
    allowed(request('GET', { host: 'localhost:80', origin: 'http://localhost' }));
    allowed(request('GET', { host: 'localhost', origin: 'http://localhost:80' }));
    allowed(request('GET', { host: 'localhost:443', origin: 'https://localhost' }));
    allowed(request('GET', { host: 'localhost', origin: 'https://localhost:443' }));
    rejected(request('GET', { host: 'localhost:80', origin: 'https://localhost' }), 403);
    rejected(request('GET', { origin: 'http://127.0.0.1' }), 403);
    rejected(request('GET', { origin: 'http://127.0.0.1:43130' }), 403);
  });

  it('rejects opaque, malformed and non-origin URL values instead of repairing them', () => {
    const origins = [
      'null', '', 'undefined', 'file://127.0.0.1:43129', 'ftp://127.0.0.1:43129',
      '//127.0.0.1:43129', 'http:127.0.0.1:43129', 'http:///127.0.0.1:43129',
      'http://127.0.0.1:43129/', 'http://127.0.0.1:43129/path',
      'http://127.0.0.1:43129?query', 'http://127.0.0.1:43129#hash',
      'http://user@127.0.0.1:43129', 'http://user:pass@127.0.0.1:43129',
      'http://%31%32%37.0.0.1:43129', 'http://127.0.0.1:43129\\evil',
      'http://127.0.0.1:65536', 'http://[::1', 'http://127.0.0.1:',
      ' http://127.0.0.1:43129', 'http://127.0.0.1:43129\r\n',
      'http://127.0.0.1:43129 http://evil.example', 'http://127.0.0.1:43129,http://evil.example',
    ];
    for (const origin of origins) rejected(request('POST', { origin }), 403);
  });

  it('rejects foreign authorities, including same-site and loopback aliases', () => {
    for (const origin of [
      'https://evil.example', 'http://127.0.0.1.evil.example:43129',
      'http://localhost:43129', 'http://[::1]:43129', 'http://127.0.0.2:43129',
    ]) rejected(request('POST', { origin, 'sec-fetch-site': 'same-origin' }), 403);
    rejected(request('POST', {
      host: 'api.example.test:43129', origin: 'https://www.example.test:43129', 'sec-fetch-site': 'same-site',
    }), 403);
  });

  it('rejects cross-site metadata for every supported method even with matching Origin', () => {
    for (const method of ['GET', 'POST', 'OPTIONS']) {
      rejected(request(method, { 'sec-fetch-site': 'cross-site' }), 403);
      rejected(request(method, { 'sec-fetch-site': 'cross-site', origin: 'http://127.0.0.1:43129' }), 403);
    }
  });

  it('permits unauthenticated non-browser POST only when both browser signals are absent', () => {
    allowed(request('POST'));
    for (const site of ['same-origin', 'same-site', 'none']) {
      rejected(request('POST', { 'sec-fetch-site': site }), 403);
      allowed(request('POST', { 'sec-fetch-site': site, origin: 'http://127.0.0.1:43129' }));
      allowed(request('GET', { 'sec-fetch-site': site }));
      allowed(request('OPTIONS', { 'sec-fetch-site': site }));
    }
    rejected(request('POST', { origin: '' }), 403);
    for (const site of ['', 'SAME-ORIGIN', 'unknown', 'same-origin, cross-site', 'same-origin\n']) {
      rejected(request('GET', { 'sec-fetch-site': site }), 403);
    }
  });

  it('requires a single well-formed direct Host, even for non-browser requests', () => {
    for (const host of [
      undefined, null, '', [], ['127.0.0.1:43129'], 'localhost:65536',
      'http://localhost:43129', 'localhost:43129/path', 'localhost:43129?x',
      'evil@localhost:43129', 'localhost:43129#x', 'localhost:',
      'localhost:43129\\evil', 'localhost:43129,evil', ' localhost:43129',
      'localhost:43129\r\nX-Test: yes', '::1:43129', '[::1',
    ]) rejected(request('POST', { host }), 400);
    rejected({ method: 'GET', headers: {} }, 400);
    rejected(request('GET', { Host: 'evil.example' }), 400);
    allowed({ method: 'GET', headers: { Host: 'localhost:43129', Origin: 'http://localhost:43129' } });
  });

  it('rejects array/duplicate Origin and Fetch Metadata headers', () => {
    for (const origin of [[], ['http://127.0.0.1:43129'], null, 123]) {
      rejected(request('GET', { origin }), 403);
    }
    rejected(request('GET', { origin: 'http://127.0.0.1:43129', Origin: 'http://evil.example' }), 403);
    rejected(request('GET', { 'sec-fetch-site': ['same-origin'] }), 403);
    for (const header of ['Host', 'Origin', 'Sec-Fetch-Site']) {
      const headers = { origin: 'http://127.0.0.1:43129', 'sec-fetch-site': 'same-origin' };
      rejected(request('GET', headers, { rawHeaders: [header, 'a', header.toLowerCase(), 'b'] }),
        header === 'Host' ? 400 : 403);
    }
  });

  it('never trusts forwarded authority or protocol over direct Host', () => {
    rejected(request('POST', {
      origin: 'https://evil.example', 'x-forwarded-host': 'evil.example',
      'x-forwarded-proto': 'https', forwarded: 'host=evil.example;proto=https',
    }), 403);
    allowed(request('POST', {
      origin: 'http://127.0.0.1:43129', 'x-forwarded-host': 'evil.example',
      'x-forwarded-proto': 'ftp', forwarded: 'host=evil.example;proto=ftp',
    }));
    rejected({ method: 'POST', headers: { 'x-forwarded-host': 'localhost:43129' } }, 400);
  });

  it('documents the non-authentication boundary: matching forged Host/Origin still passes', () => {
    // There is deliberately no claim that arbitrary Host values prove locality.
    allowed(request('POST', { host: 'attacker.example:8123', origin: 'https://attacker.example:8123' }));
    allowed(request('POST', { host: 'attacker.example:8123' }));
  });

  it('does not mutate requests or inspect paths, sockets, bodies or debug routes', () => {
    const req = Object.freeze({
      method: 'POST', headers: Object.freeze({ host: 'localhost:43129', origin: 'https://localhost:43129' }),
      get url() { throw new Error('route access'); },
      get socket() { throw new Error('socket access'); },
      get body() { throw new Error('body access'); },
    });
    allowed(req);
  });
});
