import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { before, test } from 'node:test';
import { build } from 'esbuild';
import { Miniflare, Response as MiniflareResponse, convertV4MiniflareOptions, type V4FetchHandler } from 'miniflare';
import { hashPayload, type CloudSaveEnvelope, type SavePayload } from '../../src/modules/cloudSave/protocol';
import { migratePlayers } from '../src/players';

const workerRoot = fileURLToPath(new URL('../', import.meta.url));
const slot = '66cf8d51-2bac-4a66-a608-5f08a77ed50a';
const branch = 'fixture/runtime';
const apiRoot = 'https://api.github.com/repos/octocat/Hello-World';
const contentsPath = '/contents/saves/' + slot + '.json';
const fakeToken = 'runtime-test-token-never-sent-to-network';
const blobSha = 'a'.repeat(40);
const commitSha = 'b'.repeat(40);
let script: string;

before(async () => {
    const bundle = await build({
        stdin: {
            contents: `
                import { GithubStore } from './src/github';
                import { GithubPlayersStore, resolvePlayerAuth } from './src/players';
                import { createSessionCookie, verifySession } from './src/auth';
                const config = ${JSON.stringify({
        GITHUB_OWNER: 'octocat', GITHUB_SAVE_REPO: 'Hello-World', GITHUB_SAVE_BRANCH: branch,
        GITHUB_SAVE_TOKEN: fakeToken, CLOUD_SLOT_ID: slot,
    })};
                export default { async fetch(request) {
                    const store = new GithubStore(config);
                    try {
                        const operation = new URL(request.url).pathname;
                        if (operation === '/players/read') return Response.json(await new GithubPlayersStore(config).readRegistry());
                        if (operation === '/players/write') {
                            const { registry, sha } = await request.json();
                            return Response.json(await new GithubPlayersStore(config).writeRegistry(registry, sha));
                        }
                        if (operation === '/players/session') {
                            const { registry } = await request.json();
                            const auth = await resolvePlayerAuth({ GAME_AUTH: JSON.stringify({ version: 3, sessionKey: 'k'.repeat(43) }) }, registry);
                            const cookie = await createSessionCookie(auth, 'https://runtime.test');
                            const player = await verifySession(cookie.split(';')[0].split('=')[1], auth, 'https://runtime.test');
                            return Response.json({ playerId: player.id, slotId: player.slotId });
                        }
                        if (operation === '/available') {
                            await store.assertAvailable();
                            return Response.json({ available: true });
                        }
                        if (operation === '/read') return Response.json(await store.read());
                        if (operation === '/write') {
                            const { envelope, sha } = await request.json();
                            return Response.json(await store.write(envelope, sha));
                        }
                        return new Response('Unknown test operation', { status: 404 });
                    } catch (error) {
                        return Response.json({ code: error.code, message: error.message }, { status: error.status || 500 });
                    }
                } };
            `,
            resolveDir: workerRoot,
            sourcefile: 'github-runtime-fixture.ts',
            loader: 'ts',
        },
        bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false,
    });
    script = bundle.outputFiles[0].text;
});

function runtime(outboundService: V4FetchHandler): Miniflare {
    return new Miniflare(convertV4MiniflareOptions({
        modules: true, script, compatibilityDate: '2026-09-20', cf: false,
        host: '127.0.0.1', outboundService,
    }));
}

test('native workerd reads and writes a private Git registry and derives verifiable player sessions', async context => {
    const registry = migratePlayers({ CLOUD_SLOT_ID: slot, GAME_AUTH: JSON.stringify({ version: 1, passwordHash: 'a'.repeat(64), sessionKey: 'k'.repeat(43) }) });
    let saved: string | null = null;
    const mf = runtime(async request => {
        assert.equal(request.headers.get('authorization'), 'Bearer ' + fakeToken);
        if (request.url === apiRoot) return MiniflareResponse.json({ private: true });
        if (request.url.includes('/branches/')) return MiniflareResponse.json({ name: branch });
        if (request.url === apiRoot + '/contents/config/players.json' && request.method === 'PUT') {
            const body: any = await request.json();
            assert.equal(body.branch, branch); assert.equal(body.sha, undefined);
            saved = Buffer.from(body.content, 'base64').toString('utf8');
            assert.deepEqual(JSON.parse(saved), registry);
            assert.ok(!saved.includes('sessionKey'));
            return MiniflareResponse.json({ content: { sha: blobSha } });
        }
        if (request.url === apiRoot + '/contents/config/players.json?ref=' + encodeURIComponent(branch)) {
            return saved ? MiniflareResponse.json({ type: 'file', sha: blobSha, size: Buffer.byteLength(saved), encoding: 'base64', content: Buffer.from(saved).toString('base64') }) : MiniflareResponse.json({}, { status: 404 });
        }
        throw new Error('Unexpected outbound destination');
    });
    context.after(() => mf.dispose());
    assert.equal(await (await mf.dispatchFetch('https://runtime.test/players/read')).json(), null);
    const written = await mf.dispatchFetch('https://runtime.test/players/write', { method: 'POST', body: JSON.stringify({ registry, sha: null }) });
    assert.equal(written.status, 200);
    assert.deepEqual(await (await mf.dispatchFetch('https://runtime.test/players/read')).json(), { registry, blobSha });
    const session = await mf.dispatchFetch('https://runtime.test/players/session', { method: 'POST', body: JSON.stringify({ registry }) });
    assert.equal(session.status, 200);
    assert.deepEqual(await session.json(), { playerId: 'player', slotId: slot });
});

async function sampleEnvelope(): Promise<CloudSaveEnvelope> {
    const payload: SavePayload = {
        player: { trainerId: 'runtime-fixture', _lastSeen: 123 },
        save: { update: { version: '0.10.26' }, profile: { name: '皮卡丘🙂' } },
        settings: { theme: 'yeti' },
    };
    return {
        schemaVersion: 1, slotId: slot, revision: 1,
        snapshotId: '82952bce-6e76-48d1-bcd5-34178aa5ee7c', parentSnapshotId: null,
        serverSavedAt: '2026-09-20T00:00:00.000Z', clientSavedAt: '2026-09-20T00:00:00.000Z',
        deviceId: 'b599cb24-eef1-46cd-b3a5-8a8b76b92288', gameVersion: '0.10.26',
        clientBuild: 'runtime-test', payloadHash: await hashPayload(payload), payload,
    };
}

test('native workerd fetch can check, create and read a GitHub save without a fetch stub', async (context) => {
    const envelope = await sampleEnvelope();
    let saved: string | null = null;
    const visited: Array<{ url: string; method: string }> = [];
    // Intercept only at the runtime's outbound boundary. GithubStore uses the real workerd fetch.
    const mf = runtime(async (request) => {
        visited.push({ url: request.url, method: request.method });
        assert.equal(request.headers.get('authorization'), 'Bearer ' + fakeToken);
        assert.equal(request.headers.get('x-github-api-version'), '2022-11-28');
        assert.equal(request.headers.get('user-agent'), 'pokeclicker-private-cloud-save');
        if (request.url === apiRoot + '/branches/' + encodeURIComponent(branch) && request.method === 'GET') {
            return MiniflareResponse.json({ name: branch, commit: { sha: commitSha } });
        }
        if (request.url === apiRoot + contentsPath + '?ref=' + encodeURIComponent(branch) && request.method === 'GET') {
            return saved === null ? MiniflareResponse.json({}, { status: 404 }) : MiniflareResponse.json({
                type: 'file', sha: blobSha, size: Buffer.byteLength(saved), encoding: 'base64', content: Buffer.from(saved).toString('base64'),
            });
        }
        if (request.url === apiRoot + contentsPath && request.method === 'PUT') {
            const body = await request.json() as { branch: string; content: string; sha?: string };
            assert.equal(body.branch, branch);
            assert.equal(body.sha, undefined);
            saved = Buffer.from(body.content, 'base64').toString('utf8');
            assert.deepEqual(JSON.parse(saved), envelope);
            return MiniflareResponse.json({ content: { sha: blobSha }, commit: { sha: commitSha } }, { status: 201 });
        }
        throw new Error('Unexpected outbound request: ' + request.method + ' ' + request.url);
    });
    context.after(() => mf.dispose());

    const available = await mf.dispatchFetch('https://runtime.test/available');
    const availability = await available.json();
    assert.equal(available.status, 200, JSON.stringify(availability));
    assert.deepEqual(availability, { available: true });

    const empty = await mf.dispatchFetch('https://runtime.test/read');
    assert.equal(empty.status, 200);
    assert.equal(await empty.json(), null);

    const created = await mf.dispatchFetch('https://runtime.test/write', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ envelope, sha: null }),
    });
    assert.equal(created.status, 200);
    assert.deepEqual(await created.json(), { blobSha, commitSha });

    const restored = await mf.dispatchFetch('https://runtime.test/read');
    assert.equal(restored.status, 200);
    assert.deepEqual(await restored.json(), { blobSha, envelope });
    assert.deepEqual(visited, [
        { url: apiRoot + '/branches/' + encodeURIComponent(branch), method: 'GET' },
        { url: apiRoot + contentsPath + '?ref=' + encodeURIComponent(branch), method: 'GET' },
        { url: apiRoot + '/branches/' + encodeURIComponent(branch), method: 'GET' },
        { url: apiRoot + contentsPath, method: 'PUT' },
        { url: apiRoot + contentsPath + '?ref=' + encodeURIComponent(branch), method: 'GET' },
    ]);
});

test('native workerd fetch rejects redirects without forwarding the GitHub token', async (context) => {
    let redirectStatus = 301;
    const visited: Array<{ url: string; authorization: string | null }> = [];
    const mf = runtime(async (request) => {
        visited.push({ url: request.url, authorization: request.headers.get('authorization') });
        // There is no live network fallback, including for the redirect destination.
        return new MiniflareResponse(null, { status: redirectStatus, headers: { Location: 'https://untrusted.example/receive-token' } });
    });
    context.after(() => mf.dispose());
    const envelope = await sampleEnvelope();
    for (const status of [301, 302, 303, 307, 308]) {
        redirectStatus = status;
        for (const operation of ['available', 'read', 'write']) {
            visited.length = 0;
            const response = await mf.dispatchFetch('https://runtime.test/' + operation, operation === 'write' ? {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ envelope, sha: null }),
            } : undefined);
            const body = await response.text();
            assert.equal(response.status, 503, operation + ' must reject HTTP ' + status);
            assert.equal(JSON.parse(body).code, 'GITHUB_REDIRECT');
            assert.equal(body.includes(fakeToken), false);
            assert.equal(visited.length, 1, operation + ' must send one GitHub request and never follow HTTP ' + status);
            assert.ok(visited[0].url.startsWith(apiRoot + '/'));
            assert.equal(visited[0].authorization, 'Bearer ' + fakeToken);
        }
    }
});
