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
// ---- Windows in-app auto-update (AJ Sep 13: "can I not update in the app itself") ----
// electron-updater + our own generic feed: downloads in the background, renderer shows a
// "Restart to update" pill, one click installs + relaunches. Windows only — macOS refuses
// self-update without an Apple Developer signature (pending the $99 cert).
if (process.platform === 'win32') {
    try {
        const { autoUpdater } = require('electron-updater');
        autoUpdater.autoDownload = true;
        autoUpdater.on('update-downloaded', (info) => {
            win?.webContents.send('upd-ready', { version: info?.version });
        });
        ipcMain.handle('apply-update', () => { try { autoUpdater.quitAndInstall(false, true); } catch {} });
        app.whenReady().then(() => setTimeout(() => {
            try { autoUpdater.checkForUpdates(); } catch {}
        }, 4000));
    } catch {}
}

ipcMain.handle('open-trailer', (_e, ytId) => {
    // top-level embed page in its own window — an iframe from the app's local page has no
    // https origin and YouTube answers "video player configuration error" (AJ Sep 13)
    const t = new BrowserWindow({ width: 1280, height: 720, autoHideMenuBar: true,
        backgroundColor: '#000', title: 'Trailer' });
    t.loadURL(`https://www.youtube-nocookie.com/embed/${String(ytId).replace(/[^\w-]/g, '')}?autoplay=1&rel=0`);
});

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
        '--osc=yes', '--osd-bar=yes',
        '--no-ytdl'   // direct media only — stops the yt-dlp subprocess noise/latency
    ];
    // TLS roots for the portable engine (Sep 13, THE Mac fix): bundled mpv has no CA
    // store, so https verification failed on every stream. Point it at our shipped
    // Mozilla bundle; if a build lacks it, skip verification rather than fail closed.
    const caCandidates = process.platform === 'win32'
        ? [path.join(path.dirname(mpvBinary()), 'cacert.pem')]
        : [path.resolve(mpvBinary(), '../../../../cacert.pem')];
    const ca = caCandidates.find(c => { try { return fs.existsSync(c); } catch { return false; } });
    args.push(ca ? '--tls-ca-file=' + ca : '--tls-verify=no');
    if (startSec > 5) args.push('--start=' + Math.floor(startSec));
    // ranked OpenSubtitles from the addon (release-matched = best sync) — same list the
    // Firestick gets; they show up in mpv's subtitle cycle (j key / OSC menu). Before
    // this the desktop only ever saw the file's embedded track (AJ Sep 13).
    for (const sub of (subs || []).slice(0, 5))
        if (sub && sub.url) args.push('--sub-file=' + sub.url);
    args.push(url);
    const bin = ensureRunnableMpv(mpvBinary());
    let errTail = '';
    try { mpvProc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return { ok: false, error: 'mpv missing: ' + e }; }
    mpvProc.stderr?.on('data', (d) => { errTail = (errTail + d.toString()).slice(-1500); });
    mpvProc.stdout?.on('data', (d) => { errTail = (errTail + d.toString()).slice(-1500); });
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

// ---- OFFLINE DOWNLOADS (0.9.14, AJ Sep 14) ----
// Files land in the app's own userData/Downloads (delete = space back instantly, uninstall
// wipes them). The media rides the SAME /webplay remux the in-window player uses — h264+AAC
// mp4 that the <video> element plays straight off disk. Subtitles + the learned skip-intro /
// credits windows are captured INTO the meta at download time, so offline play has
// everything the online player has.
const DL_DIR = path.join(app.getPath('userData'), 'Downloads');
const dlKey = (sid) => String(sid || '').replace(/[^\w]+/g, '_');
const dlActive = new Map();   // key -> AbortController
const b64u = (s) => Buffer.from(String(s)).toString('base64url');

function dlBroadcast(ch, d) { try { win?.webContents.send(ch, d); } catch {} }
function dlMetaPath(key) { return path.join(DL_DIR, key + '.json'); }
function dlFilePath(key) { return path.join(DL_DIR, key + '.mp4'); }

ipcMain.handle('dl-list', () => {
    try {
        if (!fs.existsSync(DL_DIR)) return [];
        return fs.readdirSync(DL_DIR).filter(f => f.endsWith('.json')).map(f => {
            try {
                const m = JSON.parse(fs.readFileSync(path.join(DL_DIR, f), 'utf8'));
                const fp = dlFilePath(m.key);
                m.bytes = fs.existsSync(fp) ? fs.statSync(fp).size : 0;
                m.file = fp;
                m.active = dlActive.has(m.key);
                return m;
            } catch { return null; }
        }).filter(Boolean);
    } catch { return []; }
});

ipcMain.handle('dl-delete', (_e, { key }) => {
    try { dlActive.get(key)?.abort(); dlActive.delete(key); } catch {}
    for (const p of [dlFilePath(key), dlMetaPath(key)])
        try { fs.rmSync(p, { force: true }); } catch {}
    return { ok: true };
});

ipcMain.handle('dl-start', async (_e, opts) => {
    const { sid, prof = '', url, title, poster = '', kind = 'movie', showName = '', epName = '',
            season = 0, episode = 0, durSec = 0, subs = [],
            introFromMs = -1, introToMs = -1, creditsMs = 0, capGB = 30 } = opts || {};
    // key carries the profile — per-profile lists, per-profile deletes (AJ Sep 14)
    const key = dlKey(prof + '_' + sid);
    if (!key || !url) return { ok: false, error: 'bad args' };
    if (dlActive.has(key)) return { ok: false, error: 'already downloading' };
    fs.mkdirSync(DL_DIR, { recursive: true });
    // size estimate from the SOURCE file (remux ≈ source: video copied, audio swapped)
    let est = 0;
    try {
        const h = await fetch(url, { headers: { Range: 'bytes=0-0' }, redirect: 'follow' });
        const cr = h.headers.get('content-range');
        est = cr ? parseInt(cr.split('/')[1]) || 0 : parseInt(h.headers.get('content-length')) || 0;
        try { h.body?.cancel(); } catch {}
    } catch {}
    // guardrails: storage cap (Settings) + a hard 5GB free-disk floor
    try {
        const used = fs.readdirSync(DL_DIR).reduce((a, f) => a + fs.statSync(path.join(DL_DIR, f)).size, 0);
        if (est && used + est > capGB * 1e9)
            return { ok: false, error: `storage cap (${capGB} GB) would be exceeded — delete something first` };
        const free = fs.statfsSync(app.getPath('userData')).bavail * fs.statfsSync(app.getPath('userData')).bsize;
        if (free < (est || 3e9) + 5e9) return { ok: false, error: 'not enough disk space' };
    } catch {}
    // subtitles go INTO the meta as text — offline play needs zero network
    const subTexts = [];
    for (const s of (subs || []).slice(0, 3)) {
        if (!s?.url) continue;
        try {
            const t = await (await fetch(`${SERVICE}/websub?u=${b64u(s.url)}`)).text();
            if (t && /-->/.test(t)) subTexts.push({ lang: 'English ' + (subTexts.length + 1), vtt: t });
        } catch {}
    }
    const meta = { key, sid, prof, title, poster, kind, showName, epName, season, episode,
                   durSec, introFromMs, introToMs, creditsMs, subs: subTexts,
                   est, done: false, ts: Date.now() };
    fs.writeFileSync(dlMetaPath(key), JSON.stringify(meta));
    const ctl = new AbortController();
    dlActive.set(key, ctl);
    (async () => {
        try {
            const r = await fetch(`${SERVICE}/webplay?u=${b64u(url)}&t=0`, { signal: ctl.signal });
            if (!r.ok || !r.body) throw new Error('webplay ' + r.status);
            const out = fs.createWriteStream(dlFilePath(key));
            let got = 0, lastTick = 0;
            for await (const chunk of r.body) {
                out.write(chunk);
                got += chunk.length;
                if (Date.now() - lastTick > 700) {
                    lastTick = Date.now();
                    dlBroadcast('dl-prog', { key, got, est });
                }
            }
            await new Promise(res => out.end(res));
            if (got < 20e6) throw new Error('stream ended early (' + got + ' bytes)');
            meta.done = true; meta.bytes = got;
            fs.writeFileSync(dlMetaPath(key), JSON.stringify(meta));
            dlBroadcast('dl-done', { key, got });
        } catch (e2) {
            try { fs.rmSync(dlFilePath(key), { force: true }); fs.rmSync(dlMetaPath(key), { force: true }); } catch {}
            if (!ctl.signal.aborted) dlBroadcast('dl-err', { key, error: String(e2).slice(0, 160) });
        } finally { dlActive.delete(key); }
    })();
    return { ok: true, key, est };
});
