const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ck', {
    http: (opts) => ipcRenderer.invoke('http', opts),
    service: () => ipcRenderer.invoke('service'),
    play: (opts) => ipcRenderer.invoke('play', opts),
    stopPlay: () => ipcRenderer.invoke('stopPlay'),
    onMpvExit: (cb) => ipcRenderer.on('mpv-exit', (_e, d) => cb(d)),
    onMpvPos: (cb) => ipcRenderer.on('mpv-pos', (_e, d) => cb(d)),
});
