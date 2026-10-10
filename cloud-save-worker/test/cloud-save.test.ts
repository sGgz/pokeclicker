import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHandler, type Env } from '../src/index';
import { SESSION_COOKIE, createSessionCookie, players } from '../src/auth';
import { ApiError, GithubStore } from '../src/github';
import { hashPayload, validateRemote, type CloudSaveEnvelope, type RemoteSave, type SavePayload, type UploadRequest } from '../../src/modules/cloudSave/protocol';
import { SyncEngine, decideStartup } from '../../src/modules/cloudSave/SyncEngine';
import { emptyState, type StateStorage, type SyncState } from '../../src/modules/cloudSave/storage';
import { CloudApiError } from '../../src/modules/cloudSave/api';

const slot = '66cf8d51-2bac-4a66-a608-5f08a77ed50a';
const env: Env = {
    GITHUB_OWNER: 'test-owner', GITHUB_SAVE_REPO: 'private-saves', GITHUB_SAVE_BRANCH: 'main', GITHUB_SAVE_TOKEN: 'test-token',
    CLOUD_SLOT_ID: slot, GAME_AUTH: JSON.stringify({ version: 1, passwordHash: 'a'.repeat(64), sessionKey: 'b'.repeat(43) }),
    LOGIN_RATE_LIMITER: { limit: async () => ({ success: true }) }, LOGIN_GLOBAL_LIMITER: { limit: async () => ({ success: true }) },
    ALLOWED_ORIGIN: 'https://play.ggzz.fun',
    ASSETS: { fetch: async () => new Response('asset') },
};
const payload = (money = 1): SavePayload => ({
    player: { _lastSeen: 123, trainerId: '123456' },
    save: { update: { version: '0.10.26' }, wallet: { money }, profile: { name: '妙蛙种子🙂' } }, settings: { theme: 'yeti' },
});
const requestData = (base: RemoteSave | null = null, data = payload()): UploadRequest => ({
    baseBlobSha: base?.blobSha ?? null, baseRevision: base?.envelope.revision ?? 0,
    snapshotId: crypto.randomUUID(), deviceId: crypto.randomUUID(), clientSavedAt: new Date().toISOString(), clientBuild: 'test', payload: data,
});
function request(data?: UploadRequest, extra: Record<string, string> = {}, method = 'PUT'): Request {
    return new Request(env.ALLOWED_ORIGIN + '/api/cloud-save/slots/' + slot, {
        method, headers: { Cookie: SESSION_COOKIE + '=test-jwt', Origin: env.ALLOWED_ORIGIN, 'Content-Type': 'application/json', ...extra },
        ...(data ? { body: JSON.stringify(data) } : {}),
    });
}
class MemoryGithub {
    current: RemoteSave | null = null;
    writes = 0;
    available = true;
    async assertAvailable() {
        if (!this.available) throw new ApiError(503, 'GITHUB_CONFIGURATION', 'unavailable');
    }
    async read() { return structuredClone(this.current); }
    async write(envelope: CloudSaveEnvelope, sha: string | null) {
        if ((this.current?.blobSha ?? null) !== sha) throw new ApiError(409, 'WRITE_RACE', 'race');
        this.writes++;
        this.current = { blobSha: String(this.writes).padStart(40, '0'), envelope: structuredClone(envelope) };
        return { blobSha: this.current.blobSha, commitSha: 'c'.repeat(40) };
    }
}
function service(store = new MemoryGithub()) {
    let now = Date.now();
    return { store, advance: () => { now += 20000; }, handler: createHandler({ authenticate: async (_token, config) => players(config)[0], store: () => store, now: () => now }) };
}

test('API creates a Unicode snapshot and returns a verifiable receipt', async () => {
    const { handler, store } = service();
    const response = await handler(request(requestData()), env);
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const remote = await validateRemote(await response.json(), slot);
    assert.equal(remote.envelope.payload.save.profile && (remote.envelope.payload.save.profile as any).name, '妙蛙种子🙂');
    assert.equal(store.writes, 1);
});

test('stale devices cannot replace a newer cloud snapshot', async () => {
    const { handler, store, advance } = service();
    await handler(request(requestData()), env);
    const old = structuredClone(store.current);
    advance();
    assert.equal((await handler(request(requestData(old, payload(2))), env)).status, 200);
    advance();
    const conflict = await handler(request(requestData(old, payload(3))), env);
    assert.equal(conflict.status, 409);
    assert.equal(store.writes, 2);
    assert.equal((store.current!.envelope.payload.save.wallet as any).money, 2);
});

test('two concurrent creates have one winner', async () => {
    const { handler, store } = service();
    const responses = await Promise.all([handler(request(requestData()), env), handler(request(requestData(null, payload(2))), env)]);
    assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]);
    assert.equal(store.writes, 1);
});

test('retry after a lost response does not add a duplicate commit', async () => {
    const { handler, store } = service();
    const upload = requestData();
    await handler(request(upload), env);
    assert.equal((await handler(request(upload), env)).status, 200);
    assert.equal(store.writes, 1);
});

test('a valid base cannot reuse a snapshot ID for different content', async () => {
    const { handler, store, advance } = service();
    const upload = requestData();
    await handler(request(upload), env);
    advance();
    const next = requestData(store.current, payload(2));
    next.snapshotId = upload.snapshotId;
    assert.equal((await handler(request(next), env)).status, 422);
    assert.equal(store.writes, 1);
});

test('reject unauthenticated, cross-origin and wrong-host requests before writes', async () => {
    const { handler, store } = service();
    const unauthenticated = request(requestData());
    unauthenticated.headers.delete('Cookie');
    assert.equal((await handler(unauthenticated, env)).status, 401);
    assert.equal((await handler(request(requestData(), { Origin: 'https://evil.example' }), env)).status, 403);
    const wrongHost = new Request('https://test.workers.dev/api/cloud-save/slots/' + slot, request(requestData()));
    assert.equal((await handler(wrongHost, env)).status, 403);
    assert.equal(store.writes, 0);
});

test('fail closed on missing configuration and reject arbitrary slots', async () => {
    const { handler } = service();
    assert.equal((await handler(request(undefined, {}, 'GET'), { ...env, GITHUB_SAVE_TOKEN: '' })).status, 503);
    assert.equal((await handler(new Request(env.ALLOWED_ORIGIN + '/api/cloud-save/slots/other', {
        headers: { Cookie: SESSION_COOKIE + '=test' },
    }), env)).status, 404);
});

test('reject malformed data and limit upload size', async () => {
    const { handler, store } = service();
    const malformed = requestData();
    (malformed.payload as any).player = null;
    assert.equal((await handler(request(malformed), env)).status, 422);
    const huge = requestData();
    huge.payload.settings.large = 'x'.repeat(6 * 1024 * 1024);
    assert.equal((await handler(request(huge), env)).status, 413);
    assert.equal(store.writes, 0);
});

test('rate limit rapid writes without overwriting the last save', async () => {
    const { handler, store } = service();
    await handler(request(requestData()), env);
    const response = await handler(request(requestData(store.current, payload(2))), env);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '15');
    assert.equal(store.writes, 1);
});

test('do not replace newer game saves with an older game version', async () => {
    const { handler, store, advance } = service();
    await handler(request(requestData()), env);
    advance();
    const old = payload(2);
    old.save.update = { version: '0.10.25' };
    assert.equal((await handler(request(requestData(store.current, old)), env)).status, 422);
    assert.equal(store.writes, 1);
});

test('GitHub missing file is not an empty slot when the repository is inaccessible', async () => {
    const store = new GithubStore(env, async () => new Response('{}', { status: 404 }));
    await assert.rejects(store.read(), (error: ApiError) => error.code === 'GITHUB_CONFIGURATION');
});

test('large GitHub files are fetched by the immutable blob SHA', async () => {
    const { handler, store } = service();
    await handler(request(requestData()), env);
    const visited: string[] = [];
    const github = new GithubStore(env, async (input) => {
        visited.push(String(input));
        if (visited.length === 1) {
            return Response.json({ type: 'file', sha: store.current!.blobSha, size: 1200000, encoding: 'none', content: '' });
        }
        return new Response(JSON.stringify(store.current!.envelope));
    });
    assert.equal((await github.read())!.blobSha, store.current!.blobSha);
    assert.ok(visited[1].endsWith('/git/blobs/' + store.current!.blobSha));
});

test('GitHub permission errors are distinguished from browser login errors', async () => {
    const store = new GithubStore(env, async () => new Response('{}', { status: 401 }));
    await assert.rejects(store.read(), (error: ApiError) => error.status === 503 && error.code === 'GITHUB_AUTH');
});

test('GitHub validation errors without a changed file are not misreported as data conflicts', async () => {
    const backing = new MemoryGithub();
    const handler = createHandler({
        authenticate: async (_token, config) => players(config)[0],
        store: () => ({ ...backing, read: () => backing.read(), assertAvailable: () => backing.assertAvailable(),
            write: async () => { throw new ApiError(409, 'WRITE_RACE', 'GitHub 422'); } }),
    });
    assert.equal((await handler(request(requestData()), env)).status, 502);
});


function memoryState(initial: SyncState = emptyState()): StateStorage & { saved: SyncState; fail: boolean } {
    return {
        saved: structuredClone(initial), fail: false,
        async getState() { return structuredClone(this.saved); },
        async saveState(value) {
            if (this.fail) throw new Error('disk full');
            this.saved = structuredClone(value);
        },
    };
}
async function engineFixture() {
    const backend = service();
    const storage = memoryState();
    const api = {
        read: async () => structuredClone(backend.store.current),
        upload: async (_slot: string, upload: UploadRequest) => {
            backend.advance();
            const response = await backend.handler(request(upload), env);
            const data: any = await response.json();
            if (!response.ok) throw new CloudApiError(response.status, data.code, data.message, data.remote);
            return validateRemote(data, slot);
        },
    };
    const engine = new SyncEngine(storage, api, await storage.getState());
    await engine.bind('', slot, null);
    await engine.capture(payload());
    return { engine, storage, api, backend };
}

test('failed persistence prevents the network write', async () => {
    const { engine, storage, backend } = await engineFixture();
    storage.fail = true;
    await assert.rejects(engine.sync('test'), /disk full/);
    assert.equal(backend.store.writes, 0);
});

test('persisted uncertain uploads survive reload and retry with the same snapshot ID', async () => {
    const { engine, storage, api, backend } = await engineFixture();
    const original = api.upload;
    let lose = true;
    api.upload = async (id, upload) => {
        const response = await original(id, upload);
        if (lose) { lose = false; throw new Error('response lost'); }
        return response;
    };
    await assert.rejects(engine.sync('test'));
    const pending = storage.saved.pending!.snapshotId;
    const resumed = new SyncEngine(storage, api, await storage.getState());
    await resumed.sync('test');
    assert.equal(backend.store.current!.envelope.snapshotId, pending);
    assert.equal(backend.store.writes, 1);
    assert.equal(storage.saved.pending, null);
});

test('progress made during an upload remains dirty after the earlier receipt', async () => {
    const { engine, api } = await engineFixture();
    const original = api.upload;
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    api.upload = async (id, upload) => { entered(); await gate; return original(id, upload); };
    const job = engine.sync('test');
    await started;
    await engine.capture(payload(2));
    release();
    await job;
    assert.equal(await engine.dirty(), true);
    assert.equal((engine.state.latest!.save.wallet as any).money, 2);
    await engine.sync('test');
    assert.equal(await engine.dirty(), false);
});

test('startup chooses remote only when local progress has not changed', async () => {
    const { engine, api, backend } = await engineFixture();
    await engine.sync('test');
    const baseline = structuredClone(engine.state);
    const next = requestData(backend.store.current, payload(2));
    const remote = await api.upload(slot, next);
    assert.equal(await decideStartup(baseline, payload(), remote), 'remote');
    assert.equal(await decideStartup(baseline, payload(3), remote), 'conflict');
    assert.equal(await decideStartup(baseline, payload(3), null), 'conflict');
});

test('a conflict stops automatic sync and preserves the local snapshot and pending request', async () => {
    const { engine, api, backend } = await engineFixture();
    await engine.sync('test');
    await engine.setAutomatic(true);
    await engine.capture(payload(3));
    await api.upload(slot, requestData(backend.store.current, payload(2)));
    await assert.rejects(engine.sync('test'));
    assert.equal(engine.state.hasConflict, true);
    assert.equal(engine.state.autoSync, false);
    assert.ok(engine.state.pending);
    assert.equal((engine.state.latest!.save.wallet as any).money, 3);
});

test('hashes are stable across object key order and detect changed progress', async () => {
    const left = payload();
    const right = { settings: left.settings, save: left.save, player: left.player };
    assert.equal(await hashPayload(left), await hashPayload(right));
    assert.notEqual(await hashPayload(left), await hashPayload(payload(2)));
});

test('binding another local save requires explicitly enabling automatic sync again', async () => {
    const { engine } = await engineFixture();
    await engine.setAutomatic(true);
    await engine.bind('another-local-slot', slot, null);
    assert.equal(engine.state.autoSync, false);
});

test('concurrent authenticated players create and read independent saves in one repository and branch', async () => {
    const otherId = crypto.randomUUID();
    const otherSlot = crypto.randomUUID();
    const config = { ...env, GAME_AUTH: JSON.stringify({ version: 2, primaryPlayerId: 'player', players: [
        { id: 'player', name: '我', slotId: slot, passwordHash: 'a'.repeat(64), sessionKey: 'b'.repeat(43) },
        { id: otherId, name: '朋友', slotId: otherSlot, passwordHash: 'c'.repeat(64), sessionKey: 'd'.repeat(43) },
    ] }) };
    const stores = new Map([[slot, new MemoryGithub()], [otherSlot, new MemoryGithub()]]);
    const handler = createHandler({ store: scoped => {
        assert.equal(scoped.GITHUB_SAVE_REPO, env.GITHUB_SAVE_REPO);
        assert.equal(scoped.GITHUB_SAVE_BRANCH, env.GITHUB_SAVE_BRANCH);
        return stores.get(scoped.CLOUD_SLOT_ID)!;
    } });
    const cookies = await Promise.all(['player', otherId].map(id => createSessionCookie(config, config.ALLOWED_ORIGIN, Date.now(), id)));
    const call = (index: number, data?: UploadRequest) => handler(new Request(config.ALLOWED_ORIGIN + '/api/cloud-save/slots/' + [slot, otherSlot][index], {
        method: data ? 'PUT' : 'GET', headers: { Cookie: cookies[index].split(';')[0], Origin: config.ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
        ...(data ? { body: JSON.stringify(data) } : {}),
    }), config);
    const writes = await Promise.all([call(0, requestData(null, payload(10))), call(1, requestData(null, payload(20)))]);
    assert.deepEqual(writes.map(response => response.status), [201, 201]);
    for (let index = 0; index < 2; index++) {
        const remote = await (await call(index)).json() as RemoteSave;
        assert.equal((remote.envelope.payload.save.wallet as any).money, [10, 20][index]);
        assert.equal(remote.envelope.slotId, [slot, otherSlot][index]);
        const paths: string[] = [];
        const github = new GithubStore({ ...config, CLOUD_SLOT_ID: remote.envelope.slotId }, async (input, init) => {
            paths.push(String(input));
            const body = JSON.parse(String(init!.body));
            assert.equal(body.branch, env.GITHUB_SAVE_BRANCH);
            assert.equal(JSON.parse(Buffer.from(body.content, 'base64').toString('utf8')).slotId, remote.envelope.slotId);
            return Response.json({ content: { sha: 'e'.repeat(40) }, commit: { sha: 'f'.repeat(40) } });
        });
        await github.write(remote.envelope, null);
        assert.ok(paths[0].endsWith('/contents/saves/' + remote.envelope.slotId + '.json'));
    }
});
