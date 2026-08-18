/**
 * Standalone tests for the server SDK — mirrors the PHP suites
 * (tests/test-token-manager.php, tests/test-grnd-acquisition.php).
 * Zero dependencies: `node npm/test-server.mjs`. Exits non-zero on failure.
 */

import {
    WapError,
    sanityCheckGrnd,
    MemoryStorage,
    TokenManager,
    createIssuerProvider,
    WapGrndClient,
} from './server.mjs';

let passed = 0;
let failed = 0;

function ok(cond, label) {
    if (cond) {
        passed++;
    } else {
        failed++;
        console.error('FAIL: ' + label);
    }
}

async function rejectsWithCode(promise, code, label) {
    try {
        await promise;
        ok(false, label + ' (did not throw)');
    } catch (e) {
        ok(e instanceof WapError && e.code === code, label + ` (got ${e.code || e.message})`);
    }
}

function b64url(obj) {
    return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function makeGrnd({ alg = 'EdDSA', jti = 'grn:2@int:grnd::wap/abc123', exp = Math.floor(Date.now() / 1000) + 3600, extra = {} } = {}) {
    return b64url({ alg, typ: 'JWT' }) + '.' + b64url({ jti, exp, ...extra }) + '.sig';
}

/** Minimal fetch mock: queue of responses, log of requests. */
function mockFetch(queue) {
    const log = [];
    const fn = async (url, init = {}) => {
        log.push({ url, init });
        const next = queue.shift();
        if (!next) throw new Error('mockFetch: queue empty for ' + url);
        return new Response(
            typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? {}),
            { status: next.status ?? 200, headers: { 'Content-Type': 'application/json' } }
        );
    };
    fn.log = log;
    return fn;
}

// ---------------------------------------------------------------------------
// sanityCheckGrnd
// ---------------------------------------------------------------------------

ok(sanityCheckGrnd(makeGrnd()).jti.startsWith('grn:2@int:grnd'), 'sanity: valid GRND passes');
ok(sanityCheckGrnd(makeGrnd({ jti: 'grn:2@int:grnd:eu.prod-1:wap/xyz' })).exp > 0, 'sanity: realm jti passes');

for (const [grnd, code, label] of [
    ['not-a-jwt', 'wap_grnd_malformed', 'sanity: non-JWT rejected'],
    ['a.b', 'wap_grnd_malformed', 'sanity: two-part rejected'],
    ['%%%.' + b64url({ jti: 'x', exp: 1 }) + '.s', 'wap_grnd_malformed', 'sanity: bad base64 header rejected'],
    [makeGrnd({ alg: 'RS256' }), 'wap_grnd_bad_alg', 'sanity: RS256 rejected'],
    [makeGrnd({ alg: 'none' }), 'wap_grnd_bad_alg', 'sanity: alg none rejected'],
    [makeGrnd({ jti: 'grn:1@int:grnd::wap/x' }), 'wap_grnd_bad_jti', 'sanity: wrong GRN version rejected'],
    [makeGrnd({ jti: 'grn:2@int:grnd::other/x' }), 'wap_grnd_bad_jti', 'sanity: non-wap designation rejected'],
    [makeGrnd({ jti: 'grn:2@int:grnd::wap/' + 'x'.repeat(300) }), 'wap_grnd_bad_jti', 'sanity: overlong jti rejected'],
    [makeGrnd({ jti: '' }), 'wap_grnd_bad_jti', 'sanity: missing jti rejected'],
    [makeGrnd({ exp: 0 }), 'wap_grnd_missing_exp', 'sanity: zero exp rejected'],
    [b64url({ alg: 'EdDSA', typ: 'JWT' }) + '.' + b64url({ jti: 'grn:2@int:grnd::wap/x' }) + '.s', 'wap_grnd_missing_exp', 'sanity: absent exp rejected'],
    [b64url({ alg: 'EdDSA' }) + '.' + b64url({ jti: 'grn:2@int:grnd::wap/x', exp: 1 }) + '.s', 'wap_grnd_malformed', 'sanity: missing typ rejected'],
]) {
    try {
        sanityCheckGrnd(grnd);
        ok(false, label + ' (did not throw)');
    } catch (e) {
        ok(e instanceof WapError && e.code === code, label + ` (got ${e.code || e.message})`);
    }
}

// ---------------------------------------------------------------------------
// TokenManager
// ---------------------------------------------------------------------------

{
    // Caches on first acquire; second get() does not hit the provider.
    let calls = 0;
    const grnd = makeGrnd();
    const tm = new TokenManager({ provider: () => { calls++; return grnd; } });
    ok(await tm.get({ cacheKey: 'u1' }) === grnd, 'tm: returns provider token');
    ok(await tm.get({ cacheKey: 'u1' }) === grnd && calls === 1, 'tm: second get served from cache');

    // forceNew bypasses and refreshes the cache.
    await tm.get({ cacheKey: 'u1', forceNew: true });
    ok(calls === 2, 'tm: forceNew re-acquires');

    // forget() drops the cache.
    await tm.forget('u1');
    await tm.get({ cacheKey: 'u1' });
    ok(calls === 3, 'tm: forget drops cache');

    // Cache keys are isolated per user.
    await tm.get({ cacheKey: 'u2' });
    ok(calls === 4, 'tm: distinct cacheKey acquires separately');
}

{
    // Issuer expires_at earlier than jwt exp caps the TTL (observable via storage.set).
    let ttlSeen = null;
    const storage = new MemoryStorage();
    const origSet = storage.set.bind(storage);
    storage.set = (k, v, ttl) => { ttlSeen = ttl; origSet(k, v, ttl); };
    const now = Math.floor(Date.now() / 1000);
    const tm = new TokenManager({
        storage,
        provider: () => ({ grnd: makeGrnd({ exp: now + 3600 }), expires_at: now + 600 }),
    });
    await tm.get();
    ok(ttlSeen !== null && ttlSeen <= 600 - 60 && ttlSeen > 500, `tm: TTL capped by issuer expires_at − slack (got ${ttlSeen})`);

    // Expired token from provider fails loudly.
    const tmExpired = new TokenManager({ provider: () => makeGrnd({ exp: now - 10 }) });
    await rejectsWithCode(tmExpired.get(), 'wap_grnd_expired', 'tm: already-expired token rejected');

    // Insane token from provider is rejected, never cached.
    const tmBad = new TokenManager({ provider: () => makeGrnd({ alg: 'RS256' }) });
    await rejectsWithCode(tmBad.get(), 'wap_grnd_bad_alg', 'tm: insane provider token rejected');

    // Empty provider result.
    const tmEmpty = new TokenManager({ provider: () => null });
    await rejectsWithCode(tmEmpty.get(), 'wap_grnd_unavailable', 'tm: empty provider result rejected');

    // Corrupt cache entry is dropped and re-acquired.
    const storage2 = new MemoryStorage();
    let calls2 = 0;
    const tm2 = new TokenManager({ storage: storage2, provider: () => { calls2++; return makeGrnd(); } });
    await tm2.get({ cacheKey: 'u' });
    for (const key of storage2._map.keys()) storage2.set(key, 'garbage-token', 300);
    await tm2.get({ cacheKey: 'u' });
    ok(calls2 === 2, 'tm: corrupt cached token dropped and re-acquired');
}

// ---------------------------------------------------------------------------
// createIssuerProvider
// ---------------------------------------------------------------------------

{
    const grnd = makeGrnd();
    const fetchImpl = mockFetch([{ body: { grnd, expires_at: 123 } }]);
    let credCalls = 0;
    const provider = createIssuerProvider({
        issuerUrl: 'https://brand.example/grnd',
        licenseKey: 'LK-1',
        product: 'p1',
        siteUrl: 'https://site.example',
        credentials: () => { credCalls++; return { wrapped_app_token: 'sealed', wrap_key_id: 'k1' }; },
        fetchImpl,
    });
    const result = await provider({ cacheKey: 'u', forceNew: false });
    ok(result.grnd === grnd && result.expires_at === 123, 'issuer: returns grnd + expires_at');
    const sent = JSON.parse(fetchImpl.log[0].init.body);
    ok(sent.license_key === 'LK-1' && sent.product === 'p1' && sent.wrapped_app_token === 'sealed' && sent.wrap_key_id === 'k1',
        'issuer: payload carries license + credential fields');
    ok(credCalls === 1, 'issuer: credentials factory invoked lazily once');

    await rejectsWithCode(
        createIssuerProvider({ issuerUrl: 'https://b.e/g', product: 'p', siteUrl: 's', fetchImpl: mockFetch([{ status: 403, body: {} }]) })({}),
        'wap_grnd_not_entitled', 'issuer: 403 → wap_grnd_not_entitled');
    await rejectsWithCode(
        createIssuerProvider({ issuerUrl: 'https://b.e/g', product: 'p', siteUrl: 's', fetchImpl: mockFetch([{ status: 500, body: {} }]) })({}),
        'wap_grnd_unavailable', 'issuer: 500 → wap_grnd_unavailable');
    await rejectsWithCode(
        createIssuerProvider({ issuerUrl: 'https://b.e/g', product: 'p', siteUrl: 's', fetchImpl: mockFetch([{ body: { nope: 1 } }]) })({}),
        'wap_grnd_unavailable', 'issuer: missing grnd field → wap_grnd_unavailable');
}

// ---------------------------------------------------------------------------
// Session endpoint flow — the widget's getSession contract end-to-end:
// the token handed to the browser IS the GRND, and a WAP 401 heals via
// getSession({forceNew: true}) minting a fresh one.
// ---------------------------------------------------------------------------

{
    let issued = 0;
    const tokens = new TokenManager({
        provider: () => { issued++; return makeGrnd({ jti: `grn:2@int:grnd::wap/nonce-${issued}` }); },
    });

    // What the brand's POST /api/wap/session route does:
    const sessionEndpoint = async (userId, forceNew) => ({
        token: await tokens.get({ cacheKey: String(userId), forceNew: !!forceNew }),
    });

    const first = await sessionEndpoint('user-1', false);
    ok(sanityCheckGrnd(first.token).jti.endsWith('nonce-1'), 'endpoint: browser receives the GRND itself');

    const again = await sessionEndpoint('user-1', false);
    ok(again.token === first.token && issued === 1, 'endpoint: repeat call reuses cached GRND');

    // Widget got a 401 from WAP (expired/revoked GRND) → retries with forceNew.
    const healed = await sessionEndpoint('user-1', true);
    ok(healed.token !== first.token && sanityCheckGrnd(healed.token).jti.endsWith('nonce-2'),
        'endpoint: forceNew after WAP 401 mints a fresh GRND');

    const other = await sessionEndpoint('user-2', false);
    ok(other.token !== healed.token && issued === 3, 'endpoint: users never share a GRND');
}

// ---------------------------------------------------------------------------
// WapGrndClient — the facade
// ---------------------------------------------------------------------------

{
    // Custom provider path: getGrnd returns the provider's GRND, cached per user.
    let issued = 0;
    const wap = new WapGrndClient({
        product: 'partners-one',
        provider: () => { issued++; return makeGrnd({ jti: `grn:2@int:grnd::wap/f-${issued}` }); },
    });
    const t1 = await wap.getGrnd({ userKey: 'u1' });
    const t2 = await wap.getGrnd({ userKey: 'u1' });
    ok(t1 === t2 && issued === 1, 'facade: getGrnd caches per user');

    const t3 = await wap.getGrnd({ userKey: 'u1', forceNew: true });
    ok(t3 !== t1 && issued === 2, 'facade: forceNew mints fresh');

    await wap.forget('u1');
    await wap.getGrnd({ userKey: 'u1' });
    ok(issued === 3, 'facade: forget drops the cache');

    // Two products, same storage-less default: caches never collide.
    let issuedB = 0;
    const wapB = new WapGrndClient({
        product: 'other-product',
        provider: () => { issuedB++; return makeGrnd({ jti: 'grn:2@int:grnd::wap/b-1' }); },
    });
    const tB = await wapB.getGrnd({ userKey: 'u1' });
    ok(tB !== t3 && issuedB === 1, 'facade: per-product cache namespace isolates products');

    // Issuer-exchange path: no provider → standardized contract is used.
    const grnd = makeGrnd();
    const fetchImpl = mockFetch([{ body: { grnd, expires_at: 0 } }]);
    const wapIssuer = new WapGrndClient({
        product: 'p1',
        issuerUrl: 'https://brand.example/grnd',
        siteUrl: 'https://app.example',
        licenseKey: 'LK-9',
        fetchImpl,
    });
    ok(await wapIssuer.getGrnd({ userKey: 'u9' }) === grnd, 'facade: issuer path returns the GRND');
    const sentBody = JSON.parse(fetchImpl.log[0].init.body);
    ok(sentBody.license_key === 'LK-9' && sentBody.product === 'p1' && sentBody.site_url === 'https://app.example',
        'facade: issuer path sends the standardized payload');

    // Constructor guards.
    let threw = false;
    try { new WapGrndClient({}); } catch { threw = true; }
    ok(threw, 'facade: missing product throws');
    threw = false;
    try { new WapGrndClient({ product: 'p' }); } catch { threw = true; }
    ok(threw, 'facade: no provider and no issuerUrl throws');
}

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
