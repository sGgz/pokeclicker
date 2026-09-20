const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { resolveLocalFile, localResponse } = require('../src/local-files.cjs');

test('local resource handler refuses paths outside the two fixed roots', () => {
    const roots = { game: path.resolve('game'), ui: path.resolve('ui') };
    for (const url of ['file:///C:/secret', 'pokeclicker://other/a', 'pokeclicker://game/%2e%2e%5csecret',
        'pokeclicker://game/%2f..%2fsecret', 'pokeclicker://game/C:/secret', 'pokeclicker://game/%00a',
        'pokeclicker://user@game/a', 'pokeclicker://game:123/a', 'pokeclicker://desktop/main.cjs',
        'pokeclicker://game/%ZZ']) assert.equal(resolveLocalFile(url, roots), null, url);
    assert.equal(resolveLocalFile('pokeclicker://game/assets/x.png?v=1', roots).file, path.join(roots.game, 'assets/x.png'));
    assert.equal(resolveLocalFile('pokeclicker://game/', roots).file, path.join(roots.game, 'index.html'));
});

test('serves offline resources with scoped CSP and never follows a directory symlink', async t => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-local-files-'));
    t.after(() => fs.rm(temp, { recursive: true, force: true }));
    const roots = { game: path.join(temp, 'game'), ui: path.join(temp, 'ui') };
    await fs.mkdir(roots.game); await fs.mkdir(roots.ui); await fs.mkdir(path.join(temp, 'private'));
    await fs.writeFile(path.join(roots.game, 'index.html'), 'offline game');
    await fs.writeFile(path.join(roots.ui, 'login.html'), 'login');
    await fs.writeFile(path.join(temp, 'private/secret.txt'), 'must not serve');
    await fs.symlink(path.join(temp, 'private'), path.join(roots.game, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const response = await localResponse(new Request('pokeclicker://game/'), roots);
    assert.equal(await response.text(), 'offline game');
    assert.match(response.headers.get('Content-Security-Policy'), /connect-src 'self'/);
    const login = await localResponse(new Request('pokeclicker://desktop/login.html'), roots);
    assert.ok(!login.headers.get('Content-Security-Policy').includes('unsafe-eval'));
    assert.equal((await localResponse(new Request('pokeclicker://game/escape/secret.txt'), roots)).status, 404);
    assert.equal((await localResponse(new Request('pokeclicker://game/', { method: 'POST' }), roots)).status, 405);
    assert.equal(await (await localResponse(new Request('pokeclicker://game/', { method: 'HEAD' }), roots)).text(), '');
});
