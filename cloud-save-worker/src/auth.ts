import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface AuthConfig {
    ACCESS_TEAM_DOMAIN: string;
    ACCESS_AUD: string;
    ALLOWED_EMAIL: string;
}

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function verifyAccess(token: string, config: AuthConfig, keys?: JWTVerifyGetKey): Promise<void> {
    if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(config.ACCESS_TEAM_DOMAIN)
        || !config.ACCESS_AUD || !config.ALLOWED_EMAIL) {
        throw new Error('Access configuration is incomplete');
    }
    if (!keys) {
        if (!keySets.has(config.ACCESS_TEAM_DOMAIN)) {
            keySets.set(config.ACCESS_TEAM_DOMAIN, createRemoteJWKSet(new URL(config.ACCESS_TEAM_DOMAIN + '/cdn-cgi/access/certs')));
        }
        keys = keySets.get(config.ACCESS_TEAM_DOMAIN)!;
    }
    const { payload } = await jwtVerify(token, keys, {
        issuer: config.ACCESS_TEAM_DOMAIN,
        audience: config.ACCESS_AUD,
        algorithms: ['RS256'],
        requiredClaims: ['exp', 'iat', 'sub', 'email'],
    });
    if (typeof payload.email !== 'string' || payload.email.toLowerCase() !== config.ALLOWED_EMAIL.toLowerCase()) {
        throw new Error('Identity is not allowed');
    }
}
