'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const COOKIE_NAME = '__Host-pokeclicker_session';
const MAX_BODY_BYTES = 5 * 1024 * 1024 + 4096;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const SLOT_PATH = /^\/api\/cloud-save\/slots\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const MEMORY_MESSAGE = '已登录。本机无法安全保存登录凭据，本次只保存在内存中；关闭客户端后需要重新登录。';

function errorResponse(status, code, message) {
    return { status, body: JSON.stringify({ code, message }) };
}

function validToken(value) {
    return typeof value === 'string' && value.length < 2048
        && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

function sessionFromResponse(response) {
    const cookies = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie')].filter(Boolean);
    if (cookies.length !== 1 || cookies[0].length > 4096 || /[\r\n]/.test(cookies[0])) return null;
    const [pair, ...attributes] = cookies[0].split(';').map(value => value.trim());
    if (!pair.startsWith(COOKIE_NAME + '=')) return null;
    const token = pair.slice(COOKIE_NAME.length + 1);
    if (!validToken(token)) return null;
    const parsed = new Map();
    for (const attribute of attributes) {
        const separator = attribute.indexOf('=');
        const name = (separator < 0 ? attribute : attribute.slice(0, separator)).toLowerCase();
        const value = separator < 0 ? '' : attribute.slice(separator + 1);
        if (!name || parsed.has(name)) return null;
        parsed.set(name, value);
    }
    if (parsed.has('domain') || parsed.get('path') !== '/' || parsed.get('secure') !== ''
        || parsed.get('httponly') !== '' || parsed.get('samesite')?.toLowerCase() !== 'strict'
        || !/^[1-9]\d*$/.test(parsed.get('max-age') || '')
        || Number(parsed.get('max-age')) > 7 * 24 * 60 * 60) return null;
    return token;
}

function allowedRequest(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !['path', 'method', 'body'].includes(key))
        || typeof input.path !== 'string' || typeof input.method !== 'string') return false;
    const { path: requestPath, method, body } = input;
    if (body !== undefined && (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES)) return false;
    if (method === 'GET') return body === undefined && (requestPath === '/api/cloud-save/status' || requestPath === '/api/cloud-save/identity'
        || requestPath === '/api/cloud-save/slots' || SLOT_PATH.test(requestPath));
    if (method === 'POST' && requestPath === '/auth/logout') return body === undefined || body === '{}';
    if (method === 'PUT' && SLOT_PATH.test(requestPath) && typeof body === 'string') {
        try {
            const parsed = JSON.parse(body);
            return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
        } catch { return false; }
    }
    return false;
}

async function cancelBody(response) {
    try { await response.body?.cancel(); } catch { /* Nothing from a remote response is logged. */ }
}

async function readLimited(response, signal) {
    const announced = response.headers.get('content-length');
    if (announced !== null && (!/^\d+$/.test(announced) || Number(announced) > MAX_RESPONSE_BYTES)) {
        await cancelBody(response);
        throw new Error('Invalid response size');
    }
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    const aborted = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', aborted, { once: true });
    try {
        while (true) {
            if (signal.aborted) throw new Error('Request timed out');
            const { done, value } = await reader.read();
            if (signal.aborted) throw new Error('Request timed out');
            if (done) break;
            length += value.byteLength;
            if (length > MAX_RESPONSE_BYTES) {
                await reader.cancel();
                throw new Error('Response too large');
            }
            chunks.push(Buffer.from(value));
        }
        return Buffer.concat(chunks, length).toString('utf8');
    } finally {
        signal.removeEventListener('abort', aborted);
        reader.releaseLock();
    }
}

function createCloudClient({ origin = 'https://play.ggzz.fun', userData, safeStorage, fetcher = (input, init) => globalThis.fetch(input, init) }) {
    const parsedOrigin = new URL(origin);
    if (parsedOrigin.protocol !== 'https:' || parsedOrigin.origin !== origin
        || typeof userData !== 'string' || !path.isAbsolute(userData) || typeof fetcher !== 'function') {
        throw new Error('Invalid desktop cloud configuration');
    }
    const sessionFile = path.join(userData, 'encrypted-session.bin');
    let token = null;
    let generation = 0;
    let storageQueue = Promise.resolve();

    function encryptionAvailable() {
        try {
            return Boolean(safeStorage?.isEncryptionAvailable())
                && safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
        } catch { return false; }
    }

    // Credential operations are ordered so a delayed write cannot undo logout.
    function persist(expectedGeneration, expectedToken) {
        const operation = storageQueue.then(async () => {
            if (generation !== expectedGeneration || token !== expectedToken) return 'stale';
            if (!expectedToken || !encryptionAvailable()) {
                await fs.rm(sessionFile, { force: true });
                return 'removed';
            }
            let temporary;
            try {
                const encrypted = safeStorage.encryptString(expectedToken);
                if (!Buffer.isBuffer(encrypted) || encrypted.byteLength > 16384) throw new Error('Invalid encrypted session');
                await fs.mkdir(userData, { recursive: true });
                temporary = sessionFile + '.' + randomUUID() + '.tmp';
                await fs.writeFile(temporary, encrypted, { flag: 'wx', mode: 0o600 });
                if (generation !== expectedGeneration || token !== expectedToken) return 'stale';
                await fs.rename(temporary, sessionFile);
                temporary = undefined;
                return 'saved';
            } catch {
                // A failed replacement must not leave a previous account/session reusable.
                await fs.rm(sessionFile, { force: true }).catch(() => {});
                return 'failed';
            } finally {
                if (temporary) await fs.rm(temporary, { force: true }).catch(() => {});
            }
        });
        storageQueue = operation.catch(() => {});
        return operation.catch(() => 'failed');
    }

    const ready = (async () => {
        try {
            if (!encryptionAvailable()) return;
            const info = await fs.stat(sessionFile);
            if (!info.isFile() || info.size > 16384) return;
            const restored = safeStorage.decryptString(await fs.readFile(sessionFile));
            if (generation === 0 && validToken(restored)) token = restored;
        } catch { /* Missing or damaged credentials simply require another login. */ }
    })();

    async function perform(requestPath, init, consume) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        timeout.unref?.();
        try {
            const response = await fetcher(origin + requestPath, {
                ...init, redirect: 'manual', cache: 'no-store', signal: controller.signal,
            });
            return await consume(response, controller.signal);
        } finally { clearTimeout(timeout); }
    }

    async function login(password) {
        if (typeof password !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(password)) {
            return { ok: false, message: '请完整粘贴 32 个字符的游戏专用密码。' };
        }
        const attempt = ++generation;
        await ready;
        try {
            const result = await perform('/auth/login', {
                method: 'POST',
                headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ password, returnTo: '/' }).toString(),
            }, async response => {
                await cancelBody(response);
                if (response.status === 401) return { ok: false, message: '密码不正确，请重新粘贴游戏专用密码。' };
                if (response.status === 429) return { ok: false, message: '登录尝试过多，请至少等 60 秒再试。' };
                if (response.status !== 303 || response.headers.get('location') !== '/login?returnTo=%2F') {
                    return { ok: false, message: '云端没有确认登录，请稍后重试。' };
                }
                const session = sessionFromResponse(response);
                return session ? { session } : { ok: false, message: '云端登录凭据无效，请稍后重试。' };
            });
            if (attempt !== generation) return { ok: false, message: '登录操作已取消，请重新登录。' };
            if (!result.session) return result;
            token = result.session;
            const saved = await persist(attempt, token);
            if (attempt !== generation) return { ok: false, message: '登录操作已取消，请重新登录。' };
            return saved === 'saved' ? { ok: true } : { ok: true, message: MEMORY_MESSAGE };
        } catch {
            return { ok: false, message: '无法连接云端，请检查网络后重试。本地游戏可以继续使用。' };
        }
    }

    async function request(input) {
        if (!allowedRequest(input)) return errorResponse(403, 'DESKTOP_REQUEST', '客户端拒绝了不支持的云请求。');
        if (input.path === '/auth/logout') {
            const logoutGeneration = ++generation;
            token = null;
            await ready;
            const cleared = await persist(logoutGeneration, null);
            if (cleared === 'failed') return errorResponse(500, 'DESKTOP_CREDENTIALS', '当前客户端已退出，但未能删除本机保存的登录凭据。请检查用户数据目录权限后重试退出。');
            return { status: 200, body: '{"ok":true}' };
        }
        await ready;
        const activeToken = token;
        const requestGeneration = generation;
        if (!activeToken) return errorResponse(401, 'LOGIN_REQUIRED', '请先输入游戏专用密码登录云存档。');
        try {
            return await perform(input.path, {
                method: input.method,
                headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: COOKIE_NAME + '=' + activeToken },
                ...(input.body === undefined ? {} : { body: input.body }),
            }, async (response, signal) => {
                if (response.status >= 300 && response.status < 400) {
                    await cancelBody(response);
                    return errorResponse(502, 'CLOUD_UNAVAILABLE', '云端返回了不支持的跳转，请重新登录后重试。');
                }
                if (response.status === 401 && generation === requestGeneration && token === activeToken) {
                    token = null;
                    const cleared = ++generation;
                    await persist(cleared, null);
                }
                if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) {
                    await cancelBody(response);
                    return response.status === 401
                        ? errorResponse(401, 'LOGIN_REQUIRED', '游戏登录已过期，请重新输入游戏专用密码。')
                        : errorResponse(502, 'CLOUD_UNAVAILABLE', '云端返回格式无效，本地进度仍保留。');
                }
                const body = await readLimited(response, signal);
                try { JSON.parse(body); } catch { return errorResponse(502, 'CLOUD_UNAVAILABLE', '云端返回格式无效，本地进度仍保留。'); }
                const retryAfter = response.headers.get('retry-after');
                return { status: response.status, body,
                    ...(retryAfter && /^\d{1,6}$/.test(retryAfter) ? { retryAfter } : {}) };
            });
        } catch { return errorResponse(0, 'NETWORK', '连接云存档失败，本地进度仍保留。请检查网络后重试。'); }
    }

    return { login, request };
}

module.exports = { createCloudClient };
