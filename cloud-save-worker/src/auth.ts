import { SignJWT, jwtVerify } from 'jose';
import { ApiError } from './github';

export interface AuthConfig {
    GAME_AUTH: string;
}

export interface PasswordSecret {
    version: 1;
    passwordHash: string;
    sessionKey: string;
}

export const SESSION_COOKIE = '__Host-pokeclicker_session';
export const SESSION_SECONDS = 7 * 24 * 60 * 60;
const encoder = new TextEncoder();
let cachedSecret: { raw: string; value: PasswordSecret } | undefined;

export function parseAuth(config: AuthConfig): PasswordSecret {
    if (cachedSecret && cachedSecret.raw === config.GAME_AUTH) return cachedSecret.value;
    try {
        const value = JSON.parse(config.GAME_AUTH);
        if (value?.version !== 1 || !/^[a-f0-9]{64}$/.test(value.passwordHash)
            || !/^[A-Za-z0-9_-]{43}$/.test(value.sessionKey)) throw new Error('Invalid secret');
        cachedSecret = { raw: config.GAME_AUTH, value };
        return value;
    } catch {
        throw new ApiError(503, 'AUTH_CONFIGURATION', '游戏密码尚未设置，请在部署电脑运行 npm run cloud:password。');
    }
}

// Only for the setup tool's 192-bit random passwords, NOT for human-chosen passwords.
export async function verifyPassword(password: string, config: AuthConfig): Promise<boolean> {
    const auth = parseAuth(config);
    if (!/^[A-Za-z0-9_-]{32}$/.test(password)) return false;
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(password)));
    const expected = Uint8Array.from(auth.passwordHash.match(/../g)!, hex => parseInt(hex, 16));
    const key = await crypto.subtle.importKey('raw', encoder.encode(auth.sessionKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    const signature = await crypto.subtle.sign('HMAC', key, expected);
    return crypto.subtle.verify('HMAC', key, signature, hash);
}

export function sessionToken(request: Request): string | null {
    const matches = (request.headers.get('Cookie') || '').split(';')
        .map(part => part.trim()).filter(part => part.startsWith(SESSION_COOKIE + '='));
    if (matches.length !== 1) return null;
    const token = matches[0].slice(SESSION_COOKIE.length + 1);
    return token.length > 0 && token.length < 2048 ? token : null;
}

export async function verifySession(token: string, config: AuthConfig, origin: string, now = Date.now()): Promise<void> {
    const { payload } = await jwtVerify(token, encoder.encode(parseAuth(config).sessionKey), {
        algorithms: ['HS256'], issuer: origin, audience: 'pokeclicker-game', subject: 'player',
        requiredClaims: ['exp', 'iat', 'jti', 'sub'], currentDate: new Date(now), maxTokenAge: SESSION_SECONDS,
    });
    if (payload.v !== 1 || typeof payload.iat !== 'number' || typeof payload.exp !== 'number'
        || payload.iat > Math.floor(now / 1000) || payload.exp > payload.iat + SESSION_SECONDS) {
        throw new Error('Invalid session');
    }
}

export async function createSessionCookie(config: AuthConfig, origin: string, now = Date.now()): Promise<string> {
    const token = await new SignJWT({ v: 1 }).setProtectedHeader({ alg: 'HS256' })
        .setIssuer(origin).setAudience('pokeclicker-game').setSubject('player')
        .setJti(crypto.randomUUID()).setIssuedAt(Math.floor(now / 1000))
        .setExpirationTime(Math.floor(now / 1000) + SESSION_SECONDS)
        .sign(encoder.encode(parseAuth(config).sessionKey));
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`;
}

export function clearSessionCookie(): string {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}
