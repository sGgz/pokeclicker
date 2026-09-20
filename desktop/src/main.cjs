const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, safeStorage, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { localResponse } = require('./local-files.cjs');
const { createCloudClient } = require('./cloud.cjs');

const GAME_URL = 'pokeclicker://game/';
const LOGIN_URL = 'pokeclicker://desktop/login.html';
const HELP_URL = 'pokeclicker://desktop/help.html';
app.setName('PokeclickerCloud');
app.setAppUserModelId('fun.ggzz.pokeclicker.cloud');
// Fixed application identity keeps upgrades and ZIP installations on the same private profile.
const dataArgument = process.argv.find(value => value.startsWith('--data-dir='));
const dataDirectory = dataArgument?.slice('--data-dir='.length);
if (dataDirectory && !path.isAbsolute(dataDirectory)) throw new Error('Data directory must be absolute');
app.setPath('userData', dataDirectory || path.join(app.getPath('appData'), 'PokeclickerCloud'));
protocol.registerSchemesAsPrivileged([{ scheme: 'pokeclicker', privileges: {
    standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true,
} }]);
app.enableSandbox();

let mainWindow;
let loginWindow;
let helpWindow;
let loginPromise;
let completeLogin;
let loginResult = { ok: false, message: '已取消登录，可继续使用本地进度。' };
let closeRequest;
let gameReady = false;
let closeBusy = false;
let cloud;

function fromWindow(event, window, expectedUrl) {
    if (!window || window.isDestroyed() || event.sender !== window.webContents
        || event.senderFrame !== window.webContents.mainFrame) return false;
    try {
        const actual = new URL(event.senderFrame.url);
        actual.hash = '';
        return actual.href === expectedUrl;
    } catch { return false; }
}

function openExternal(url) {
    try {
        const parsed = new URL(url);
        if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) {
            void shell.openExternal(parsed.href).catch(() => {});
        }
    } catch { /* Malformed and non-web links never reach the OS shell. */ }
}

function harden(window, initialUrl) {
    window.webContents.setWindowOpenHandler(({ url }) => {
        openExternal(url);
        return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, url) => {
        if (url.split('#')[0] !== initialUrl) { event.preventDefault(); openExternal(url); }
    });
    window.webContents.on('will-redirect', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());
}

function windowOptions(preload) {
    return {
        show: false, backgroundColor: '#f5f8fc',
        webPreferences: {
            ...(preload ? { preload: path.join(__dirname, preload) } : {}),
            nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
            webviewTag: false, backgroundThrottling: false, spellcheck: false,
        },
    };
}

function openLogin() {
    if (loginWindow && !loginWindow.isDestroyed()) { loginWindow.focus(); return loginPromise; }
    loginResult = { ok: false, message: '已取消登录，可继续使用本地进度。' };
    loginPromise = new Promise(resolve => { completeLogin = resolve; });
    loginWindow = new BrowserWindow({ ...windowOptions('login-preload.cjs'), width: 580, height: 580,
        minWidth: 500, minHeight: 520, parent: mainWindow, title: '登录云存档 — Pokeclicker Cloud',
    });
    loginWindow.setMenu(null);
    harden(loginWindow, LOGIN_URL);
    loginWindow.once('ready-to-show', () => loginWindow?.show());
    loginWindow.on('closed', () => {
        loginWindow = null;
        completeLogin?.(loginResult);
        completeLogin = null;
    });
    void loginWindow.loadURL(LOGIN_URL);
    return loginPromise;
}

function openHelp() {
    if (helpWindow && !helpWindow.isDestroyed()) { helpWindow.focus(); return; }
    helpWindow = new BrowserWindow({ ...windowOptions(), width: 900, height: 780, title: '操作手册 — Pokeclicker Cloud' });
    helpWindow.setMenu(null);
    harden(helpWindow, HELP_URL);
    helpWindow.once('ready-to-show', () => helpWindow?.show());
    helpWindow.on('closed', () => { helpWindow = null; });
    void helpWindow.loadURL(HELP_URL);
}

async function prepareSave() {
    if (!gameReady) return { ok: false, message: '游戏还未完成加载，请稍后再试。若窗口一直空白，请先保留本机数据目录再处理。' };
    if (closeRequest) return { ok: false, message: '正在保存本地进度，请稍候。' };
    return new Promise(resolve => {
        const id = crypto.randomUUID();
        const timeout = setTimeout(() => {
            closeRequest = null;
            resolve({ ok: false, message: '保存确认超时，已保留游戏窗口。请先在云存档面板导出本地备份，再尝试关闭。' });
        }, 15000);
        closeRequest = { id, finish: result => { clearTimeout(timeout); closeRequest = null; resolve(result); } };
        mainWindow.webContents.send('desktop:prepare-close', id);
    });
}

async function saveAndQuit() {
    if (closeBusy || !mainWindow || mainWindow.isDestroyed()) return;
    closeBusy = true;
    try {
        const result = await prepareSave();
        if (!result?.ok) {
            await dialog.showMessageBox(mainWindow, { type: 'warning', title: '暂未关闭游戏',
                message: '请先完成本地保存', detail: result?.message || '请导出存档备份后再重试。', buttons: ['回到游戏'] });
            return;
        }
        // Flush Chromium's pending localStorage writes. IndexedDB transactions were awaited in the renderer.
        mainWindow.webContents.session.flushStorageData();
        loginWindow?.destroy();
        helpWindow?.destroy();
        mainWindow.destroy();
        app.quit();
    } finally { closeBusy = false; }
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); }
    });
    app.on('before-quit', event => {
        if (mainWindow && !mainWindow.isDestroyed()) { event.preventDefault(); void saveAndQuit(); }
    });
    app.on('window-all-closed', () => app.quit());
    app.whenReady().then(() => {
        const roots = {
            game: app.isPackaged ? path.join(process.resourcesPath, 'game') : path.resolve(__dirname, '../.stage/game'),
            ui: path.resolve(__dirname, '../ui'),
        };
        if (!fs.existsSync(path.join(roots.game, 'index.html'))) {
            dialog.showErrorBox('缺少本地游戏文件', '请重新解压完整 ZIP 或重新安装客户端。开发环境请先运行 npm run desktop:build。');
            app.quit(); return;
        }
        cloud = createCloudClient({ origin: 'https://play.ggzz.fun', userData: app.getPath('userData'), safeStorage });
        protocol.handle('pokeclicker', request => localResponse(request, roots));
        mainWindow = new BrowserWindow({ ...windowOptions('preload.cjs'), width: 1440, height: 980,
            minWidth: 960, minHeight: 680, title: 'Pokeclicker Cloud — 本地游戏 / 私人云存档',
            icon: path.join(roots.game, 'assets/images/favicon.ico'),
        });
        const session = mainWindow.webContents.session;
        session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
        session.setPermissionCheckHandler(() => false);
        // Game assets and translations are bundled. Network credentials stay exclusively in the main process.
        session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'file://*/*'] }, (_details, callback) => callback({ cancel: true }));
        session.on('will-download', (event, item, contents) => {
            if (contents !== mainWindow?.webContents || !/^(blob:pokeclicker:\/\/game\/|data:)/.test(item.getURL())
                || !/\.(txt|json)$/i.test(item.getFilename())) { event.preventDefault(); return; }
            item.setSaveDialogOptions({ title: '导出游戏存档备份', defaultPath: path.join(app.getPath('downloads'), path.basename(item.getFilename())),
                filters: [{ name: '游戏存档与恢复备份', extensions: ['txt', 'json'] }] });
        });
        harden(mainWindow, GAME_URL);
        mainWindow.on('close', event => { event.preventDefault(); void saveAndQuit(); });
        mainWindow.once('ready-to-show', () => mainWindow.show());
        mainWindow.on('closed', () => { mainWindow = null; });

        ipcMain.handle('desktop:cloud', (event, input) => {
            if (!fromWindow(event, mainWindow, GAME_URL)) throw new Error('Unauthorized desktop request');
            return cloud.request(input);
        });
        ipcMain.handle('desktop:open-login', event => {
            if (!fromWindow(event, mainWindow, GAME_URL)) throw new Error('Unauthorized desktop request');
            return openLogin();
        });
        ipcMain.handle('desktop:login', async (event, password) => {
            if (!fromWindow(event, loginWindow, LOGIN_URL)) throw new Error('Unauthorized login request');
            const window = loginWindow;
            const result = await cloud.login(password);
            if (loginWindow === window) loginResult = result;
            return result;
        });
        ipcMain.on('desktop:login-done', event => {
            if (fromWindow(event, loginWindow, LOGIN_URL) && loginResult.ok) loginWindow.close();
        });
        ipcMain.on('desktop:ready', event => { if (fromWindow(event, mainWindow, GAME_URL)) gameReady = true; });
        ipcMain.on('desktop:close-result', (event, id, result) => {
            if (!fromWindow(event, mainWindow, GAME_URL) || id !== closeRequest?.id) return;
            closeRequest.finish({ ok: result?.ok === true, message: typeof result?.message === 'string' ? result.message.slice(0, 500) : '' });
        });
        Menu.setApplicationMenu(Menu.buildFromTemplate([
            { label: '游戏', submenu: [
                { label: '登录云存档', click: () => mainWindow.webContents.send('desktop:request-login') },
                { type: 'separator' }, { label: '保存本地并退出', accelerator: 'Alt+F4', click: () => { void saveAndQuit(); } },
            ] },
            { label: '编辑', submenu: [{ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' },
                { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }] },
            { label: '显示', submenu: [{ role: 'resetZoom', label: '恢复缩放' }, { role: 'zoomIn', label: '放大' },
                { role: 'zoomOut', label: '缩小' }, { role: 'togglefullscreen', label: '全屏' }] },
            { label: '帮助', submenu: [
                { label: '操作手册（离线可读）', click: openHelp },
                { label: '打开本机数据目录', click: () => { void shell.openPath(app.getPath('userData')); } },
                { label: '关于此客户端', click: () => { void dialog.showMessageBox(mainWindow, { title: 'Pokeclicker Cloud',
                    message: `私人云存档桌面版 ${app.getVersion()}`,
                    detail: '游戏在本机运行，云存档连接 play.ggzz.fun。此定制版独立于官方客户端；请手动安装新版本，升级保留本地数据。关闭窗口仅保存本地进度，换设备前请点击“同步后换设备”。', buttons: ['知道了'] }); } },
            ] },
        ]));
        void mainWindow.loadURL(GAME_URL);
    }).catch(() => { dialog.showErrorBox('客户端启动失败', '请重新安装客户端；保留 %APPDATA%\\PokeclickerCloud 内的本机进度。'); app.exit(1); });
}
