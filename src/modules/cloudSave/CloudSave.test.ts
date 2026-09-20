/* eslint-disable dot-notation, @typescript-eslint/dot-notation -- 单例测试通过括号访问私有状态，避免放宽生产代码的访问权限。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CloudApi, { CloudApiError } from './api';
import CloudSave from './CloudSave';
import { SyncEngine } from './SyncEngine';
import { emptyState, type StateStorage } from './storage';
import Notifier from '../notifications/Notifier';
import type { DesktopBridge } from './desktop';

vi.mock('../notifications/Notifier', () => ({ default: { confirm: vi.fn() } }));
vi.mock('../SaveSelector', () => ({ default: { MAX_SAVES: 9 } }));
vi.mock('../settings', () => ({ default: { getSetting: () => ({ value: false }) } }));

const slot = '66cf8d51-2bac-4a66-a608-5f08a77ed50a';

function installDesktop(): DesktopBridge {
    const desktop: DesktopBridge = {
        version: 1,
        cloudRequest: vi.fn().mockResolvedValue({ status: 200, body: '{"ok":true}' }),
        login: vi.fn().mockResolvedValue({ ok: true }),
        onBeforeClose: vi.fn(),
    };
    vi.stubGlobal('pokeclickerDesktop', desktop);
    return desktop;
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('password session API', () => {
    it('reports expiration without navigating or refreshing the active game', async () => {
        const navigate = vi.fn();
        const reload = vi.fn();
        vi.stubGlobal('location', { assign: navigate, reload });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'LOGIN_REQUIRED' }), {
            status: 401, headers: { 'Content-Type': 'application/json' },
        })));
        await expect(new CloudApi().status()).rejects.toMatchObject({
            code: 'LOGIN_REQUIRED', message: expect.stringContaining('新标签页'),
        });
        expect(navigate).not.toHaveBeenCalled();
        expect(reload).not.toHaveBeenCalled();
    });

    it('sends logout to the session endpoint with cookies and refuses redirects', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}', {
            headers: { 'Content-Type': 'application/json' },
        }));
        vi.stubGlobal('fetch', fetchMock);
        await new CloudApi().logout();
        expect(fetchMock).toHaveBeenCalledWith('/auth/logout', expect.objectContaining({
            method: 'POST', credentials: 'same-origin', redirect: 'error',
            headers: { 'Content-Type': 'application/json' },
        }));
    });

    it('does not treat a local development HTML page as successful login or logout', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>local game</html>', {
            headers: { 'Content-Type': 'text/html' },
        })));
        await expect(new CloudApi().logout()).rejects.toMatchObject({ code: 'CLOUD_UNAVAILABLE' });
    });
});

describe('desktop cloud transport', () => {
    it('uses the restricted bridge without sending credentials through renderer fetch', async () => {
        const desktop = installDesktop();
        vi.mocked(desktop.cloudRequest).mockResolvedValue({ status: 200, body: JSON.stringify({ slotId: slot }) });
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        await expect(new CloudApi().status()).resolves.toBe(slot);
        expect(desktop.cloudRequest).toHaveBeenCalledWith({ path: '/api/cloud-save/status', method: 'GET' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('gives desktop login instructions without navigating on expiration', async () => {
        const desktop = installDesktop();
        vi.mocked(desktop.cloudRequest).mockResolvedValue({ status: 401, body: '{"code":"LOGIN_REQUIRED"}' });
        await expect(new CloudApi().status()).rejects.toMatchObject({
            code: 'LOGIN_REQUIRED', message: expect.stringContaining('登录窗口'),
        });
    });

    it('retains the server retry interval when the bridge returns rate limiting', async () => {
        const desktop = installDesktop();
        vi.mocked(desktop.cloudRequest).mockResolvedValue({ status: 429, body: '{"code":"RATE_LIMITED","message":"稍后重试"}', retryAfter: '97' });
        await expect(new CloudApi().status()).rejects.toMatchObject({ status: 429, code: 'RATE_LIMITED', retryAfter: 97 });
    });

    it('keeps offline logout local to the bridge', async () => {
        const desktop = installDesktop();
        const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
        vi.stubGlobal('fetch', fetchMock);
        await new CloudApi().logout();
        expect(desktop.cloudRequest).toHaveBeenCalledWith({ path: '/auth/logout', method: 'POST', body: '{}' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('explains offline play when the native request fails', async () => {
        const desktop = installDesktop();
        vi.mocked(desktop.cloudRequest).mockRejectedValue(new Error('offline'));
        await expect(new CloudApi().status()).rejects.toMatchObject({ code: 'NETWORK', message: expect.stringContaining('离线游戏') });
    });
});

describe('logout preserves local progress', () => {
    let saveLocal: ReturnType<typeof vi.fn>;
    let stopGame: ReturnType<typeof vi.fn>;
    let navigate: ReturnType<typeof vi.fn>;
    let engine: SyncEngine;

    beforeEach(() => {
        document.body.innerHTML = '<details id="cloud-save-panel"><p id="cloud-save-status"></p><input id="cloud-save-auto" type="checkbox"><button data-cloud-action="logout"></button></details>';
        localStorage.clear();
        const state = emptyState();
        state.autoSync = true;
        engine = new SyncEngine({ saveState: vi.fn().mockResolvedValue(undefined) } as unknown as StateStorage, new CloudApi(), state);
        CloudSave['engine'] = engine;
        CloudSave['initialization'] = Promise.resolve();
        CloudSave['serverSlot'] = slot;
        CloudSave['running'] = true;
        CloudSave['activeKey'] = '';
        CloudSave['busy'] = false;
        CloudSave['blocked'] = '';
        CloudSave['stopped'] = false;
        CloudSave['loginRequired'] = false;
        CloudSave['writer'] = true;
        CloudSave['writerRequest'] = Promise.resolve(true);
        CloudSave['captureQueue'] = Promise.resolve();
        Object.defineProperty(navigator, 'locks', { value: {}, configurable: true });
        saveLocal = vi.fn(() => {
            localStorage.setItem('player', JSON.stringify({ _lastSeen: Date.now() }));
            localStorage.setItem('save', JSON.stringify({ update: { version: '0.10.26' }, progress: 123 }));
            localStorage.setItem('settings', '{}');
        });
        stopGame = vi.fn();
        navigate = vi.fn();
        vi.stubGlobal('Save', { store: saveLocal });
        vi.stubGlobal('player', { _lastSeen: 0 });
        vi.stubGlobal('App', { game: { stop: stopGame } });
        vi.stubGlobal('location', { assign: navigate });
        vi.mocked(Notifier.confirm).mockResolvedValue(true);
    });

    it('waits for confirmation, saves locally, pauses and only then leaves after server success', async () => {
        const logout = vi.spyOn(CloudApi.prototype, 'logout').mockImplementation(async () => {
            expect(localStorage.getItem('save')).toContain('123');
            expect(stopGame).not.toHaveBeenCalled();
        });
        await CloudSave['action']('logout');
        expect(logout).toHaveBeenCalledOnce();
        expect(saveLocal).toHaveBeenCalledTimes(2);
        expect(engine.state.autoSync).toBe(false);
        expect(stopGame).toHaveBeenCalledOnce();
        expect(navigate).toHaveBeenCalledWith('/login');
    });

    it('keeps the game running and the latest local save when logout fails', async () => {
        vi.spyOn(CloudApi.prototype, 'logout').mockRejectedValue(new CloudApiError(0, 'NETWORK', 'network unavailable'));
        await CloudSave['action']('logout');
        expect(localStorage.getItem('save')).toContain('123');
        expect(engine.state.autoSync).toBe(false);
        expect(CloudSave.canSave()).toBe(true);
        expect(stopGame).not.toHaveBeenCalled();
        expect(navigate).not.toHaveBeenCalled();
        expect(document.getElementById('cloud-save-status').textContent).toContain('network unavailable');
    });

    it('does not log out or leave when the local save fails', async () => {
        saveLocal.mockImplementation(() => { throw new Error('storage unavailable'); });
        const logout = vi.spyOn(CloudApi.prototype, 'logout');
        await CloudSave['action']('logout');
        expect(logout).not.toHaveBeenCalled();
        expect(stopGame).not.toHaveBeenCalled();
        expect(navigate).not.toHaveBeenCalled();
    });

    it('keeps the page if the final local save fails after the server cleared the session', async () => {
        vi.spyOn(CloudApi.prototype, 'logout').mockResolvedValue(undefined);
        saveLocal.mockImplementationOnce(() => {
            localStorage.setItem('player', '{}');
            localStorage.setItem('save', JSON.stringify({ update: { version: '0.10.26' }, progress: 123 }));
            localStorage.setItem('settings', '{}');
        }).mockImplementationOnce(() => { throw new Error('storage unavailable'); });
        await CloudSave['action']('logout');
        expect(localStorage.getItem('save')).toContain('123');
        expect(stopGame).not.toHaveBeenCalled();
        expect(navigate).not.toHaveBeenCalled();
    });

    it('does not contact logout when cloud service has never been verified', async () => {
        CloudSave['serverSlot'] = null;
        const logout = vi.spyOn(CloudApi.prototype, 'logout');
        await CloudSave['action']('logout');
        expect(logout).not.toHaveBeenCalled();
        expect(navigate).not.toHaveBeenCalled();
        expect(document.querySelector<HTMLButtonElement>('[data-cloud-action="logout"]').disabled).toBe(true);
    });

    it('cancel leaves both the session and automatic sync intact', async () => {
        vi.mocked(Notifier.confirm).mockResolvedValue(false);
        const logout = vi.spyOn(CloudApi.prototype, 'logout');
        await CloudSave['action']('logout');
        expect(logout).not.toHaveBeenCalled();
        expect(saveLocal).not.toHaveBeenCalled();
        expect(engine.state.autoSync).toBe(true);
        expect(navigate).not.toHaveBeenCalled();
    });

    it('pauses automatic retries on expiration until a connection check succeeds', async () => {
        const status = vi.spyOn(CloudApi.prototype, 'status').mockRejectedValue(new CloudApiError(401, 'LOGIN_REQUIRED', 'please sign in'));
        await CloudSave['action']('check');
        expect(CloudSave['loginRequired']).toBe(true);
        expect(navigate).not.toHaveBeenCalled();
        status.mockResolvedValue(slot);
        await CloudSave['action']('check');
        expect(CloudSave['loginRequired']).toBe(false);
        expect(CloudSave.canSave()).toBe(true);
    });

    describe('desktop lifecycle', () => {
        let desktop: DesktopBridge;

        beforeEach(() => {
            desktop = installDesktop();
        });

        it('clears login offline without a verified server and keeps the local game running', async () => {
            CloudSave['serverSlot'] = null;
            const upload = vi.spyOn(CloudApi.prototype, 'upload');
            await CloudSave['action']('logout');
            expect(desktop.cloudRequest).toHaveBeenCalledWith({ path: '/auth/logout', method: 'POST', body: '{}' });
            expect(saveLocal).toHaveBeenCalledOnce();
            expect(localStorage.getItem('save')).toContain('123');
            expect(engine.state.autoSync).toBe(false);
            expect(CloudSave['loginRequired']).toBe(true);
            expect(CloudSave.canSave()).toBe(true);
            expect(stopGame).not.toHaveBeenCalled();
            expect(navigate).not.toHaveBeenCalled();
            expect(upload).not.toHaveBeenCalled();
        });

        it('uses a separate login window and then verifies the cloud slot without reloading', async () => {
            CloudSave['loginRequired'] = true;
            vi.mocked(desktop.cloudRequest).mockResolvedValue({ status: 200, body: JSON.stringify({ slotId: slot }) });
            await CloudSave['action']('login');
            expect(desktop.login).toHaveBeenCalledOnce();
            expect(desktop.cloudRequest).toHaveBeenCalledWith({ path: '/api/cloud-save/status', method: 'GET' });
            expect(CloudSave['loginRequired']).toBe(false);
            expect(saveLocal).not.toHaveBeenCalled();
            expect(stopGame).not.toHaveBeenCalled();
            expect(navigate).not.toHaveBeenCalled();
        });

        it('keeps authentication paused and preserves progress when login is cancelled', async () => {
            CloudSave['loginRequired'] = true;
            vi.mocked(desktop.login).mockResolvedValue({ ok: false });
            await CloudSave['action']('login');
            expect(CloudSave['loginRequired']).toBe(true);
            expect(desktop.cloudRequest).not.toHaveBeenCalled();
            expect(stopGame).not.toHaveBeenCalled();
            expect(navigate).not.toHaveBeenCalled();
        });

        it('saves current progress and waits for backup and pending storage before allowing close', async () => {
            let finishCapture: () => void;
            let finishPersistence: () => void;
            CloudSave['captureQueue'] = new Promise<void>((resolve) => { finishCapture = resolve; });
            const wait = vi.spyOn(engine, 'wait').mockImplementation(() => new Promise<void>((resolve) => { finishPersistence = resolve; }));
            const closed = vi.fn();
            const result = CloudSave['beforeDesktopClose']().then((value) => { closed(value); return value; });
            await vi.waitFor(() => expect(saveLocal).toHaveBeenCalledOnce());
            expect(localStorage.getItem('save')).toContain('123');
            expect(wait).not.toHaveBeenCalled();
            expect(closed).not.toHaveBeenCalled();
            finishCapture();
            await vi.waitFor(() => expect(wait).toHaveBeenCalledOnce());
            expect(closed).not.toHaveBeenCalled();
            finishPersistence();
            await expect(result).resolves.toEqual({ ok: true });
            expect(desktop.cloudRequest).not.toHaveBeenCalled();
        });

        it('does not save a second time after sync-and-switch has paused the game', async () => {
            CloudSave['stopped'] = true;
            await expect(CloudSave['beforeDesktopClose']()).resolves.toEqual({ ok: true });
            expect(saveLocal).not.toHaveBeenCalled();
            expect(desktop.cloudRequest).not.toHaveBeenCalled();
        });

        it('refuses to close while an import, login or cloud operation owns the state', async () => {
            CloudSave['busy'] = true;
            await expect(CloudSave['beforeDesktopClose']()).resolves.toMatchObject({ ok: false, message: expect.stringContaining('当前操作') });
            expect(saveLocal).not.toHaveBeenCalled();
            expect(CloudSave['busy']).toBe(true);
        });

        it('refuses to close if the latest local save fails', async () => {
            saveLocal.mockImplementation(() => { throw new Error('storage unavailable'); });
            await expect(CloudSave['beforeDesktopClose']()).resolves.toEqual({ ok: false, message: 'storage unavailable' });
            expect(CloudSave.canSave()).toBe(true);
            expect(CloudSave['busy']).toBe(false);
            expect(stopGame).not.toHaveBeenCalled();
            expect(desktop.cloudRequest).not.toHaveBeenCalled();
        });

        it('refuses to close if snapshot capture reported a backup failure', async () => {
            CloudSave['captureQueue'] = Promise.resolve().then(() => CloudSave.blockUploads('backup unavailable'));
            await expect(CloudSave['beforeDesktopClose']()).resolves.toMatchObject({ ok: false, message: expect.stringContaining('导出本地备份') });
            expect(CloudSave['busy']).toBe(false);
            expect(desktop.cloudRequest).not.toHaveBeenCalled();
        });
    });
});
