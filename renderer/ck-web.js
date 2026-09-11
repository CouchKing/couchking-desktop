// Web-browser shim: defines window.ck with the SAME API the Electron preload exposes.
// In the desktop app the preload has already created window.ck before any page script
// runs, so this file is a no-op there — the identical renderer runs in both worlds.
//
// Playback goes through the service's /webplay remux (video copied, audio → AAC the
// browser can decode, MKV → fragmented MP4) with custom controls styled like the TV
// player. Seeking reopens the stream at the new offset (fMP4 can't range-seek).
(function () {
    if (window.ck) return;
    const b64u = (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const fmt = (s) => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return (h ? h + ':' : '') + String(m).padStart(h ? 2 : 1, '0') + ':' + String(s % 60).padStart(2, '0'); };
    let posCb = null, exitCb = null, player = null, state = null;

    function closePlayer(fireExit) {
        if (!player) return;
        const st = state; state = null;
        const v = player.querySelector('video');
        try { v.pause(); v.removeAttribute('src'); v.load(); } catch {}
        player.remove(); player = null;
        document.body.style.overflow = '';
        if (fireExit && exitCb && st) exitCb({ pos: st.offset + (v?.currentTime || 0), dur: st.dur || 0 });
    }

    async function service() {
        return location.origin.includes('couchking') ? location.origin : 'https://couchking.app';
    }

    window.ck = {
        platform: 'web',
        service,
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
        play: async ({ url, title, startSec = 0, seekStep = 10 }) => {
            closePlayer(false);
            const SVC = await service();
            const u = b64u(url);
            state = { offset: startSec, dur: 0, u, SVC, step: seekStep || 10 };
            player = document.createElement('div');
            player.id = 'web-player';
            player.innerHTML = `
                <video autoplay playsinline></video>
                <div class="wp-ui">
                  <div class="wp-top"><button class="wp-btn wp-back">‹ Back</button><span class="wp-title"></span></div>
                  <div class="wp-bottom">
                    <div class="wp-bar"><div class="wp-fill"></div><div class="wp-dot"></div></div>
                    <div class="wp-times"><span class="wp-cur">0:00</span><span class="wp-dur">–:––</span></div>
                    <div class="wp-controls">
                      <div class="wp-cell"><span>Back ${seekStep}s</span><button class="wp-btn wp-rew">⏪</button></div>
                      <div class="wp-cell"><span>Play / Pause</span><button class="wp-btn wp-pp">⏸</button></div>
                      <div class="wp-cell"><span>Forward ${seekStep}s</span><button class="wp-btn wp-fwd">⏩</button></div>
                      <div class="wp-cell"><span>Volume</span><input class="wp-vol" type="range" min="0" max="1" step=".05" value="1"></div>
                      <div class="wp-cell"><span>Fullscreen</span><button class="wp-btn wp-fs">⛶</button></div>
                    </div>
                  </div>
                  <div class="wp-hint hidden">Trouble playing? Some formats need the free desktop app —
                    <a href="https://couchking.app/downloads" target="_blank">couchking.app/downloads</a></div>
                </div>`;
            player.querySelector('.wp-title').textContent = title || '';
            const v = player.querySelector('video');
            const ui = player.querySelector('.wp-ui');
            const src = (t) => `${SVC}/webplay?u=${u}&t=${Math.floor(t)}`;
            v.src = src(startSec);

            // real duration for the timeline (fMP4 stream itself reports none)
            fetch(`${SVC}/webplay/probe?u=${u}`).then(r => r.json()).then(d => {
                if (state) { state.dur = d.duration || 0; paint(); }
            }).catch(() => {});

            const cur = () => state ? state.offset + (v.currentTime || 0) : 0;
            const paint = () => {
                if (!state) return;
                player.querySelector('.wp-cur').textContent = fmt(cur());
                player.querySelector('.wp-dur').textContent = state.dur ? fmt(state.dur) : '–:––';
                const pct = state.dur ? Math.min(100, 100 * cur() / state.dur) : 0;
                player.querySelector('.wp-fill').style.width = pct + '%';
                player.querySelector('.wp-dot').style.left = pct + '%';
            };
            const seekTo = (t) => {
                if (!state) return;
                t = Math.max(0, state.dur ? Math.min(t, state.dur - 5) : t);
                state.offset = t; v.src = src(t); v.play().catch(() => {});
            };
            v.addEventListener('timeupdate', () => { paint(); posCb && posCb({ pos: cur(), dur: state?.dur || 0 }); });
            v.addEventListener('ended', () => closePlayer(true));
            v.addEventListener('error', () => player?.querySelector('.wp-hint')?.classList.remove('hidden'));
            v.addEventListener('play', () => { player.querySelector('.wp-pp').textContent = '⏸'; });
            v.addEventListener('pause', () => { player.querySelector('.wp-pp').textContent = '▶'; });

            player.querySelector('.wp-back').onclick = () => closePlayer(true);
            player.querySelector('.wp-pp').onclick = () => v.paused ? v.play() : v.pause();
            player.querySelector('.wp-rew').onclick = () => seekTo(cur() - state.step);
            player.querySelector('.wp-fwd').onclick = () => seekTo(cur() + state.step);
            player.querySelector('.wp-vol').oninput = (e) => { v.volume = +e.target.value; };
            player.querySelector('.wp-fs').onclick = () =>
                document.fullscreenElement ? document.exitFullscreen() : player.requestFullscreen().catch(() => {});
            player.querySelector('.wp-bar').onclick = (e) => {
                if (!state?.dur) return;
                const r = e.currentTarget.getBoundingClientRect();
                seekTo(state.dur * (e.clientX - r.left) / r.width);
            };
            v.onclick = () => v.paused ? v.play() : v.pause();

            // controls fade like the TV player: show on mouse move, hide after 3s idle
            let hideT = null;
            const wake = () => {
                ui.classList.remove('idle');
                clearTimeout(hideT);
                hideT = setTimeout(() => !v.paused && ui.classList.add('idle'), 3000);
            };
            player.addEventListener('mousemove', wake); wake();
            document.addEventListener('keydown', function keys(e) {
                if (!player) { document.removeEventListener('keydown', keys); return; }
                if (e.key === ' ') { e.preventDefault(); v.paused ? v.play() : v.pause(); }
                if (e.key === 'ArrowLeft') seekTo(cur() - state.step);
                if (e.key === 'ArrowRight') seekTo(cur() + state.step);
                if (e.key === 'Escape' && !document.fullscreenElement) closePlayer(true);
            });

            document.body.appendChild(player);
            document.body.style.overflow = 'hidden';
            return { ok: true };
        },
        stopPlay: async () => { closePlayer(true); return { ok: true }; },
        onMpvPos: (cb) => { posCb = cb; },
        onMpvExit: (cb) => { exitCb = cb; },
    };
})();
