// Web-browser shim: defines window.ck with the SAME API the Electron preload exposes.
// In the desktop app the preload has already created window.ck before any page script
// runs, so this file is a no-op there — the identical renderer runs in both worlds.
(function () {
    if (window.ck) return;
    let posCb = null, exitCb = null, player = null;
    function closePlayer(fireExit) {
        if (!player) return;
        const v = player.querySelector('video');
        const pos = v?.currentTime || 0, dur = v?.duration || 0;
        try { v.pause(); v.src = ''; } catch {}
        player.remove(); player = null;
        document.body.style.overflow = '';
        if (fireExit && exitCb) exitCb({ pos, dur });
    }
    window.ck = {
        platform: 'web',
        service: async () => (location.origin.includes('couchking') ? location.origin : 'https://couchking.app'),
        version: async () => 'web',
        openExternal: (url) => window.open(url, '_blank'),
        http: async ({ url, method = 'GET', body = null, timeoutMs = 15000 }) => {
            try {
                const ctl = new AbortController();
                const t = setTimeout(() => ctl.abort(), timeoutMs);
                const r = await fetch(url, {
                    method, signal: ctl.signal,
                    headers: body ? { 'Content-Type': 'application/json' } : undefined,
                    body: body ? JSON.stringify(body) : undefined
                });
                clearTimeout(t);
                return { ok: r.ok, status: r.status, text: await r.text() };
            } catch (e) { return { ok: false, status: 0, text: String(e).slice(0, 200) }; }
        },
        play: async ({ url, title, startSec = 0 }) => {
            closePlayer(false);
            player = document.createElement('div');
            player.id = 'web-player';
            player.innerHTML = `
                <div class="wp-top"><span>${(title || '').replace(/</g, '&lt;')}</span>
                  <button class="wp-close">✕ Close</button></div>
                <video controls autoplay playsinline></video>
                <div class="wp-hint">Stream won’t play or no sound? That format needs the free desktop app —
                  <a href="https://couchking.app/downloads" target="_blank">couchking.app/downloads</a></div>`;
            const v = player.querySelector('video');
            v.src = url;
            if (startSec > 5) v.addEventListener('loadedmetadata', () => { try { v.currentTime = startSec; } catch {} }, { once: true });
            v.addEventListener('timeupdate', () => posCb && posCb({ pos: v.currentTime || 0, dur: v.duration || 0 }));
            v.addEventListener('ended', () => closePlayer(true));
            v.addEventListener('error', () => {
                player?.querySelector('.wp-hint')?.classList.add('err');
            });
            player.querySelector('.wp-close').onclick = () => closePlayer(true);
            document.body.appendChild(player);
            document.body.style.overflow = 'hidden';
            return { ok: true };
        },
        stopPlay: async () => { closePlayer(true); return { ok: true }; },
        onMpvPos: (cb) => { posCb = cb; },
        onMpvExit: (cb) => { exitCb = cb; },
    };
})();
