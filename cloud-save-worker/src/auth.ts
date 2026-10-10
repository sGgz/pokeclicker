import { SignJWT, decodeJwt, jwtVerify } from 'jose';
import { ApiError } from './github';
import { isUuid } from '../../src/modules/cloudSave/protocol';

export interface AuthConfig {
    GAME_AUTH: string;
    CLOUD_SLOT_ID?: string;
}

export interface PasswordSecret {
    version: 1;
    passwordHash: string;
    sessionKey: string;
}

export interface PlayerSecret {
    id: string;
    name: string;
    slotId: string;
    passwordHash: string;
    sessionKey: string;
}

export interface PlayersSecret {
    version: 2;
    primaryPlayerId: string;
    players: PlayerSecret[];
}

type GameSecret = PasswordSecret | PlayersSecret;

export const SESSION_COOKIE = '__Host-pokeclicker_session';
export const SESSION_SECONDS = 7 * 24 * 60 * 60;
const encoder = new TextEncoder();
let cachedSecret: { raw: string; value: GameSecret } | undefined;

export function parseAuth(config: AuthConfig): GameSecret {
    if (cachedSecret && cachedSecret.raw === config.GAME_AUTH) return cachedSecret.value;
    try {
        const value = JSON.parse(config.GAME_AUTH);
        const validCredentials = (entry: PlayerSecret | PasswordSecret) => entry
            && /^[a-f0-9]{64}$/.test(entry.passwordHash) && /^[A-Za-z0-9_-]{43}$/.test(entry.sessionKey);
        if (value?.version === 1) {
            if (!validCredentials(value)) throw new Error('Invalid secret');
        } else if (value?.version === 2) {
            if (value.primaryPlayerId !== 'player' || !Array.isArray(value.players) || !value.players.length || value.players.length > 20
                || !value.players.every((player: PlayerSecret) => validCredentials(player)
                    && (player.id === 'player' || isUuid(player.id)) && isUuid(player.slotId)
                    && typeof player.name === 'string' && player.name.trim().length > 0 && player.name.length <= 40)
                || !value.players.some((player: PlayerSecret) => player.id === value.primaryPlayerId)) throw new Error('Invalid players');
            for (const key of ['id', 'slotId', 'passwordHash', 'sessionKey']) {
                if (new Set(value.players.map((player: Record<string, string>) => player[key])).size !== value.players.length) throw new Error('Duplicate player');
            }
        } else throw new Error('Invalid version');
        cachedSecret = { raw: config.GAME_AUTH, value };
        return value;
    } catch {
        throw new ApiError(503, 'AUTH_CONFIGURATION', '游戏密码尚未设置，请在部署电脑运行 npm run cloud:password。');
    }
}

export function players(config: AuthConfig): PlayerSecret[] {
    const auth = parseAuth(config);
    return auth.version === 2 ? auth.players : [{
        id: 'player', name: '我的存档', slotId: config.CLOUD_SLOT_ID || '',
        passwordHash: auth.passwordHash, sessionKey: auth.sessionKey,
    }];
}

export function primaryPlayerId(config: AuthConfig): string {
    const auth = parseAuth(config);
    return auth.version === 2 ? auth.primaryPlayerId : 'player';
}

// Only for the setup tool's 192-bit random passwords, NOT for human-chosen passwords.
export async function verifyPassword(password: string, config: AuthConfig): Promise<boolean> {
    return !!await authenticatePassword(password, config);
}

export async function authenticatePassword(password: string, config: AuthConfig): Promise<PlayerSecret | null> {
    const entries = players(config);
    if (!/^[A-Za-z0-9_-]{32}$/.test(password)) return null;
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(password)));
    const matches = await Promise.all(entries.map(async entry => {
        const expected = Uint8Array.from(entry.passwordHash.match(/../g)!, hex => parseInt(hex, 16));
        const key = await crypto.subtle.importKey('raw', encoder.encode(entry.sessionKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
        const signature = await crypto.subtle.sign('HMAC', key, expected);
        return await crypto.subtle.verify('HMAC', key, signature, hash) ? entry : null;
    }));
    return matches.find(Boolean) || null;
}

export function sessionToken(request: Request): string | null {
    const matches = (request.headers.get('Cookie') || '').split(';')
        .map(part => part.trim()).filter(part => part.startsWith(SESSION_COOKIE + '='));
    if (matches.length !== 1) return null;
    const token = matches[0].slice(SESSION_COOKIE.length + 1);
    return token.length > 0 && token.length < 2048 ? token : null;
}

export async function verifySession(token: string, config: AuthConfig, origin: string, now = Date.now()): Promise<PlayerSecret> {
    // Decode only to select a key; no identity is trusted until signature verification succeeds.
    const entry = players(config).find(player => player.id === decodeJwt(token).sub);
    if (!entry) throw new Error('Unknown player');
    const { payload } = await jwtVerify(token, encoder.encode(entry.sessionKey), {
        algorithms: ['HS256'], issuer: origin, audience: 'pokeclicker-game', subject: entry.id,
        requiredClaims: ['exp', 'iat', 'jti', 'sub'], currentDate: new Date(now), maxTokenAge: SESSION_SECONDS,
    });
    if ((payload.v !== 2 && !(payload.v === 1 && entry.id === 'player')) || typeof payload.iat !== 'number' || typeof payload.exp !== 'number'
        || payload.iat > Math.floor(now / 1000) || payload.exp > payload.iat + SESSION_SECONDS) {
        throw new Error('Invalid session');
    }
    return entry;
}

export async function createSessionCookie(config: AuthConfig, origin: string, now = Date.now(), playerId = primaryPlayerId(config)): Promise<string> {
    const entry = players(config).find(player => player.id === playerId);
    if (!entry) throw new Error('Unknown player');
    const token = await new SignJWT({ v: 2 }).setProtectedHeader({ alg: 'HS256' })
        .setIssuer(origin).setAudience('pokeclicker-game').setSubject(entry.id)
        .setJti(crypto.randomUUID()).setIssuedAt(Math.floor(now / 1000))
        .setExpirationTime(Math.floor(now / 1000) + SESSION_SECONDS)
        .sign(encoder.encode(entry.sessionKey));
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`;
}

export function clearSessionCookie(): string {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}
