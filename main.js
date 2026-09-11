// CouchKing Desktop — Electron main process.
// Same account + endpoints as the TV app: /tvapp/auth sign-in, /tvapp/state sync,
// addon /stream lists, /player/progress + /player/resume cross-device resume.
// PLAYBACK = mpv (bundled per-OS under mpv/, falls back to system mpv): plays every
// MKV/H.264/HEVC/DDP file exactly like the TV app's Media3+ffmpeg stack — no browser
// codec roulette. mpv is controlled over its JSON IPC socket for progress beacons.
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const os = require('os');

const SERVICE = 'https://couchking.app';   // sideload channel: service baked, like the full-flavor TV app

let win;
function createWindow() {
    win = new BrowserWindow({
        width: 1280, height: 800, minWidth: 960, minHeight: 600,
        backgroundColor: '#0C0B14',
        autoHideMenuBar: true,
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
    });
    win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}
app.whenReady().then(createWindow);
app.on('window-all-closed', () => { stopMpv(); app.quit(); });

// ---- tiny fetch helper (Node 18+ global fetch) ----
ipcMain.handle('http', async (_e, { url, method = 'GET', body = null, timeoutMs = 15000 }) => {
    try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), timeoutMs);
        const r = await fetch(url, {
            method, signal: ctl.signal,
            headers: body ? { 'Content-Type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined
        });
        clearTimeout(t);
        const text = await r.text();
        return { ok: r.ok, status: r.status, text };
    } catch (e) { return { ok: false, status: 0, text: String(e).slice(0, 200) }; }
});

ipcMain.handle('service', () => SERVICE);
ipcMain.handle('version', () => app.getVersion());
// update pill: the renderer hands us the installer URL from /desktop/version.json —
// download goes through the system browser (no in-app downloader to babysit)
ipcMain.handle('openExternal', (_e, url) => {
    if (/^https:\/\//.test(String(url))) shell.openExternal(String(url));
});

// ---- mpv playback ----
let mpvProc = null, mpvSock = null, mpvIpcPath = null;
let lastPos = 0, lastDur = 0, onExitBeacon = null;

function mpvBinary() {
    const plat = process.platform;
    const bundled = plat === 'win32'
        ? path.join(__dirname, 'mpv', 'win', 'mpv.exe')
        : path.join(__dirname, 'mpv', 'mac', 'mpv');
    if (fs.existsSync(bundled)) return bundled;
    return 'mpv';   // dev fallback: system mpv on PATH
}

function stopMpv() {
    try { mpvSock?.destroy(); } catch {}
    mpvSock = null;
    try { mpvProc?.kill(); } catch {}
    mpvProc = null;
}

// Launch mpv fullscreen for a stream; report position over IPC so the renderer can
// beacon /player/progress (cross-device resume) exactly like the TV app does on exit.
ipcMain.handle('play', async (_e, { url, title, startSec = 0, subScale = 1.0 }) => {
    stopMpv();
    lastPos = 0; lastDur = 0;
    mpvIpcPath = process.platform === 'win32'
        ? '\\\\.\\pipe\\ck-mpv-' + Date.now()
        : path.join(os.tmpdir(), 'ck-mpv-' + Date.now() + '.sock');
    const args = [
        '--fullscreen', '--force-window=yes', '--keep-open=no',
        '--title=' + (title || 'CouchKing'),
        '--force-media-title=' + (title || 'CouchKing'),
        '--input-ipc-server=' + mpvIpcPath,
        '--user-agent=CouchKingDesktop/0.1',
        '--hwdec=auto-safe', '--cache=yes', '--demuxer-max-bytes=256MiB',
        '--slang=en,eng', '--alang=en,eng', '--sub-scale=' + (subScale || 1.0),
        '--osc=yes', '--osd-bar=yes'
    ];
    if (startSec > 5) args.push('--start=' + Math.floor(startSec));
    args.push(url);
    try { mpvProc = spawn(mpvBinary(), args, { stdio: 'ignore' }); }
    catch (e) { return { ok: false, error: 'mpv missing: ' + e }; }
    mpvProc.on('error', () => { win?.webContents.send('mpv-exit', { pos: lastPos, dur: lastDur, error: 'mpv failed to start' }); mpvProc = null; });
    mpvProc.on('exit', () => { win?.webContents.send('mpv-exit', { pos: lastPos, dur: lastDur }); mpvProc = null; });

    // poll time-pos/duration over the IPC socket once mpv creates it
    setTimeout(() => {
        try {
            mpvSock = net.connect(mpvIpcPath);
            let buf = '';
            mpvSock.on('data', d => {
                buf += d.toString();
                let i;
                while ((i = buf.indexOf('\n')) >= 0) {
                    const line = buf.slice(0, i); buf = buf.slice(i + 1);
                    try {
                        const m = JSON.parse(line);
                        if (m.request_id === 1 && typeof m.data === 'number') lastPos = m.data;
                        if (m.request_id === 2 && typeof m.data === 'number') lastDur = m.data;
                    } catch {}
                }
            });
            mpvSock.on('error', () => {});
            const iv = setInterval(() => {
                if (!mpvProc) { clearInterval(iv); return; }
                try {
                    mpvSock.write(JSON.stringify({ command: ['get_property', 'time-pos'], request_id: 1 }) + '\n');
                    mpvSock.write(JSON.stringify({ command: ['get_property', 'duration'], request_id: 2 }) + '\n');
                    win?.webContents.send('mpv-pos', { pos: lastPos, dur: lastDur });
                } catch { clearInterval(iv); }
            }, 1000);
        } catch {}
    }, 1500);
    return { ok: true };
});
ipcMain.handle('stopPlay', () => { stopMpv(); return { ok: true }; });
