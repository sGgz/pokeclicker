import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createHandler, type Env } from '../src/index';
import { createSessionCookie } from '../src/auth';
import { ApiError } from '../src/github';
import { GithubPlayersStore, migratePlayers, RegistryCache, resolvePlayerAuth, validatePlayers, type RegistrySnapshot } from '../src/players';

const origin = 'https://game.example';
const credential = () => ({ passwordHash: createHash('sha256').update(randomBytes(24)).digest('hex'), sessionKey: randomBytes(32).toString('base64url') });
function fixture() {
    const legacy = { version: 2, primaryPlayerId: 'player', players: [
        { id: 'player', name: '我', slotId: randomUUID(), ...credential() },
        { id: randomUUID(), name: '朋友🙂', slotId: randomUUID(), ...credential() },
    ] };
    const env: Env = { GAME_AUTH: JSON.stringify(legacy), ALLOWED_ORIGIN: origin, CLOUD_SLOT_ID: legacy.players[0].slotId,
        GITHUB_OWNER: 'owner', GITHUB_SAVE_REPO: 'saves', GITHUB_SAVE_BRANCH: 'save/main', GITHUB_SAVE_TOKEN: 'test-token',
        LOGIN_RATE_LIMITER: { limit: async () => ({ success: true }) }, LOGIN_GLOBAL_LIMITER: { limit: async () => ({ success: true }) },
        ASSETS: { fetch: async () => new Response('game') } };
    let snapshot: RegistrySnapshot | null = null, now = Date.now(), writes = 0, reads = 0, unavailable = false;
    const store = { readRegistry: async () => { reads++; if (unavailable) throw new ApiError(503, 'GITHUB_UNAVAILABLE', 'unavailable'); return structuredClone(snapshot); },
        writeRegistry: async (registry: any, sha: string | null) => {
            if (sha !== (snapshot?.blobSha || null)) throw new ApiError(409, 'PLAYERS_CONFLICT', 'conflict');
            writes++; snapshot = { registry: validatePlayers(registry), blobSha: createHash('sha1').update(JSON.stringify(registry)).digest('hex') }; return structuredClone(snapshot);
        } };
    const handler = createHandler({ now: () => now, registry: () => store });
    const cookie = async (id = 'player') => {
        const auth = snapshot ? await resolvePlayerAuth(env, snapshot.registry) : env;
        return (await createSessionCookie(auth, origin, now, id)).split(';')[0];
    };
    const call = async (cookieValue: string | undefined, body?: any, headers: Record<string, string> = {}, endpoint = '/api/cloud-save/admin/players') => handler(new Request(origin + endpoint, {
        method: body ? 'POST' : 'GET', headers: { Origin: origin, ...(cookieValue ? { Cookie: cookieValue } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
        ...(body ? { body: JSON.stringify(body) } : {}),
    }), env);
    const activate = async () => {
        assert.equal((await call(await cookie(), { command: 'init' })).status, 200);
        env.GAME_AUTH = JSON.stringify({ version: 3, sessionKey: randomBytes(32).toString('base64url') });
    };
    return { env, legacy, store, handler, cookie, call, activate, snapshot: () => structuredClone(snapshot!), stats: () => ({ reads, writes }), advance: () => { now += 16000; }, fail: () => { unavailable = true; } };
}

test('remote migration retains all passwords and slots, excludes signing keys, and retries idempotently', async () => {
    const f = fixture(), cookie = await f.cookie();
    const response = await f.call(cookie, { command: 'init' });
    assert.equal(response.status, 200);
    const result: any = await response.json();
    assert.equal(result.activate, true);
    assert.equal(result.players.length, 2);
    for (const player of f.legacy.players) {
        const migrated = f.snapshot().registry.players.find(entry => entry.id === player.id)!;
        assert.equal(migrated.passwordHash, player.passwordHash);
        assert.equal(migrated.slotId, player.slotId);
        assert.ok(!JSON.stringify(f.snapshot()).includes(player.sessionKey));
        assert.ok(!JSON.stringify(result).includes(player.passwordHash));
    }
    assert.equal((await f.call(cookie, { command: 'init' })).status, 200);
    assert.equal(f.stats().writes, 1);
    assert.equal((await f.call(cookie, { command: 'add', name: 'blocked' })).status, 409);
});

test('remote management is primary-only, blocks CSRF, and resolves every operation from the latest registry', async () => {
    const f = fixture(); await f.activate();
    const owner = await f.cookie(), friend = await f.cookie(f.legacy.players[1].id);
    assert.equal((await f.call(friend)).status, 403);
    assert.equal((await f.call(undefined)).status, 401);
    assert.equal((await f.call(owner, { command: 'init' }, { Origin: 'https://evil.example' })).status, 403);
    const initial: any = await (await f.call(owner)).json();
    const addedHash = credential().passwordHash;
    assert.equal((await f.call(owner, { command: 'add', name: '第三人', passwordHash: addedHash, baseBlobSha: initial.blobSha })).status, 200);
    assert.equal(f.snapshot().registry.players.length, 3);
    assert.equal((await f.call(owner, { command: 'add', name: '第四人', passwordHash: credential().passwordHash, baseBlobSha: initial.blobSha })).status, 409);
    assert.equal(f.snapshot().registry.players.length, 3);
});

test('reset rotates only one credential version, retaining identities and other player sessions', async () => {
    const f = fixture(); await f.activate();
    const owner = await f.cookie(), friend = await f.cookie(f.legacy.players[1].id);
    const before = f.snapshot();
    assert.equal((await f.call(owner, { command: 'reset', playerId: f.legacy.players[1].id, passwordHash: credential().passwordHash, baseBlobSha: before.blobSha })).status, 200);
    const after = f.snapshot();
    assert.deepEqual(after.registry.players[0], before.registry.players[0]);
    assert.equal(after.registry.players[1].slotId, before.registry.players[1].slotId);
    assert.notEqual(after.registry.players[1].credentialVersion, before.registry.players[1].credentialVersion);
    assert.equal((await f.call(owner, undefined, {}, '/api/cloud-save/identity')).status, 200);
    assert.equal((await f.call(friend, undefined, {}, '/api/cloud-save/identity')).status, 401);
    assert.equal((await f.call(await f.cookie(f.legacy.players[1].id), undefined, {}, '/api/cloud-save/identity')).status, 200);
});

test('GitHub outages after cache expiry fail closed and never resurrect legacy passwords', async () => {
    const f = fixture(); const oldCookie = await f.cookie(); await f.activate();
    const owner = await f.cookie();
    assert.equal((await f.call(owner, undefined, {}, '/api/cloud-save/identity')).status, 200);
    assert.equal((await f.call(oldCookie, undefined, {}, '/api/cloud-save/identity')).status, 401);
    f.fail(); f.advance();
    assert.equal((await f.call(owner, undefined, {}, '/api/cloud-save/identity')).status, 503);
    assert.equal((await f.call(undefined, undefined, {}, '/api/cloud-save/identity')).status, 401);
    assert.equal((await f.call(undefined, undefined, {}, '/login')).status, 200);
});

test('registry cache coalesces reads and expires without serving stale data on error', async () => {
    const f = fixture(), cache = new RegistryCache();
    await f.activate();
    const before = f.stats().reads;
    await Promise.all([cache.read(f.env, f.store, 100), cache.read(f.env, f.store, 100)]);
    assert.equal(f.stats().reads, before + 1);
    f.fail();
    await assert.rejects(cache.read(f.env, f.store, 15100));
    await assert.rejects(cache.read(f.env, f.store, 15101));
    assert.equal(f.stats().reads, before + 3);
});

test('Git registry rejects secret fields, duplicate identities, and loss of the primary player', () => {
    const f = fixture(), registry = migratePlayers(f.env);
    assert.throws(() => validatePlayers({ ...registry, sessionKey: 'secret' }));
    const withKey = structuredClone(registry) as any; withKey.players[0].sessionKey = 'secret';
    assert.throws(() => validatePlayers(withKey));
    assert.throws(() => validatePlayers({ ...registry, players: [registry.players[1]] }));
    assert.throws(() => validatePlayers({ ...registry, players: [registry.players[0], registry.players[0]] }));
});

test('Git registry verifies repository privacy, reads the configured branch, and uses SHA for writes', async () => {
    const f = fixture(), registry = migratePlayers(f.env);
    let privateRepo = true, writes = 0;
    const sha = 'a'.repeat(40);
    const store = new GithubPlayersStore(f.env, async (url, init) => {
        assert.equal(init?.redirect, 'manual');
        if (String(url).endsWith('/repos/owner/saves')) return Response.json({ private: privateRepo });
        assert.ok(String(url).includes('/contents/config/players.json'));
        if (init?.method === 'PUT') {
            const body = JSON.parse(String(init.body));
            assert.equal(body.sha, sha); assert.equal(body.branch, 'save/main');
            assert.deepEqual(JSON.parse(Buffer.from(body.content, 'base64').toString('utf8')), registry);
            writes++; return Response.json({ content: { sha: 'b'.repeat(40) } });
        }
        assert.ok(String(url).endsWith('?ref=save%2Fmain'));
        return Response.json({ type: 'file', sha, size: 1000, encoding: 'base64', content: Buffer.from(JSON.stringify(registry)).toString('base64') });
    });
    assert.deepEqual((await store.readRegistry())?.registry, registry);
    assert.equal((await store.writeRegistry(registry, sha)).blobSha, 'b'.repeat(40));
    privateRepo = false;
    await assert.rejects(store.readRegistry(), (error: any) => error.code === 'PRIVATE_REPOSITORY_REQUIRED');
    await assert.rejects(store.writeRegistry(registry, sha));
    assert.equal(writes, 1);
});

test('Git write conflicts and redirects are never accepted or followed', async () => {
    const f = fixture(), registry = migratePlayers(f.env);
    for (const status of [409, 422]) {
        const store = new GithubPlayersStore(f.env, async (_url, init) => init?.method === 'PUT' ? new Response(null, { status }) : Response.json({ private: true }));
        await assert.rejects(store.writeRegistry(registry, 'a'.repeat(40)), (error: any) => error.code === 'PLAYERS_CONFLICT');
    }
    const store = new GithubPlayersStore(f.env, async () => new Response(null, { status: 302, headers: { Location: 'https://evil.example' } }));
    await assert.rejects(store.readRegistry(), (error: any) => error.code === 'GITHUB_REDIRECT');
});
