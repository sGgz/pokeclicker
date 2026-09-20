const path = require('node:path');
const fs = require('node:fs/promises');

const TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};
const GAME_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
const UI_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; form-action 'none'; base-uri 'none'; frame-src 'none'";

function resolveLocalFile(urlText, { game, ui }) {
    const url = new URL(urlText);
    if (url.protocol !== 'pokeclicker:' || url.port || url.username || url.password) return null;
    const root = url.hostname === 'game' ? game : url.hostname === 'desktop' ? ui : null;
    if (!root) return null;
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { return null; }
    if (/[\\\0:]/.test(pathname) || pathname.split('/').some(part => part === '..' || part === '.')) return null;
    if (url.hostname === 'desktop' && !['/login.html', '/login.js', '/help.html'].includes(pathname)) return null;
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    const relative = path.relative(path.resolve(root), file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return { file, root: path.resolve(root), type: TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', game: url.hostname === 'game' };
}

async function localResponse(request, roots) {
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
    const target = resolveLocalFile(request.url, roots);
    if (!target) return new Response(null, { status: 404 });
    try {
        const real = await fs.realpath(target.file);
        const realRoot = await fs.realpath(target.root);
        const relative = path.relative(realRoot, real);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return new Response(null, { status: 404 });
        const stat = await fs.stat(real);
        if (!stat.isFile()) return new Response(null, { status: 404 });
        return new Response(request.method === 'HEAD' ? null : await fs.readFile(real), { headers: {
            'Content-Type': target.type, 'Content-Security-Policy': target.game ? GAME_CSP : UI_CSP,
            'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache', 'Referrer-Policy': 'no-referrer',
        } });
    } catch { return new Response(null, { status: 404 }); }
}
module.exports = { resolveLocalFile, localResponse };
