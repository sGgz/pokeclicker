const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktopLogin', {
    submit: password => ipcRenderer.invoke('desktop:login', password),
    done: () => ipcRenderer.send('desktop:login-done'),
});
