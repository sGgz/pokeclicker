import { isRecord, isUuid, MAX_SAVE_BYTES, validateRemote } from './protocol';
import type { RemoteSave, UploadRequest } from './protocol';

export class CloudApiError extends Error {
    constructor(
        public status: number,
        public code: string,
        message: string,
        public remote: RemoteSave | null = null,
        public retryAfter = 60,
    ) {
        super(message);
    }
}

export interface SaveApi {
    read(slotId: string): Promise<RemoteSave | null>;
    upload(slotId: string, request: UploadRequest): Promise<RemoteSave>;
}

export default class CloudApi implements SaveApi {
    private async request(path: string, init: RequestInit = {}): Promise<unknown> {
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 30000);
        try {
            const response = await fetch('/api/cloud-save' + path, {
                ...init, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
            });
            if (!response.headers.get('Content-Type')?.includes('application/json')) {
                throw new CloudApiError(response.status, 'LOGIN_REQUIRED', '云服务尚未启用或登录已过期。部署后请刷新页面重新登录。');
            }
            const text = await response.text();
            if (text.length > MAX_SAVE_BYTES * 2) {
                throw new Error('云端响应过大。');
            }
            const data = JSON.parse(text);
            if (!response.ok) {
                throw new CloudApiError(response.status, data.code, data.message || '云同步失败。', data.remote ?? null, Number(response.headers.get('Retry-After')) || 60);
            }
            return data;
        } catch (error) {
            if (error instanceof CloudApiError) {
                throw error;
            }
            throw new CloudApiError(0, 'NETWORK', '连接云存档失败，本地进度仍保留。请检查网络或刷新页面重新登录。');
        } finally {
            window.clearTimeout(timeout);
        }
    }

    async status(): Promise<string> {
        const value = await this.request('/status');
        if (!isRecord(value) || !isUuid(value.slotId)) {
            throw new Error('云存档配置无效。');
        }
        return value.slotId;
    }

    async read(slotId: string): Promise<RemoteSave | null> {
        try {
            return await validateRemote(await this.request('/slots/' + slotId), slotId);
        } catch (error) {
            if (error instanceof CloudApiError && error.code === 'EMPTY_SLOT') {
                return null;
            }
            throw error;
        }
    }

    async upload(slotId: string, request: UploadRequest): Promise<RemoteSave> {
        try {
            return await validateRemote(await this.request('/slots/' + slotId, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
            }), slotId);
        } catch (error) {
            if (error instanceof CloudApiError && error.status === 409 && error.remote) {
                error.remote = await validateRemote(error.remote, slotId);
            }
            throw error;
        }
    }
}
