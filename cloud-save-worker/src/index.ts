import { verifyAccess, type AuthConfig } from './auth';
import { ApiError, GithubStore, readLimited, type GithubConfig } from './github';
import {
    MAX_SAVE_BYTES, compareVersions, hashPayload, isBlobSha, isRecord, isUuid, payloadVersion, validatePayload,
    type CloudSaveEnvelope, type RemoteSave, type UploadRequest,
} from '../../src/modules/cloudSave/protocol';

export interface Env extends AuthConfig, GithubConfig {
    ALLOWED_ORIGIN: string;
    ASSETS: { fetch(request: Request): Promise<Response> };
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
        || !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_TEAM_DOMAIN || '')
        || !env.ACCESS_AUD || !env.ALLOWED_EMAIL
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

// Dependency injection is for tests; the deployed handler always uses real JWT verification and GitHub.
export function createHandler(dependencies: {
    authenticate?: typeof verifyAccess;
    store?: (env: Env) => Store;
    now?: () => number;
} = {}) {
    return async (request: Request, env: Env): Promise<Response> => {
        const url = new URL(request.url);
        if (!url.pathname.startsWith('/api/')) {
            return env.ASSETS.fetch(request);
        }
        try {
            checkConfig(env);
            if (url.origin !== env.ALLOWED_ORIGIN) {
                throw new ApiError(403, 'ORIGIN', '请使用操作手册配置的游戏域名。');
            }
            const token = request.headers.get('Cf-Access-Jwt-Assertion');
            if (!token) {
                throw new ApiError(401, 'LOGIN_REQUIRED', '请刷新页面，使用允许的邮箱重新登录。');
            }
            try {
                await (dependencies.authenticate || verifyAccess)(token, env);
            } catch {
                throw new ApiError(403, 'ACCESS_DENIED', '登录已过期或此邮箱无权访问，请重新登录。');
            }
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
            const now = (dependencies.now || Date.now)();
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
