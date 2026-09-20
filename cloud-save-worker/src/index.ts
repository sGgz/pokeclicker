import { clearSessionCookie, createSessionCookie, parseAuth, sessionToken, verifyPassword, verifySession, type AuthConfig } from './auth';
import { loginPage, returnPath } from './login';
import { ApiError, GithubStore, readLimited, type GithubConfig } from './github';
import {
    MAX_SAVE_BYTES, compareVersions, hashPayload, isBlobSha, isRecord, isUuid, payloadVersion, validatePayload,
    type CloudSaveEnvelope, type RemoteSave, type UploadRequest,
} from '../../src/modules/cloudSave/protocol';

export interface Env extends AuthConfig, GithubConfig {
    ALLOWED_ORIGIN: string;
    ASSETS: { fetch(request: Request): Promise<Response> };
    LOGIN_RATE_LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> };
    LOGIN_GLOBAL_LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

interface Store {
    read(): Promise<RemoteSave | null>;
    assertAvailable(): Promise<void>;
    write(envelope: CloudSaveEnvelope, sha: string | null): Promise<{ blobSha: string; commitSha: string }>;
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'private, no-store',
            'X-Content-Type-Options': 'nosniff',
            ...headers,
        },
    });
}

function checkConfig(env: Env): void {
    if (!/^[\w.-]+$/.test(env.GITHUB_OWNER || '') || !/^[\w.-]+$/.test(env.GITHUB_SAVE_REPO || '')
        || !env.GITHUB_SAVE_BRANCH || !env.GITHUB_SAVE_TOKEN || !isUuid(env.CLOUD_SLOT_ID)
        || !/^https:\/\/[^/?#]+$/.test(env.ALLOWED_ORIGIN || '')) {
        throw new ApiError(503, 'CONFIGURATION', '云存档尚未配置完成，请按操作手册填写 Cloudflare 变量和 Secret。');
    }
}

function validateUpload(value: unknown): asserts value is UploadRequest {
    if (!isRecord(value) || !(value.baseBlobSha === null || isBlobSha(value.baseBlobSha))
        || !Number.isSafeInteger(value.baseRevision) || (value.baseRevision as number) < 0
        || (value.baseBlobSha === null) !== (value.baseRevision === 0)
        || !isUuid(value.snapshotId) || !isUuid(value.deviceId)
        || typeof value.clientSavedAt !== 'string' || !Number.isFinite(Date.parse(value.clientSavedAt))
        || typeof value.clientBuild !== 'string' || value.clientBuild.length > 100) {
        throw new ApiError(422, 'INVALID_REQUEST', '同步请求格式无效，请更新游戏。');
    }
    try {
        validatePayload(value.payload);
    } catch (error) {
        throw new ApiError(422, 'INVALID_SAVE', error instanceof Error ? error.message : '存档无效。');
    }
}

function sameRequest(remote: RemoteSave | null, request: UploadRequest, hash: string): boolean {
    return remote?.envelope.snapshotId === request.snapshotId && remote.envelope.payloadHash === hash;
}

function sameOrigin(request: Request, env: Env): void {
    if (request.headers.get('Origin') !== env.ALLOWED_ORIGIN || request.headers.get('Sec-Fetch-Site') === 'cross-site') {
        throw new ApiError(403, 'ORIGIN', '已阻止来源不明的请求，请从游戏页面操作。');
    }
}

function redirect(location: string, cookie?: string): Response {
    return new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'private, no-store', ...(cookie ? { 'Set-Cookie': cookie } : {}) } });
}

// Dependency injection is for tests; the deployed handler verifies the signed session before assets and APIs.
export function createHandler(dependencies: {
    authenticate?: typeof verifySession;
    store?: (env: Env) => Store;
    now?: () => number;
} = {}) {
    return async (request: Request, env: Env): Promise<Response> => {
        const url = new URL(request.url);
        const apiRequest = url.pathname === '/api' || url.pathname.startsWith('/api/');
        const now = (dependencies.now || Date.now)();
        try {
            if (!/^https:\/\/[^/?#]+$/.test(env.ALLOWED_ORIGIN || '')) {
                throw new ApiError(503, 'CONFIGURATION', '游戏域名尚未配置，请运行 npm run cloud:setup 后重新部署。');
            }
            if (url.origin !== env.ALLOWED_ORIGIN) {
                throw new ApiError(403, 'ORIGIN', '请使用操作手册配置的游戏域名。');
            }
            parseAuth(env);
            if (url.pathname === '/auth/logout') {
                if (request.method !== 'POST') return json({ code: 'METHOD', message: '请使用退出登录按钮。' }, 405, { Allow: 'POST' });
                sameOrigin(request, env);
                return request.headers.get('Content-Type')?.split(';')[0].trim() === 'application/json'
                    ? json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() })
                    : redirect('/login', clearSessionCookie());
            }
            if (url.pathname === '/auth/login') {
                if (request.method !== 'POST') return json({ code: 'METHOD', message: '请在登录页输入游戏密码。' }, 405, { Allow: 'POST' });
                sameOrigin(request, env);
                if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/x-www-form-urlencoded') {
                    throw new ApiError(415, 'CONTENT_TYPE', '请使用游戏登录页面提交密码。');
                }
                // The binding counters live outside this isolate; absent/broken bindings must fail closed.
                if (!env.LOGIN_RATE_LIMITER?.limit || !env.LOGIN_GLOBAL_LIMITER?.limit) {
                    throw new ApiError(503, 'AUTH_CONFIGURATION', '登录保护尚未配置，请重新运行配置向导并部署。');
                }
                const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
                const perIp = await env.LOGIN_RATE_LIMITER.limit({ key: env.ALLOWED_ORIGIN + ':' + ip });
                const total = perIp.success && await env.LOGIN_GLOBAL_LIMITER.limit({ key: env.ALLOWED_ORIGIN });
                if (!perIp.success || !total || !total.success) {
                    const response = loginPage({ returnTo: '/', message: '登录尝试过多，请至少等 60 秒再试。', status: 429 });
                    response.headers.set('Retry-After', '60');
                    return response;
                }
                const form = new URLSearchParams(await readLimited(request, 4096));
                const target = returnPath(form.get('returnTo'), env.ALLOWED_ORIGIN);
                if (form.getAll('password').length !== 1 || !await verifyPassword(form.get('password') || '', env)) {
                    return loginPage({ returnTo: target, message: '密码不正确，请重新粘贴游戏专用密码。', status: 401 });
                }
                return redirect('/login?returnTo=' + encodeURIComponent(target), await createSessionCookie(env, env.ALLOWED_ORIGIN, now));
            }
            const token = sessionToken(request);
            let loggedIn = false;
            if (token) {
                try {
                    await (dependencies.authenticate || verifySession)(token, env, env.ALLOWED_ORIGIN, now);
                    loggedIn = true;
                } catch { /* Invalid/expired cookies never authorize assets or API calls. */ }
            }
            if (url.pathname === '/login' && (request.method === 'GET' || request.method === 'HEAD')) {
                const page = loginPage({ returnTo: returnPath(url.searchParams.get('returnTo'), env.ALLOWED_ORIGIN), loggedIn });
                return request.method === 'HEAD' ? new Response(null, { headers: page.headers }) : page;
            }
            if (!loggedIn) {
                if (apiRequest) throw new ApiError(401, 'LOGIN_REQUIRED', '登录已过期，请点击“重新登录”，在新标签页输入游戏密码后回到本页重试。');
                return redirect('/login?returnTo=' + encodeURIComponent(returnPath(url.pathname + url.search, env.ALLOWED_ORIGIN)));
            }
            if (!apiRequest) {
                if (request.method !== 'GET' && request.method !== 'HEAD') return json({ code: 'METHOD', message: '不支持此操作。' }, 405, { Allow: 'GET, HEAD' });
                const asset = await env.ASSETS.fetch(request);
                const response = new Response(asset.body, asset);
                response.headers.set('Cache-Control', 'private, no-store');
                response.headers.set('X-Content-Type-Options', 'nosniff');
                response.headers.set('X-Frame-Options', 'DENY');
                response.headers.set('Referrer-Policy', 'same-origin');
                return response;
            }
            checkConfig(env);
            const store = dependencies.store?.(env) || new GithubStore(env);
            const base = '/api/cloud-save';
            if (url.pathname === base + '/status' && request.method === 'GET') {
                await store.assertAvailable();
                return json({ enabled: true, slotId: env.CLOUD_SLOT_ID, maxSaveBytes: MAX_SAVE_BYTES });
            }
            if (url.pathname === base + '/slots' && request.method === 'GET') {
                return json({ slots: [{ id: env.CLOUD_SLOT_ID, name: '我的云存档' }] });
            }
            if (url.pathname !== base + '/slots/' + env.CLOUD_SLOT_ID) {
                throw new ApiError(404, 'NOT_FOUND', '找不到此接口或存档槽位。');
            }
            if (request.method === 'GET') {
                const remote = await store.read();
                return remote ? json(remote) : json({ code: 'EMPTY_SLOT', message: '尚未上传云存档。' }, 404);
            }
            if (request.method !== 'PUT') {
                return json({ code: 'METHOD', message: '不支持此操作。' }, 405, { Allow: 'GET, PUT' });
            }
            if (request.headers.get('Origin') !== env.ALLOWED_ORIGIN
                || request.headers.get('Sec-Fetch-Site') === 'cross-site'
                || request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') {
                throw new ApiError(403, 'ORIGIN', '已阻止来源不明的写入请求。');
            }
            let upload: unknown;
            try {
                upload = JSON.parse(await readLimited(request, MAX_SAVE_BYTES + 4096));
            } catch (error) {
                if (error instanceof ApiError) {
                    throw error;
                }
                throw new ApiError(422, 'INVALID_JSON', '请求不是有效的 JSON。');
            }
            validateUpload(upload);
            const hash = await hashPayload(upload.payload);
            const current = await store.read();
            if (sameRequest(current, upload, hash)) {
                return json(current);
            }
            if ((current?.blobSha ?? null) !== upload.baseBlobSha || (current?.envelope.revision ?? 0) !== upload.baseRevision) {
                return json({ code: 'CONFLICT', message: '另一台设备已更新云存档，请选择要保留的进度。', remote: current }, 409);
            }
            if (current?.envelope.snapshotId === upload.snapshotId) {
                throw new ApiError(422, 'REUSED_SNAPSHOT', '同一快照编号不能提交不同内容。');
            }
            if (current && compareVersions(payloadVersion(upload.payload), current.envelope.gameVersion) < 0) {
                throw new ApiError(422, 'OLD_CLIENT', '云存档版本较新，请先更新游戏，不能降级覆盖。');
            }
            if (current && now - Date.parse(current.envelope.serverSavedAt) < 15000) {
                throw new ApiError(429, 'RATE_LIMITED', '刚刚完成同步，请等 15 秒再保存。', '15');
            }
            const envelope: CloudSaveEnvelope = {
                schemaVersion: 1,
                slotId: env.CLOUD_SLOT_ID,
                revision: upload.baseRevision + 1,
                snapshotId: upload.snapshotId,
                parentSnapshotId: current?.envelope.snapshotId ?? null,
                serverSavedAt: new Date(now).toISOString(),
                clientSavedAt: upload.clientSavedAt,
                deviceId: upload.deviceId,
                gameVersion: payloadVersion(upload.payload),
                clientBuild: upload.clientBuild,
                payloadHash: hash,
                payload: upload.payload,
            };
            try {
                const receipt = await store.write(envelope, upload.baseBlobSha);
                return json({ ...receipt, envelope }, current ? 200 : 201);
            } catch (error) {
                if (!(error instanceof ApiError) || error.code !== 'WRITE_RACE') {
                    throw error;
                }
                const remote = await store.read();
                if (sameRequest(remote, upload, hash)) {
                    return json(remote);
                }
                if ((remote?.blobSha ?? null) !== upload.baseBlobSha) {
                    return json({ code: 'CONFLICT', message: '云存档刚刚发生更新，已保留两份进度。', remote }, 409);
                }
                // 422 can also mean validation/branch-policy errors, not just stale data.
                throw new ApiError(502, 'GITHUB_WRITE', 'GitHub 拒绝此次更新，请检查仓库分支规则，稍后重试。');
            }
        } catch (error) {
            if (error instanceof ApiError) {
                return json({ code: error.code, message: error.message }, error.status,
                    error.retryAfter ? { 'Retry-After': error.retryAfter } : {});
            }
            return json({ code: 'SERVER_ERROR', message: '云存档服务暂时异常，本地进度未被替换。' }, 503);
        }
    };
}

export default { fetch: createHandler() };
