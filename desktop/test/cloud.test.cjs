'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createCloudClient } = require('../src/cloud.cjs');

const ORIGIN = 'https://play.ggzz.fun';
const PASSWORD = 'A'.repeat(32);
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJ2IjoxfQ.signature1';
const NEW_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJ2IjoyfQ.signature2';
const SLOT = '/api/cloud-save/slots/12345678-1234-4234-8234-123456789abc';
const SESSION_FILE = 'encrypted-session.bin';

function safeStorage() {
    const key = crypto.randomBytes(32);
    return {
        isEncryptionAvailable: () => true,
        encryptString(value) {
            const iv = crypto.randomBytes(12);
            const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
            const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
            return Buffer.concat([iv, cipher.getAuthTag(), data]);
        },
        decryptString(value) {
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
            decipher.setAuthTag(value.subarray(12, 28));
            return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
        },
    };
}

function cookie(token = TOKEN) {
    return `__Host-pokeclicker_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800`;
}

function loginResponse(token = TOKEN, headers = {}) {
    return new Response(null, { status: 303, headers: { Location: '/login?returnTo=%2F', 'Set-Cookie': cookie(token), ...headers } });
}

function jsonResponse(body = { ok: true }, status = 200, headers = {}) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

async function fixture(t, fetcher, storage = safeStorage()) {
    const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'pokeclicker-cloud-test-'));
    t.after(() => fs.rm(userData, { recursive: true, force: true }));
    return { userData, storage, client: createCloudClient({ userData, safeStorage: storage, fetcher }) };
}

function code(result) { return JSON.parse(result.body).code; }

test('without a session, requests return local LOGIN_REQUIRED and never access the network', async t => {
    const { client } = await fixture(t, () => { assert.fail('network must not be used'); });
    const result = await client.request({ path: '/api/cloud-save/status', method: 'GET' });
    assert.equal(result.status, 401);
    assert.equal(code(result), 'LOGIN_REQUIRED');
});

test('login uses the fixed origin, manual redirects and a password-only form; renderer receives no credentials', async t => {
    const calls = [];
    const { client } = await fixture(t, (url, options) => {
        calls.push({ url, options });
        return Promise.resolve(url.endsWith('/auth/login') ? loginResponse() : jsonResponse());
    });
    assert.deepEqual(await client.login(PASSWORD), { ok: true });
    const login = calls[0];
    assert.equal(login.url, ORIGIN + '/auth/login');
    assert.equal(login.options.redirect, 'manual');
    assert.equal(login.options.method, 'POST');
    assert.equal(login.options.headers.Origin, ORIGIN);
    assert.equal(login.options.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.equal(login.options.headers.Cookie, undefined);
    assert.equal(new URLSearchParams(login.options.body).get('password'), PASSWORD);
    assert.equal(new URLSearchParams(login.options.body).get('returnTo'), '/');
    assert.ok(login.options.signal instanceof AbortSignal);
    for (const request of [
        { path: '/api/cloud-save/status', method: 'GET' },
        { path: '/api/cloud-save/slots', method: 'GET' },
        { path: SLOT, method: 'GET' },
        { path: SLOT, method: 'PUT', body: '{"payload":{}}' },
    ]) {
        assert.deepEqual(await client.request(request), { status: 200, body: '{"ok":true}' });
        const call = calls.at(-1);
        assert.equal(call.url, ORIGIN + request.path);
        assert.equal(call.options.headers.Cookie, '__Host-pokeclicker_session=' + TOKEN);
        assert.equal(call.options.headers.Origin, ORIGIN);
        assert.equal(call.options.redirect, 'manual');
    }
});

test('strict path/method/body whitelist prevents arbitrary proxy requests', async t => {
    const { client } = await fixture(t, () => { assert.fail('invalid input reached network'); });
    for (const input of [
        null, {}, { path: '/api/cloud-save/status' },
        { path: 'https://evil.invalid/', method: 'GET' },
        { path: '//evil.invalid/', method: 'GET' },
        { path: '/api/cloud-save/status?x=1', method: 'GET' },
        { path: '/api/cloud-save/status#x', method: 'GET' },
        { path: '/api/cloud-save/%73tatus', method: 'GET' },
        { path: '/api/cloud-save/slots/../status', method: 'GET' },
        { path: '/api/cloud-save/status/', method: 'GET' },
        { path: '/api/cloud-save/status', method: 'get' },
        { path: '/api/cloud-save/status', method: 'POST' },
        { path: SLOT, method: 'DELETE' },
        { path: SLOT.replace('/api/', '/API/'), method: 'GET' },
        { path: SLOT, method: 'PUT', body: 'not json' },
        { path: SLOT, method: 'PUT', body: [] },
        { path: SLOT, method: 'PUT', body: '{}', headers: { Cookie: 'injected' } },
        { path: '/api/cloud-save/status', method: 'GET', body: '{}' },
        { path: '/auth/login', method: 'POST', body: '{}' },
        { path: '/auth/logout', method: 'GET' },
        { path: '/api/cloud-save/slots/not-a-uuid', method: 'GET' },
        { path: '/api/cloud-save/slots/12345678-1234-0234-0234-123456789abc', method: 'GET' },
        { path: SLOT, method: 'PUT', body: JSON.stringify({ text: '中'.repeat(2 * 1024 * 1024) }) },
    ]) {
        const result = await client.request(input);
        assert.equal(result.status, 403, JSON.stringify(input)?.slice(0, 100));
        assert.equal(code(result), 'DESKTOP_REQUEST');
    }
});

test('login rejects invalid passwords locally and maps wrong password and rate limiting without leaking remote content', async t => {
    let calls = 0;
    const { client } = await fixture(t, () => new Response('remote content with private details', { status: ++calls === 1 ? 401 : 429 }));
    assert.equal((await client.login('short')).ok, false);
    assert.equal((await client.login(PASSWORD + '\n')).ok, false);
    assert.equal(calls, 0);
    assert.match((await client.login(PASSWORD)).message, /密码不正确/);
    assert.match((await client.login(PASSWORD)).message, /60 秒/);
    assert.equal(code(await client.request({ path: SLOT, method: 'GET' })), 'LOGIN_REQUIRED');
});

test('only the expected successful redirect and a protected session cookie are accepted', async t => {
    const responses = [
        new Response(null, { status: 302, headers: { Location: '/login?returnTo=%2F', 'Set-Cookie': cookie() } }),
        loginResponse(TOKEN, { Location: 'https://evil.invalid/' }),
        loginResponse(TOKEN, { Location: ORIGIN + '/login?returnTo=%2F' }),
        loginResponse(TOKEN, { 'Set-Cookie': cookie().replace('; Secure', '') }),
        loginResponse(TOKEN, { 'Set-Cookie': cookie() + '; Domain=play.ggzz.fun' }),
        loginResponse(TOKEN, { 'Set-Cookie': cookie().replace('SameSite=Strict', 'SameSite=None') }),
        loginResponse(TOKEN, { 'Set-Cookie': cookie().replace('Path=/', 'Path=/api') }),
        loginResponse(TOKEN, { 'Set-Cookie': cookie().replace('Max-Age=604800', 'Max-Age=0') }),
        loginResponse(TOKEN, { 'Set-Cookie': cookie().replace('Max-Age=604800', 'Max-Age=604801') }),
        loginResponse(TOKEN, { 'Set-Cookie': cookie().replace('; HttpOnly', '') }),
        loginResponse(TOKEN, { 'Set-Cookie': cookie() + '; Path=/' }),
        loginResponse('invalidtoken'),
        new Response(null, { status: 200 }),
    ];
    const headers = new Headers({ Location: '/login?returnTo=%2F' });
    headers.append('Set-Cookie', cookie());
    headers.append('Set-Cookie', cookie(NEW_TOKEN));
    responses.push(new Response(null, { status: 303, headers }));
    const { client } = await fixture(t, () => responses.shift());
    while (responses.length) assert.equal((await client.login(PASSWORD)).ok, false);
    assert.equal(code(await client.request({ path: SLOT, method: 'GET' })), 'LOGIN_REQUIRED');
});

test('session persistence is encrypted, atomic and reloadable without retaining the password', async t => {
    const { client, userData, storage } = await fixture(t, () => loginResponse());
    assert.equal((await client.login(PASSWORD)).ok, true);
    const persisted = await fs.readFile(path.join(userData, SESSION_FILE));
    assert.equal(persisted.includes(Buffer.from(TOKEN)), false);
    assert.equal(persisted.includes(Buffer.from(PASSWORD)), false);
    assert.deepEqual(await fs.readdir(userData), [SESSION_FILE]);
    const reloaded = createCloudClient({ userData, safeStorage: storage, fetcher: (_url, options) => {
        assert.equal(options.headers.Cookie, '__Host-pokeclicker_session=' + TOKEN);
        return jsonResponse();
    } });
    assert.equal((await reloaded.request({ path: SLOT, method: 'GET' })).status, 200);
});

test('missing OS encryption and weak basic_text backend keep credentials only in memory', async t => {
    for (const storage of [
        { isEncryptionAvailable: () => false },
        { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text' },
        { isEncryptionAvailable: () => true, encryptString() { throw new Error('system private details'); } },
    ]) {
        const { client, userData } = await fixture(t, url => url.endsWith('/auth/login') ? loginResponse() : jsonResponse(), storage);
        const result = await client.login(PASSWORD);
        assert.equal(result.ok, true);
        assert.match(result.message, /内存/);
        assert.equal((await client.request({ path: SLOT, method: 'GET' })).status, 200);
        assert.deepEqual(await fs.readdir(userData), []);
        const restarted = createCloudClient({ userData, safeStorage: storage, fetcher: () => assert.fail('no persisted session') });
        assert.equal(code(await restarted.request({ path: SLOT, method: 'GET' })), 'LOGIN_REQUIRED');
    }
});

test('damaged encrypted session only requires logging in again', async t => {
    const { userData, storage } = await fixture(t, () => loginResponse());
    await fs.writeFile(path.join(userData, SESSION_FILE), 'damaged encrypted credentials');
    const restarted = createCloudClient({ userData, safeStorage: storage, fetcher: () => loginResponse() });
    assert.equal(code(await restarted.request({ path: SLOT, method: 'GET' })), 'LOGIN_REQUIRED');
    assert.equal((await restarted.login(PASSWORD)).ok, true);
});

test('API redirects are never followed and expired sessions are removed from memory and disk', async t => {
    let mode = 'login';
    const { client, userData, storage } = await fixture(t, () => {
        if (mode === 'login') return loginResponse();
        if (mode === 'redirect') return new Response(null, { status: 302, headers: { Location: 'https://evil.invalid' } });
        return jsonResponse({ code: 'LOGIN_REQUIRED' }, 401);
    });
    await client.login(PASSWORD);
    mode = 'redirect';
    assert.equal(code(await client.request({ path: SLOT, method: 'GET' })), 'CLOUD_UNAVAILABLE');
    mode = 'expired';
    assert.equal((await client.request({ path: SLOT, method: 'GET' })).status, 401);
    assert.equal(code(await client.request({ path: SLOT, method: 'GET' })), 'LOGIN_REQUIRED');
    assert.deepEqual(await fs.readdir(userData), []);
    const restarted = createCloudClient({ userData, safeStorage: storage, fetcher: () => assert.fail('expired session was persisted') });
    assert.equal(code(await restarted.request({ path: SLOT, method: 'GET' })), 'LOGIN_REQUIRED');
});

test('API responses preserve JSON errors and numeric Retry-After but never forward headers or HTML', async t => {
    let mode = 'login';
    const { client } = await fixture(t, () => {
        if (mode === 'login') return loginResponse();
        if (mode === 'limited') return jsonResponse({ code: 'RATE_LIMIT' }, 429, { 'Retry-After': '60', 'Set-Cookie': cookie(NEW_TOKEN) });
        if (mode === 'html') return new Response('<html>private details</html>', { headers: { 'Content-Type': 'text/html' } });
        return new Response('invalid json', { headers: { 'Content-Type': 'application/json' } });
    });
    await client.login(PASSWORD);
    mode = 'limited';
    assert.deepEqual(await client.request({ path: SLOT, method: 'GET' }), { status: 429, body: '{"code":"RATE_LIMIT"}', retryAfter: '60' });
    mode = 'html';
    assert.equal(code(await client.request({ path: SLOT, method: 'GET' })), 'CLOUD_UNAVAILABLE');
    mode = 'badjson';
    assert.equal(code(await client.request({ path: SLOT, method: 'GET' })), 'CLOUD_UNAVAILABLE');
});

test('oversized response streams stop reading at the limit, even without Content-Length', async t => {
    let cancelled = false;
    let chunks = 0;
    const { client } = await fixture(t, url => url.endsWith('/auth/login') ? loginResponse() : new Response(new ReadableStream({
        pull(controller) {
            chunks++;
            controller.enqueue(new Uint8Array(1024 * 1024));
        },
        cancel() { cancelled = true; },
    }), { headers: { 'Content-Type': 'application/json' } }));
    await client.login(PASSWORD);
    assert.equal(code(await client.request({ path: SLOT, method: 'GET' })), 'NETWORK');
    assert.equal(cancelled, true);
    assert.ok(chunks <= 12);
});

test('oversized declared Content-Length is rejected before response content is read', async t => {
    const { client } = await fixture(t, url => url.endsWith('/auth/login') ? loginResponse()
        : new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': String(10 * 1024 * 1024 + 1) } }));
    await client.login(PASSWORD);
    assert.equal(code(await client.request({ path: SLOT, method: 'GET' })), 'NETWORK');
});

test('network errors are sanitized and logout clears local credentials even offline', async t => {
    let offline = false;
    let networkCalls = 0;
    const { client, userData } = await fixture(t, () => {
        networkCalls++;
        if (offline) throw new Error(TOKEN + PASSWORD);
        return loginResponse();
    });
    await client.login(PASSWORD);
    offline = true;
    assert.equal(code(await client.request({ path: SLOT, method: 'GET' })), 'NETWORK');
    const beforeLogout = networkCalls;
    assert.deepEqual(await client.request({ path: '/auth/logout', method: 'POST', body: '{}' }), { status: 200, body: '{"ok":true}' });
    assert.equal(networkCalls, beforeLogout);
    assert.deepEqual(await fs.readdir(userData), []);
    assert.equal(code(await client.request({ path: SLOT, method: 'GET' })), 'LOGIN_REQUIRED');
    const failedLogin = await client.login(PASSWORD);
    assert.equal(failedLogin.ok, false);
    assert.equal(JSON.stringify(failedLogin).includes(TOKEN), false);
    assert.equal(JSON.stringify(failedLogin).includes(PASSWORD), false);
});

test('a late 401 cannot erase a newer login', async t => {
    const pending = deferred();
    const entered = deferred();
    let logins = 0;
    const { client } = await fixture(t, (url, options) => {
        if (url.endsWith('/auth/login')) return loginResponse(++logins === 1 ? TOKEN : NEW_TOKEN);
        if (options.headers.Cookie.endsWith(TOKEN)) { entered.resolve(); return pending.promise; }
        assert.ok(options.headers.Cookie.endsWith(NEW_TOKEN));
        return jsonResponse();
    });
    await client.login(PASSWORD);
    const oldRequest = client.request({ path: SLOT, method: 'GET' });
    await entered.promise;
    await client.login(PASSWORD);
    pending.resolve(jsonResponse({ code: 'LOGIN_REQUIRED' }, 401));
    assert.equal((await oldRequest).status, 401);
    assert.equal((await client.request({ path: SLOT, method: 'GET' })).status, 200);
});

test('a login finishing after logout cannot restore credentials', async t => {
    const pending = deferred();
    const entered = deferred();
    const { client, userData } = await fixture(t, () => { entered.resolve(); return pending.promise; });
    const login = client.login(PASSWORD);
    await entered.promise;
    assert.equal((await client.request({ path: '/auth/logout', method: 'POST' })).status, 200);
    pending.resolve(loginResponse());
    assert.equal((await login).ok, false);
    assert.equal(code(await client.request({ path: SLOT, method: 'GET' })), 'LOGIN_REQUIRED');
    assert.deepEqual(await fs.readdir(userData), []);
});

test('the newest login wins even when responses arrive out of order', async t => {
    const pending = deferred();
    const entered = deferred();
    let logins = 0;
    const { client, userData, storage } = await fixture(t, () => {
        if (++logins === 1) { entered.resolve(); return pending.promise; }
        return loginResponse(NEW_TOKEN);
    });
    const older = client.login(PASSWORD);
    await entered.promise;
    assert.equal((await client.login(PASSWORD)).ok, true);
    pending.resolve(loginResponse());
    assert.equal((await older).ok, false);
    assert.equal(storage.decryptString(await fs.readFile(path.join(userData, SESSION_FILE))), NEW_TOKEN);
});

test('configuration rejects non-HTTPS origins and URLs carrying paths or credentials', () => {
    for (const origin of ['http://play.ggzz.fun', 'https://play.ggzz.fun/path', 'https://user:pass@play.ggzz.fun', 'https://play.ggzz.fun?x=1']) {
        assert.throws(() => createCloudClient({ origin, userData: os.tmpdir(), safeStorage: safeStorage() }));
    }
});

test('login aborts a stalled network request after 30 seconds without leaking details', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const entered = deferred();
    let requestSignal;
    const { client } = await fixture(t, (_url, options) => {
        requestSignal = options.signal;
        entered.resolve();
        return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('private details'))));
    });
    const attempt = client.login(PASSWORD);
    await entered.promise;
    t.mock.timers.tick(29999);
    assert.equal(requestSignal.aborted, false);
    t.mock.timers.tick(1);
    assert.equal((await attempt).ok, false);
    assert.equal(requestSignal.aborted, true);
});

test('the timeout also cancels a stalled API response body', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const entered = deferred();
    let cancelled = false;
    const { client } = await fixture(t, url => url.endsWith('/auth/login') ? loginResponse()
        : new Response(new ReadableStream({
            pull() { entered.resolve(); },
            cancel() { cancelled = true; },
        }), { headers: { 'Content-Type': 'application/json' } }));
    await client.login(PASSWORD);
    const pending = client.request({ path: SLOT, method: 'GET' });
    await entered.promise;
    t.mock.timers.tick(30000);
    assert.equal(code(await pending), 'NETWORK');
    assert.equal(cancelled, true);
});

test('logout reports a local storage failure instead of promising persisted credentials were removed', async t => {
    const { client, userData } = await fixture(t, () => loginResponse());
    await client.login(PASSWORD);
    const sessionPath = path.join(userData, SESSION_FILE);
    await fs.rm(sessionPath);
    await fs.mkdir(sessionPath);
    await fs.writeFile(path.join(sessionPath, 'unrelated-file'), 'do not delete recursively');
    const result = await client.request({ path: '/auth/logout', method: 'POST' });
    assert.equal(result.status, 500);
    assert.equal(code(result), 'DESKTOP_CREDENTIALS');
    assert.equal(await fs.readFile(path.join(sessionPath, 'unrelated-file'), 'utf8'), 'do not delete recursively');
    assert.equal(code(await client.request({ path: SLOT, method: 'GET' })), 'LOGIN_REQUIRED');
});
