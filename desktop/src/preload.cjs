const { contextBridge, ipcRenderer } = require('electron');
let closeHandler;
ipcRenderer.on('desktop:request-login', () => document.querySelector('[data-cloud-action="login"]')?.click());
ipcRenderer.on('desktop:prepare-close', async (_event, id) => {
    let result;
    try {
        result = closeHandler ? await closeHandler() : { ok: false, message: '游戏尚未初始化，请稍后再关闭。' };
    } catch { result = { ok: false, message: '本地保存未完成，请保留窗口并导出存档备份。' }; }
    ipcRenderer.send('desktop:close-result', id, result);
});
contextBridge.exposeInMainWorld('pokeclickerDesktop', {
    version: 1,
    cloudRequest: input => ipcRenderer.invoke('desktop:cloud', input),
    login: () => ipcRenderer.invoke('desktop:open-login'),
    onBeforeClose: callback => {
        if (typeof callback !== 'function') throw new TypeError('Expected callback');
        closeHandler = callback;
        ipcRenderer.send('desktop:ready');
    },
});
