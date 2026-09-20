/* eslint-disable dot-notation, @typescript-eslint/dot-notation -- 单例测试通过括号访问私有状态，避免放宽生产代码的访问权限。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CloudApi, { CloudApiError } from './api';
import CloudSave from './CloudSave';
import { SyncEngine } from './SyncEngine';
import { emptyState, type StateStorage } from './storage';
import Notifier from '../notifications/Notifier';

vi.mock('../notifications/Notifier', () => ({ default: { confirm: vi.fn() } }));
vi.mock('../SaveSelector', () => ({ default: { MAX_SAVES: 9 } }));
vi.mock('../settings', () => ({ default: { getSetting: () => ({ value: false }) } }));

const slot = '66cf8d51-2bac-4a66-a608-5f08a77ed50a';

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
});
