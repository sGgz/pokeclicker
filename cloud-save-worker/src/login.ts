function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
}

export function returnPath(value: string | null, origin: string): string {
    if (!value || value.length > 2048 || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return '/';
    const url = new URL(value, origin);
    if (url.origin !== origin || url.pathname === '/login' || url.pathname.startsWith('/auth/')) return '/';
    return url.pathname + url.search + url.hash;
}

export function loginPage(options: { returnTo: string; message?: string; loggedIn?: boolean; status?: number }): Response {
    const target = escapeHtml(options.returnTo);
    const content = options.loggedIn ? `
        <p class="notice">已登录，可以继续游戏。</p>
        <p>如果你是在另一个标签页重新登录，现在可以关闭本页，回到原游戏点击“检查连接”或“上传 / 立即同步”。</p>
        <a class="primary" href="${target}">进入游戏</a>
        <form method="post" action="/auth/logout"><button class="secondary" type="submit">退出登录</button></form>
        <p class="hint">退出只清除当前浏览器的登录状态，不会删除本地或云端存档，也不会自动上传进度。</p>` : `
        <p>输入你自己的游戏专用密码，继续你的冒险。不同玩家的密码对应各自的存档。</p>
        ${options.message ? `<p class="error" role="alert">${escapeHtml(options.message)}</p>` : ''}
        <form method="post" action="/auth/login">
            <input type="hidden" name="returnTo" value="${target}">
            <label for="password">游戏专用密码</label>
            <input id="password" name="password" type="password" autocomplete="current-password" spellcheck="false" autocapitalize="off" minlength="32" maxlength="32" required autofocus placeholder="粘贴你的 32 位游戏密码">
            <button class="primary" type="submit">登录游戏</button>
        </form>
        <p class="hint">登录有效期为 7 天。请使用游戏专用密码，GitHub token 不应填写在这里。</p>
        <details><summary>忘记密码了？</summary><p>请联系网站管理员重置你自己的游戏密码。重置后需要重新登录，原存档会保留。</p></details>`;
    return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>私人游戏 · PokéClicker</title><style>
        *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#eef3f9;color:#23314b;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.65}main{width:100%;max-width:460px;background:white;border:1px solid #dce4ef;border-radius:20px;padding:36px;box-shadow:0 14px 48px #16346212}.eyebrow{color:#4960b4;font-size:12px;font-weight:700;letter-spacing:2px}h1{font-size:28px;line-height:1.3;margin:10px 0 18px}p{margin:14px 0}label{display:block;font-weight:650;margin:22px 0 8px}input[type=password]{width:100%;min-height:48px;padding:12px;border:1px solid #8997ad;border-radius:9px;font-size:16px}input:focus{outline:3px solid #bacbff;outline-offset:2px}button,.primary{display:block;width:100%;padding:12px 16px;border:0;border-radius:9px;text-align:center;font:inherit;font-weight:650;cursor:pointer;text-decoration:none}.primary{background:#3655ba;color:white;margin-top:18px}.primary:hover{background:#294392}.secondary{background:#edf1f7;color:#334566;margin-top:12px}.hint,details{font-size:13px;color:#5d6b80}.error{padding:12px;background:#fff0f0;color:#972c35;border-radius:8px}.notice{padding:12px;background:#edf8f1;color:#23663b;border-radius:8px}summary{cursor:pointer}code{overflow-wrap:anywhere}@media(max-width:420px){main{padding:24px}body{padding:16px}}
        </style></head><body><main><div class="eyebrow">POKÉCLICKER · 私人游戏</div><h1>${options.loggedIn ? '欢迎回来' : '登录你的游戏'}</h1>${content}</main></body></html>`, {
        status: options.status || 200,
        headers: {
            'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store',
            // Same-origin forms need a non-null Origin; cross-origin referrers are still suppressed.
            'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
            'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        },
    });
}
