const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ck', {
    http: (opts) => ipcRenderer.invoke('http', opts),
    service: () => ipcRenderer.invoke('service'),
    version: () => ipcRenderer.invoke('version'),
    platform: process.platform,
    openExternal: (url) => ipcRenderer.invoke('openExternal', url),
    play: (opts) => ipcRenderer.invoke('play', opts),
    stopPlay: () => ipcRenderer.invoke('stopPlay'),
    onMpvExit: (cb) => ipcRenderer.on('mpv-exit', (_e, d) => cb(d)),
    onMpvDead: (cb) => ipcRenderer.on('mpv-dead-instant', (_e, d) => cb(d)),
    openTrailer: (id) => ipcRenderer.invoke('open-trailer', id),
    onMpvPos: (cb) => ipcRenderer.on('mpv-pos', (_e, d) => cb(d)),
});
