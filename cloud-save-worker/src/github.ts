import { MAX_SAVE_BYTES, isBlobSha, validateRemote, type CloudSaveEnvelope, type RemoteSave } from '../../src/modules/cloudSave/protocol';

export class ApiError extends Error {
    constructor(public status: number, public code: string, message: string, public retryAfter?: string) {
        super(message);
    }
}

export interface GithubConfig {
    GITHUB_OWNER: string;
    GITHUB_SAVE_REPO: string;
    GITHUB_SAVE_BRANCH: string;
    GITHUB_SAVE_TOKEN: string;
    CLOUD_SLOT_ID: string;
}

export async function readLimited(response: Response | Request, limit: number): Promise<string> {
    if (Number(response.headers.get('content-length')) > limit) {
        throw new ApiError(413, 'TOO_LARGE', '存档超过大小上限。');
    }
    const reader = response.body?.getReader();
    if (!reader) {
        return '';
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) {
                break;
            }
            size += value.byteLength;
            if (size > limit) {
                await reader.cancel();
                throw new ApiError(413, 'TOO_LARGE', '存档超过大小上限。');
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function base64(bytes: Uint8Array): string {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    }
    return btoa(binary);
}

export class GithubStore {
    private root: string;
    private path: string;

    // Workerd requires the native fetch receiver; do not invoke it as a class method.
    constructor(private env: GithubConfig, private fetcher: typeof fetch = (input, init) => fetch(input, init)) {
        this.root = 'https://api.github.com/repos/' + encodeURIComponent(env.GITHUB_OWNER) + '/' + encodeURIComponent(env.GITHUB_SAVE_REPO);
        this.path = '/contents/saves/' + env.CLOUD_SLOT_ID + '.json';
    }

    private async call(path: string, init: RequestInit = {}): Promise<Response> {
        let response: Response;
        try {
            response = await this.fetcher(this.root + path, {
                ...init,
                // Workerd supports manual/follow only. Handle redirects without forwarding the token.
                redirect: 'manual',
                signal: AbortSignal.timeout(20000),
                headers: {
                    Accept: 'application/vnd.github+json',
                    Authorization: 'Bearer ' + this.env.GITHUB_SAVE_TOKEN,
                    'X-GitHub-Api-Version': '2022-11-28',
                    'User-Agent': 'pokeclicker-private-cloud-save',
                    ...init.headers,
                },
            });
        } catch {
            throw new ApiError(503, 'GITHUB_UNAVAILABLE', 'GitHub 暂时无法连接，本地进度仍保留。');
        }
        if (response.status >= 300 && response.status < 400) {
            throw new ApiError(503, 'GITHUB_REDIRECT', '存档仓库地址发生跳转，请核对 GitHub 用户名和仓库名后重新部署。');
        }
        if (response.status === 429 || (response.status === 403
            && (response.headers.has('retry-after') || response.headers.get('x-ratelimit-remaining') === '0'))) {
            const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
            const wait = response.headers.get('retry-after') || String(Math.max(60, Math.ceil((reset - Date.now()) / 1000) || 60));
            throw new ApiError(429, 'RATE_LIMITED', 'GitHub 请求频率受限，请稍后重试。', wait);
        }
        if (response.status === 401 || response.status === 403) {
            throw new ApiError(503, 'GITHUB_AUTH', 'GitHub 凭据失效或权限不足，请按操作手册更新 Worker Secret。');
        }
        if (response.status >= 500) {
            throw new ApiError(503, 'GITHUB_UNAVAILABLE', 'GitHub 暂时不可用，请稍后重试。');
        }
        return response;
    }

    async assertAvailable(): Promise<void> {
        const response = await this.call('/branches/' + encodeURIComponent(this.env.GITHUB_SAVE_BRANCH));
        if (!response.ok) {
            throw new ApiError(503, 'GITHUB_CONFIGURATION', '无法访问存档仓库或分支，请确认私有仓库已初始化且 token 有权限。');
        }
    }

    async read(): Promise<RemoteSave | null> {
        const metadata = await this.call(this.path + '?ref=' + encodeURIComponent(this.env.GITHUB_SAVE_BRANCH));
        if (metadata.status === 404) {
            await this.assertAvailable();
            return null;
        }
        if (!metadata.ok) {
            throw new ApiError(502, 'GITHUB_READ', '读取云存档失败。');
        }
        // Metadata and contents must refer to the same immutable Git object.
        const file = JSON.parse(await readLimited(metadata, MAX_SAVE_BYTES * 2));
        if (file.type !== 'file' || !isBlobSha(file.sha) || file.size > MAX_SAVE_BYTES) {
            throw new ApiError(422, 'INVALID_REMOTE', '云端文件类型或大小不受支持。');
        }
        let json: string;
        if (file.encoding === 'base64' && typeof file.content === 'string') {
            const bytes = Uint8Array.from(atob(file.content.replace(/\s/g, '')), (character) => character.charCodeAt(0));
            json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } else {
            const blob = await this.call('/git/blobs/' + file.sha, { headers: { Accept: 'application/vnd.github.raw+json' } });
            if (!blob.ok) {
                throw new ApiError(502, 'GITHUB_READ', '读取完整云存档失败。');
            }
            json = await readLimited(blob, MAX_SAVE_BYTES);
        }
        try {
            return await validateRemote({ blobSha: file.sha, envelope: JSON.parse(json) }, this.env.CLOUD_SLOT_ID);
        } catch {
            throw new ApiError(422, 'INVALID_REMOTE', '云端存档校验失败，已保留本地进度。请下载 GitHub 历史备份。');
        }
    }

    async write(envelope: CloudSaveEnvelope, sha: string | null): Promise<{ blobSha: string; commitSha: string }> {
        const json = JSON.stringify(envelope);
        const bytes = new TextEncoder().encode(json);
        if (bytes.byteLength > MAX_SAVE_BYTES) {
            throw new ApiError(413, 'TOO_LARGE', '完整存档超过 5 MiB，请下载本地备份。');
        }
        const response = await this.call(this.path, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: 'Save revision ' + envelope.revision + ' (' + envelope.snapshotId + ')',
                content: base64(bytes),
                branch: this.env.GITHUB_SAVE_BRANCH,
                ...(sha ? { sha } : {}),
            }),
        });
        if (response.status === 409 || response.status === 422) {
            throw new ApiError(409, 'WRITE_RACE', '云端发生并发更新，请检查冲突。');
        }
        if (!response.ok) {
            throw new ApiError(502, 'GITHUB_WRITE', 'GitHub 拒绝保存，请检查分支权限。');
        }
        const result = await response.json() as { content?: { sha?: string }; commit?: { sha?: string } };
        if (!isBlobSha(result.content?.sha) || !isBlobSha(result.commit?.sha)) {
            throw new ApiError(502, 'UNKNOWN_RESULT', '保存结果待确认，请重试相同快照。');
        }
        return { blobSha: result.content.sha, commitSha: result.commit.sha };
    }
}
