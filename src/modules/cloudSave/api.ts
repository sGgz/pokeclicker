import { isRecord, isUuid, MAX_SAVE_BYTES, validateRemote } from './protocol';
import type { RemoteSave, UploadRequest } from './protocol';
import { desktopBridge } from './desktop';

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
            const desktop = desktopBridge();
            let response: Response;
            if (desktop) {
                const result = await desktop.cloudRequest({
                    path, method: (init.method || 'GET') as 'GET' | 'PUT' | 'POST',
                    ...(typeof init.body === 'string' ? { body: init.body } : {}),
                });
                response = new Response(result.body, {
                    status: result.status,
                    headers: { 'Content-Type': 'application/json', 'Retry-After': result.retryAfter || '' },
                });
            } else {
                response = await fetch(path, {
                    ...init, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
                });
            }
            if (!response.headers.get('Content-Type')?.includes('application/json')) {
                throw new CloudApiError(response.status, 'CLOUD_UNAVAILABLE', '此地址未启用云存档或服务返回了异常页面，本地游戏可继续使用。');
            }
            const text = await response.text();
            if (text.length > MAX_SAVE_BYTES * 2) {
                throw new Error('云端响应过大。');
            }
            const data = JSON.parse(text);
            if (!response.ok) {
                const message = response.status === 401 && data.code === 'LOGIN_REQUIRED'
                    ? desktop
                        ? '云存档尚未登录或登录已过期。请点“登录云存档”，在登录窗口输入游戏密码；当前本地游戏会保留。'
                        : '游戏登录已过期。请点“重新登录”，在新标签页输入游戏密码，再回到本页检查连接；不要刷新当前游戏。'
                    : data.message || '云同步失败。';
                throw new CloudApiError(response.status, data.code, message, data.remote ?? null, Number(response.headers.get('Retry-After')) || 60);
            }
            return data;
        } catch (error) {
            if (error instanceof CloudApiError) {
                throw error;
            }
            throw new CloudApiError(0, 'NETWORK', desktopBridge()
                ? '连接云存档失败，本地进度仍保留，可以继续离线游戏。联网后请检查连接；需要登录时点“登录云存档”。'
                : '连接云存档失败，本地进度仍保留。请检查网络后重试；如需重新登录，请在新标签页完成，不要刷新当前游戏。');
        } finally {
            window.clearTimeout(timeout);
        }
    }

    async status(): Promise<string> {
        const value = await this.request('/api/cloud-save/status');
        if (!isRecord(value) || !isUuid(value.slotId)) {
            throw new Error('云存档配置无效。');
        }
        return value.slotId;
    }

    async logout(): Promise<void> {
        const value = await this.request('/auth/logout', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        if (!isRecord(value) || value.ok !== true) {
            throw new Error('未能确认退出登录，请保留当前页面并重试。');
        }
    }

    async read(slotId: string): Promise<RemoteSave | null> {
        try {
            return await validateRemote(await this.request('/api/cloud-save/slots/' + slotId), slotId);
        } catch (error) {
            if (error instanceof CloudApiError && error.code === 'EMPTY_SLOT') {
                return null;
            }
            throw error;
        }
    }

    async upload(slotId: string, request: UploadRequest): Promise<RemoteSave> {
        try {
            return await validateRemote(await this.request('/api/cloud-save/slots/' + slotId, {
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
