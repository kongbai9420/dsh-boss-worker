const ALLOWED_METHODS = new Set(['GET', 'POST', 'OPTIONS']);
const FETCH_SITES = new Set(['same-origin', 'same-site', 'none', 'cross-site']);

const denied = (status, error) => ({ ok: false, status, error });

// IncomingMessage headers are lower-case; also handle case-insensitive mock keys.
// Multiple values are never safe for these security-sensitive singleton headers.
function readHeader(req, name) {
  const entries = Object.entries(req?.headers || {}).filter(([key]) => key.toLowerCase() === name);
  const rawCount = Array.isArray(req?.rawHeaders)
    ? req.rawHeaders.filter((_, index) => index % 2 === 0 && String(req.rawHeaders[index]).toLowerCase() === name).length
    : 0;
  if (entries.length > 1 || rawCount > 1) return { invalid: true };
  if (!entries.length) return { present: false };
  const value = entries[0][1];
  if (typeof value !== 'string' || !value || /[\s,]/u.test(value)) return { invalid: true };
  return { present: true, value };
}

// Reject URL parser repairs (credentials, backslashes, paths, escaped hosts, etc.).
// Host is an authority, not an arbitrary URL. IPv6 must retain its brackets.
function parseAuthority(authority, protocol) {
  if (!/^(?:[a-z0-9.-]+|\[[a-f0-9:.]+\])(?::[0-9]+)?$/i.test(authority)) return null;
  try {
    const url = new URL(`${protocol}//${authority}`);
    if (!url.hostname || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * Pure HTTP API browser same-origin guard; does not read bodies or mutate req.
 *
 * SECURITY BOUNDARY: This is CSRF/browser-origin protection, NOT authentication.
 * Host, Origin and Fetch Metadata are client-controlled outside a browser. In
 * particular, POST with neither Origin nor Sec-Fetch-Site intentionally permits
 * non-browser local tools, without authenticating them or proving locality.
 * The host must separately restrict listening/access/authentication as needed;
 * this check alone cannot stop forged headers or DNS rebinding. Never substitute
 * X-Forwarded-Host/Proto (or Forwarded) without a separate trusted-proxy policy.
 *
 * Both http and https origins are permitted against the direct Host authority,
 * independent of req.socket/proxy protocol. Explicit ports are significant;
 * protocol-default ports are normalized using URL origin semantics.
 * Debug-route removal and method-to-route restrictions remain host concerns.
 */
export function validateApiRequest(req) {
  if (!ALLOWED_METHODS.has(req?.method)) return denied(405, 'Method not allowed');

  const host = readHeader(req, 'host');
  if (!host.present || host.invalid || !parseAuthority(host.value, 'http:')) {
    return denied(400, 'Invalid Host header');
  }

  const site = readHeader(req, 'sec-fetch-site');
  if (site.invalid || (site.present && !FETCH_SITES.has(site.value))) {
    return denied(403, 'Invalid Sec-Fetch-Site header');
  }
  if (site.value === 'cross-site') return denied(403, 'Cross-site request denied');

  const origin = readHeader(req, 'origin');
  if (origin.invalid) return denied(403, 'Invalid Origin header');
  if (origin.present) {
    const match = /^(https?):\/\/(.+)$/i.exec(origin.value);
    const source = match && parseAuthority(match[2], `${match[1].toLowerCase()}:`);
    if (!source) return denied(403, 'Invalid Origin header');
    const target = parseAuthority(host.value, source.protocol);
    if (!target || source.origin !== target.origin) return denied(403, 'Origin does not match Host');
  } else if (req.method === 'POST' && site.present) {
    // Browser-associated writes require Origin, even when metadata says same-site.
    return denied(403, 'Origin required for browser POST');
  }

  return { ok: true, status: 200, error: null };
}
