// CouchKing Desktop — Electron main process.
// Same account + endpoints as the TV app: /tvapp/auth sign-in, /tvapp/state sync,
// addon /stream lists, /player/progress + /player/resume cross-device resume.
// PLAYBACK = mpv (bundled per-OS under mpv/, falls back to system mpv): plays every
// MKV/H.264/HEVC/DDP file exactly like the TV app's Media3+ffmpeg stack — no browser
// codec roulette. mpv is controlled over its JSON IPC socket for progress beacons.
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { spawn, execSync } = require('child_process');
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
    // spawn() can't exec out of the asar archive — bundled binaries live in app.asar.unpacked
    const base = __dirname.replace('app.asar', 'app.asar.unpacked');
    const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
    const candidates = process.platform === 'win32'
        ? [path.join(base, 'mpv', 'win', 'mpv.exe')]
        : [path.join(base, 'mpv', 'mac-' + arch, 'mpv.app', 'Contents', 'MacOS', 'mpv'),
           path.join(base, 'mpv', 'mac', 'mpv')];
    for (const c of candidates) if (fs.existsSync(c)) return c;
    return 'mpv';   // dev fallback: system mpv on PATH
}

// macOS SIGKILLs quarantined/unsigned helper binaries on spawn — the "flash for 0.01s
// then nothing" bug (AJ Sep 13). Once per launch: strip the quarantine flag the dmg
// download left on the bundled mpv and re-apply an ad-hoc signature. Best-effort — a
// properly signed build (0.9.6+) doesn't need it, older installs self-repair.
// v0.9.8 (AJ: "it should just work"): macOS runs freshly-downloaded apps from a READ-ONLY
// translocation mount, so in-place repair is impossible. Instead: copy mpv.app into the
// user's own Library (always writable), strip quarantine + ad-hoc sign THERE, run that
// copy. Zero user action, survives updates (re-copied per app version).
let runnableMpv = null;
function ensureRunnableMpv(bin) {
    if (process.platform !== 'darwin' || bin === 'mpv') return bin;
    if (runnableMpv && fs.existsSync(runnableMpv)) return runnableMpv;
    try {
        const appDir = bin.replace(/\/Contents\/MacOS\/mpv$/, '');
        const destRoot = path.join(app.getPath('userData'), 'mpv');
        const dest = path.join(destRoot, 'mpv.app');
        const destBin = path.join(dest, 'Contents', 'MacOS', 'mpv');
        const marker = path.join(destRoot, 'v-' + app.getVersion());
        if (!fs.existsSync(destBin) || !fs.existsSync(marker)) {
            fs.rmSync(destRoot, { recursive: true, force: true });
            fs.mkdirSync(destRoot, { recursive: true });
            execSync(`cp -R "${appDir}" "${dest}"`);
            fs.writeFileSync(marker, '1');
        }
        execSync(`xattr -dr com.apple.quarantine "${dest}" 2>/dev/null || true`);
        execSync(`codesign --force --deep --sign - "${dest}" 2>/dev/null || true`);
        runnableMpv = destBin;
        return destBin;
    } catch { return bin; }
}

function stopMpv() {
    try { mpvSock?.destroy(); } catch {}
    mpvSock = null;
    try { mpvProc?.kill(); } catch {}
    mpvProc = null;
}

// Launch mpv fullscreen for a stream; report position over IPC so the renderer can
// beacon /player/progress (cross-device resume) exactly like the TV app does on exit.
ipcMain.handle('play', async (_e, { url, title, startSec = 0, subScale = 1.0, subLang = 'en',
        audioLang = 'en', subBg = false, subOutline = true, subPos = 0, subs = [] }) => {
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
        '--slang=' + subLang + ',en,eng', '--alang=' + audioLang + ',en,eng',
        '--sub-scale=' + (subScale || 1.0),
        '--sub-pos=' + (subPos === 2 ? 75 : subPos === 1 ? 90 : 100),
        '--sub-border-size=' + (subOutline ? 3 : 0),
        ...(subBg ? ['--sub-back-color=#B3000000'] : []),
        '--osc=yes', '--osd-bar=yes'
    ];
    if (startSec > 5) args.push('--start=' + Math.floor(startSec));
    // ranked OpenSubtitles from the addon (release-matched = best sync) — same list the
    // Firestick gets; they show up in mpv's subtitle cycle (j key / OSC menu). Before
    // this the desktop only ever saw the file's embedded track (AJ Sep 13).
    for (const sub of (subs || []).slice(0, 5))
        if (sub && sub.url) args.push('--sub-file=' + sub.url);
    args.push(url);
    const bin = ensureRunnableMpv(mpvBinary());
    let errTail = '';
    try { mpvProc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] }); }
    catch (e) { return { ok: false, error: 'mpv missing: ' + e }; }
    mpvProc.stderr?.on('data', (d) => { errTail = (errTail + d.toString()).slice(-1500); });
    // instant-death detector → ship the REAL reason (exit code/signal + stderr) to the
    // renderer, which beacons it home — one failed play IS the diagnosis (AJ Sep 13)
    const spawnedAt = Date.now();
    mpvProc.once('exit', (code, signal) => {
        if (Date.now() - spawnedAt < 2000 && lastDur === 0)
            win?.webContents.send('mpv-dead-instant', { code, signal, err: errTail, bin });
    });
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
