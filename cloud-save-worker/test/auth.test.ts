import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { SignJWT } from 'jose';
import { createHandler, type Env } from '../src/index';
import { SESSION_COOKIE, SESSION_SECONDS } from '../src/auth';

const origin = 'https://play.ggzz.fun';
const password = randomBytes(24).toString('base64url');
const secret = { version: 1, passwordHash: createHash('sha256').update(password).digest('hex'), sessionKey: randomBytes(32).toString('base64url') };
const initialTime = Date.parse('2026-09-20T10:00:00Z');
function fixture() {
    let now = initialTime, assets = 0, reads = 0;
    const env: Env = {
        ALLOWED_ORIGIN: origin, GAME_AUTH: JSON.stringify(secret),
        GITHUB_OWNER: 'owner', GITHUB_SAVE_REPO: 'saves', GITHUB_SAVE_BRANCH: 'main', GITHUB_SAVE_TOKEN: 'test-only',
        CLOUD_SLOT_ID: '66cf8d51-2bac-4a66-a608-5f08a77ed50a',
        LOGIN_RATE_LIMITER: { limit: async () => ({ success: true }) },
        LOGIN_GLOBAL_LIMITER: { limit: async () => ({ success: true }) },
        ASSETS: { fetch: async () => { assets++; return new Response('private game asset', { headers: { 'Cache-Control': 'public, max-age=3600' } }); } },
    };
    const handler = createHandler({ now: () => now, store: () => ({
        assertAvailable: async () => { reads++; }, read: async () => { reads++; return null; },
        write: async () => { throw new Error('Unexpected write'); },
    }) });
    return { env, call: (request: Request) => handler(request, env),
        advance: (seconds: number) => { now += seconds * 1000; }, stats: () => ({ assets, reads }) };
}
function login(value = password, returnTo = '/', headers: Record<string, string> = {}) {
    return new Request(origin + '/auth/login', { method: 'POST', headers: {
        Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '192.0.2.1', ...headers,
    }, body: new URLSearchParams({ password: value, returnTo }) });
}
async function signedCookie(f: ReturnType<typeof fixture>) {
    const response = await f.call(login());
    assert.equal(response.status, 303);
    return response.headers.get('Set-Cookie')!.split(';')[0];
}

test('login gate protects the homepage, deep links, static files and APIs', async () => {
    const f = fixture();
    for (const path of ['/', '/index.html', '/scripts/script.min.js', '/images/pokemon/1.png', '/missing', '/login/']) {
        const response = await f.call(new Request(origin + path));
        assert.equal(response.status, 303, path);
        assert.ok(response.headers.get('Location')!.startsWith('/login?'));
        assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    }
    const response = await f.call(new Request(origin + '/api/cloud-save/status', { headers: { 'Cf-Access-Jwt-Assertion': 'forged-access-header' } }));
    assert.equal(response.status, 401);
    assert.equal((await response.json() as any).code, 'LOGIN_REQUIRED');
    assert.deepEqual(f.stats(), { assets: 0, reads: 0 });
    const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
    assert.equal(config.assets.run_worker_first, true);
    assert.equal(config.workers_dev, false);
    assert.equal(config.preview_urls, false);
});

test('missing or malformed password secret never exposes assets', async () => {
    for (const gameAuth of [undefined, '', '{}', '{invalid', JSON.stringify({ ...secret, sessionKey: 'short' })]) {
        const f = fixture();
        f.env.GAME_AUTH = gameAuth as string;
        for (const path of ['/', '/login', '/api/cloud-save/status']) assert.equal((await f.call(new Request(origin + path))).status, 503);
        assert.deepEqual(f.stats(), { assets: 0, reads: 0 });
    }
});

test('login HTML uses password fields, constrained CSP, and never embeds secrets', async () => {
    const f = fixture();
    const response = await f.call(new Request(origin + '/login'));
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Content-Security-Policy')!, /form-action 'self'/);
    assert.equal(response.headers.get('Referrer-Policy'), 'same-origin', 'form submissions must retain the same-origin Origin header');
    const html = await response.text();
    assert.match(html, /type="password"/);
    assert.ok(!html.includes(password) && !html.includes(secret.sessionKey) && !html.includes(secret.passwordHash));
    assert.equal((await f.call(new Request(origin + '/login', { method: 'HEAD' }))).body, null);
});

test('wrong passwords fail; correct login issues a protected cookie and a confirmation page', async () => {
    const f = fixture();
    for (const wrong of ['', 'too-short', 'X'.repeat(32)]) {
        const response = await f.call(login(wrong));
        assert.equal(response.status, 401);
        assert.equal(response.headers.get('Set-Cookie'), null);
        assert.match(await response.text(), /密码不正确/);
    }
    const response = await f.call(login());
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('Location'), '/login?returnTo=%2F');
    const cookie = response.headers.get('Set-Cookie')!;
    for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', `Max-Age=${SESSION_SECONDS}`]) assert.ok(cookie.includes(attribute));
    assert.ok(!cookie.includes(password));
    const headers = { Cookie: cookie.split(';')[0] };
    const page = await f.call(new Request(origin + response.headers.get('Location'), { headers }));
    assert.match(await page.text(), /已登录，可以继续游戏/);
    assert.deepEqual(f.stats(), { assets: 0, reads: 0 });
    const asset = await f.call(new Request(origin + '/', { headers }));
    assert.equal(await asset.text(), 'private game asset');
    assert.equal(asset.headers.get('Cache-Control'), 'private, no-store');
    assert.equal((await f.call(new Request(origin + '/api/cloud-save/status', { headers }))).status, 200);
    assert.deepEqual(f.stats(), { assets: 1, reads: 1 });
});

test('cross-site and missing-Origin login/logout requests are rejected', async () => {
    const f = fixture();
    for (const path of ['/auth/login', '/auth/logout']) {
        for (const headers of [{ Origin: 'https://evil.example' }, {}, { Origin: origin, 'Sec-Fetch-Site': 'cross-site' }] as Record<string, string>[]) {
            const request = new Request(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: 'password=x' });
            assert.equal((await f.call(request)).status, 403);
        }
        const response = await f.call(new Request(origin + path));
        assert.equal(response.status, 405);
        assert.equal(response.headers.get('Allow'), 'POST');
    }
    assert.equal((await f.call(new Request('https://other.workers.dev/login'))).status, 403);
    assert.equal((await f.call(new Request('http://play.ggzz.fun/login'))).status, 403);
});

test('login payloads have bounded size and strict content type', async () => {
    const f = fixture();
    assert.equal((await f.call(login(password, '/', { 'Content-Type': 'application/json' }))).status, 415);
    assert.equal((await f.call(login('x'.repeat(5000)))).status, 413);
    const duplicate = login();
    const response = await f.call(new Request(duplicate, { body: new URLSearchParams([['password', password], ['password', password]]) }));
    assert.equal(response.status, 401);
});

test('native rate limits are enforced before password verification, and fail closed', async () => {
    const f = fixture();
    let attempts = 0;
    f.env.LOGIN_RATE_LIMITER = { limit: async ({ key }) => { assert.equal(key, origin + ':192.0.2.1'); return { success: ++attempts <= 5 }; } };
    for (let i = 0; i < 5; i++) assert.equal((await f.call(login('bad'))).status, 401);
    const blocked = await f.call(login());
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get('Retry-After'), '60');
    assert.equal(blocked.headers.get('Set-Cookie'), null);
    f.env.LOGIN_RATE_LIMITER = { limit: async () => ({ success: true }) };
    f.env.LOGIN_GLOBAL_LIMITER = { limit: async () => ({ success: false }) };
    assert.equal((await f.call(login())).status, 429);
    f.env.LOGIN_GLOBAL_LIMITER = undefined as any;
    assert.equal((await f.call(login())).status, 503);
    f.env.LOGIN_GLOBAL_LIMITER = { limit: async () => { throw new Error('binding unavailable'); } };
    assert.equal((await f.call(login())).status, 503);
});

test('session expiry, tampering, duplicate cookies and password rotation revoke access', async () => {
    const f = fixture();
    const cookie = await signedCookie(f);
    const status = (value: string) => f.call(new Request(origin + '/api/cloud-save/status', { headers: { Cookie: value } }));
    assert.equal((await status(cookie)).status, 200);
    const [header, body, signature] = cookie.split('=')[1].split('.');
    assert.equal((await status(`${SESSION_COOKIE}=${header}.${body}.${signature[0] === 'a' ? 'b' : 'a'}${signature.slice(1)}`)).status, 401);
    assert.equal((await status(cookie + '; ' + cookie)).status, 401);
    f.advance(SESSION_SECONDS);
    assert.equal((await status(cookie)).status, 401);
    f.advance(-SESSION_SECONDS);
    f.env.GAME_AUTH = JSON.stringify({ ...secret, sessionKey: randomBytes(32).toString('base64url') });
    assert.equal((await status(cookie)).status, 401);
    assert.equal((await status(await signedCookie(f))).status, 200);
});

test('sessions are pinned to algorithm, origin, audience and maximum lifetime', async () => {
    const f = fixture();
    const now = initialTime / 1000;
    for (const change of [{ iss: 'https://other.example' }, { aud: 'other' }, { iat: now + 10 }, { exp: now + SESSION_SECONDS + 1 }, { sub: 'other' }]) {
        const token = await new SignJWT({ iss: origin, aud: 'pokeclicker-game', sub: 'player', iat: now, exp: now + SESSION_SECONDS, jti: 'test', v: 1, ...change })
            .setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode(secret.sessionKey));
        assert.equal((await f.call(new Request(origin + '/api/cloud-save/status', { headers: { Cookie: SESSION_COOKIE + '=' + token } }))).status, 401);
    }
});

test('logout clears only the browser cookie, works after expiry and rejects GET', async () => {
    const f = fixture();
    const response = await f.call(new Request(origin + '/auth/logout', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.match(response.headers.get('Set-Cookie')!, /Max-Age=0/);
    assert.deepEqual(f.stats(), { assets: 0, reads: 0 });
    const html = await f.call(new Request(origin + '/auth/logout', { method: 'POST', headers: { Origin: origin } }));
    assert.equal(html.status, 303);
    assert.equal(html.headers.get('Location'), '/login');
});

test('return locations cannot redirect off-site or inject HTML', async () => {
    const f = fixture();
    for (const target of ['https://evil.example', '//evil.example', '/\\evil.example', '/\n/evil.example', '/login', '/auth/logout']) {
        const response = await f.call(login(password, target));
        assert.equal(response.headers.get('Location'), '/login?returnTo=%2F');
    }
    const target = '/?x=" autofocus onfocus="alert(1)';
    const page = await f.call(new Request(origin + '/login?returnTo=' + encodeURIComponent(target)));
    assert.ok(!(await page.text()).includes('onfocus="alert(1)'));
    assert.equal((await f.call(login(password, '/index.html?test=1'))).headers.get('Location'), '/login?returnTo=%2Findex.html%3Ftest%3D1');
});

function multiplayer(f: ReturnType<typeof fixture>) {
    const otherPassword = randomBytes(24).toString('base64url');
    const other = { id: randomUUID(), name: '朋友', slotId: randomUUID(),
        passwordHash: createHash('sha256').update(otherPassword).digest('hex'), sessionKey: randomBytes(32).toString('base64url') };
    const auth = { version: 2, primaryPlayerId: 'player', players: [
        { id: 'player', name: '我', slotId: f.env.CLOUD_SLOT_ID, passwordHash: secret.passwordHash, sessionKey: secret.sessionKey }, other,
    ] };
    f.env.GAME_AUTH = JSON.stringify(auth);
    return { auth, other, otherPassword };
}

test('different passwords select independent slots and block both reads and writes to another player', async () => {
    const f = fixture();
    const { other, otherPassword } = multiplayer(f);
    for (const [value, id, slotId, forbidden] of [
        [password, 'player', f.env.CLOUD_SLOT_ID, other.slotId],
        [otherPassword, other.id, other.slotId, f.env.CLOUD_SLOT_ID],
    ]) {
        const response = await f.call(login(value));
        const cookie = response.headers.get('Set-Cookie')!.split(';')[0];
        const status = await f.call(new Request(origin + '/api/cloud-save/status', { headers: { Cookie: cookie } }));
        const body = await status.json() as any;
        assert.equal(body.playerId, id);
        assert.equal(body.slotId, slotId);
        assert.equal(body.primaryPlayerId, 'player');
        assert.ok(!JSON.stringify(body).includes(secret.passwordHash));
        for (const method of ['GET', 'PUT']) {
            const denied = await f.call(new Request(origin + '/api/cloud-save/slots/' + forbidden, {
                method, headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
                ...(method === 'PUT' ? { body: '{}' } : {}),
            }));
            assert.equal(denied.status, 404);
        }
        const own = await f.call(new Request(origin + '/api/cloud-save/slots/' + slotId, { headers: { Cookie: cookie } }));
        assert.equal((await own.json() as any).code, 'EMPTY_SLOT');
    }
});

test('rotating one password revokes only that player and retains both storage identities', async () => {
    const f = fixture();
    const { auth, other, otherPassword } = multiplayer(f);
    const mine = await signedCookie(f);
    const theirs = (await f.call(login(otherPassword))).headers.get('Set-Cookie')!.split(';')[0];
    const newPassword = randomBytes(24).toString('base64url');
    Object.assign(other, { passwordHash: createHash('sha256').update(newPassword).digest('hex'), sessionKey: randomBytes(32).toString('base64url') });
    f.env.GAME_AUTH = JSON.stringify(auth);
    const status = (cookie: string) => f.call(new Request(origin + '/api/cloud-save/status', { headers: { Cookie: cookie } }));
    assert.equal((await status(mine)).status, 200);
    assert.equal((await status(theirs)).status, 401);
    assert.equal((await f.call(login(otherPassword))).status, 401);
    const renewed = (await f.call(login(newPassword))).headers.get('Set-Cookie')!.split(';')[0];
    const body = await (await status(renewed)).json() as any;
    assert.equal(body.slotId, other.slotId);
    assert.equal(body.playerId, other.id);
});

test('forging another player subject without their signing key cannot change identity', async () => {
    const f = fixture();
    const { other } = multiplayer(f);
    const now = initialTime / 1000;
    const token = await new SignJWT({ sub: other.id, v: 2, iss: origin, aud: 'pokeclicker-game', iat: now, exp: now + SESSION_SECONDS, jti: 'test' })
        .setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode(secret.sessionKey));
    assert.equal((await f.call(new Request(origin + '/api/cloud-save/status', { headers: { Cookie: SESSION_COOKIE + '=' + token } }))).status, 401);
});

test('duplicate passwords, slots or identities fail closed before assets are served', async () => {
    for (const key of ['id', 'slotId', 'passwordHash', 'sessionKey']) {
        const f = fixture();
        const { auth } = multiplayer(f);
        (auth.players[1] as any)[key] = (auth.players[0] as any)[key];
        f.env.GAME_AUTH = JSON.stringify(auth);
        assert.equal((await f.call(new Request(origin + '/'))).status, 503);
        assert.equal(f.stats().assets, 0);
    }
});

test('player identity remains available during a GitHub outage without reading the repository', async () => {
    const f = fixture();
    const { other, otherPassword } = multiplayer(f);
    f.env.GITHUB_SAVE_TOKEN = '';
    const response = await f.call(login(otherPassword));
    const cookie = response.headers.get('Set-Cookie')!.split(';')[0];
    const identity = await f.call(new Request(origin + '/api/cloud-save/identity', { headers: { Cookie: cookie } }));
    assert.equal(identity.status, 200);
    const data = await identity.json() as any;
    assert.equal(data.playerId, other.id);
    assert.equal(data.slotId, other.slotId);
    assert.equal(f.stats().reads, 0);
    assert.equal((await f.call(new Request(origin + '/api/cloud-save/status', { headers: { Cookie: cookie } }))).status, 503);
});
