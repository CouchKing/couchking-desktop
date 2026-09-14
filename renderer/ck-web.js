// The IN-WINDOW player + the web shim, shared by BOTH worlds (0.9.13):
//   • web: also defines window.ck (fetch/openExternal/etc.) exactly like before
//   • desktop: preload already made window.ck — this file adds the SAME in-window
//     player on top, and playback ROUTES here first (AJ Sep 14: raw mpv window is
//     "awful, hard to navigate"); mpv is a silent fallback for streams Chromium can't
//     decode (HEVC & friends — the reason mpv exists at all) and for runtime failures.
// app.js talks only to the unified surface at the bottom: ckPlay / ckStop / ckOnPos /
// ckOnExit — it never needs to know which engine is on screen.
//
// Playback goes through the service's /webplay remux (video copied, audio → AAC the
// browser can decode, MKV → fragmented MP4) with custom controls styled like the TV
// player: purple time bar, labeled buttons (word ABOVE icon), top overlay with clock +
// "Ends h:mm", Skip-intro from the learned window, and the UP NEXT card at credits time.
// Seeking reopens the stream at the new offset (fMP4 can't range-seek) — every position
// shown/reported is offset + video.currentTime, duration from /webplay/probe.
(function () {
    const DESK = !!window.ck;   // preload ran first = Electron
    const b64u = (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const fmt = (s) => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return (h ? h + ':' : '') + String(m).padStart(h ? 2 : 1, '0') + ':' + String(s % 60).padStart(2, '0'); };
    const clock = (d) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    let posCb = null, exitCb = null, player = null, state = null;
    let engine = null;   // 'web' | 'mpv' | null — which engine owns the current playback

    // cross-origin text fetch that works from the desktop's file:// page too (no CORS
    // over the IPC bridge) — subtitles + the OpenSubtitles feed go through here
    async function httpText(url) {
        if (DESK) { const r = await window.ck.http({ url, timeoutMs: 15000 }); return r?.ok ? r.text : null; }
        const r = await fetch(url); return r.ok ? r.text() : null;
    }

    function closePlayer(fireExit, extra) {
        if (!player) return;
        const st = state; state = null;
        const v = player.querySelector('video');
        // read the position BEFORE load() — load() resets currentTime to 0 and used to
        // collapse the exit beacon's saved position (the resume/false-watched bug)
        const posAtExit = st ? st.offset + (v?.currentTime || 0) : 0;
        clearInterval(st?.tick);
        clearTimeout(st?.fbTimer);
        try { v.pause(); v.removeAttribute('src'); v.load(); } catch {}
        player.remove(); player = null;
        document.body.style.overflow = '';
        if (fireExit && st) {
            engine = null;
            exitCb && exitCb({ pos: posAtExit, dur: st.dur || 0, lastCue: st.lastCue || 0, ...(extra || {}) });
        }
    }

    async function service() {
        if (DESK) return window.ck.service();
        return location.origin.includes('couchking') ? location.origin : 'https://couchking.app';
    }

    async function webPlay({ url, title, startSec = 0, seekStep = 10, sid = '', subs = [],
                       subScale = 1.0, subLang = 'en', subBg = false, subOutline = true, subPos = 0,
                       introFromMs = -1, introToMs = -1, creditsMs = 0, probeDur = 0,
                       localFile = '', inlineSubs = [],
                       nextLabel = '', hasNext = false, autonext = true }, hooks = null) {
            closePlayer(false);
            engine = 'web';
            const SVC = await service();
            const u = b64u(url);
            state = { offset: localFile ? 0 : startSec, dur: probeDur || 0, u, SVC, step: seekStep || 10,
                      cues: [], lastCue: 0, introHandled: false, nextShown: false, speed: 1,
                      started: false, fbTimer: null };
            player = document.createElement('div');
            player.id = 'web-player';
            player.innerHTML = `
                <video autoplay playsinline></video>
                <div class="wp-cue"></div>
                <div class="wp-ui">
                  <div class="wp-top">
                    <button class="wp-btn wp-back">‹ Back</button><span class="wp-title"></span>
                    <span class="wp-right"><span class="wp-clock"></span><span class="wp-ends"></span></span>
                  </div>
                  <button class="wp-skip hidden">Skip intro ⏭</button>
                  <div class="wp-next hidden">
                    <div class="wpn-tag">UP NEXT</div><div class="wpn-title"></div>
                    <div class="wpn-btns"><button class="wpn-play">▶ Play now</button><button class="wpn-dismiss">Dismiss</button></div>
                  </div>
                  <div class="wp-bottom">
                    <div class="wp-bar"><div class="wp-fill"></div><div class="wp-dot"></div></div>
                    <div class="wp-times"><span class="wp-cur">0:00</span><span class="wp-dur">–:––</span></div>
                    <div class="wp-controls">
                      <div class="wp-cell"><span>Back ${seekStep}s</span><button class="wp-btn wp-rew">⏪</button></div>
                      <div class="wp-cell"><span>Play / Pause</span><button class="wp-btn wp-pp">⏸</button></div>
                      <div class="wp-cell"><span>Forward ${seekStep}s</span><button class="wp-btn wp-fwd">⏩</button></div>
                      ${hasNext ? '<div class="wp-cell"><span>Next</span><button class="wp-btn wp-nextbtn">⏭</button></div>' : ''}
                      <div class="wp-cell"><span>Subtitles</span><button class="wp-btn wp-subs">💬</button></div>
                      <div class="wp-cell"><span>Sub Size</span><button class="wp-btn wp-subsize">Aa</button></div>
                      <div class="wp-cell"><span>Size</span><button class="wp-btn wp-scale">⤢</button></div>
                      <div class="wp-cell"><span>Speed</span><button class="wp-btn wp-speed">1×</button></div>
                      <div class="wp-cell"><span>Info</span><button class="wp-btn wp-info">ⓘ</button></div>
                      <div class="wp-cell"><span>Volume</span><input class="wp-vol" type="range" min="0" max="1" step=".05" value="1"></div>
                      <div class="wp-cell"><span>Fullscreen</span><button class="wp-btn wp-fs">⛶</button></div>
                    </div>
                  </div>
                  <div class="wp-menu hidden"></div>
                  <div class="wp-infobox hidden"></div>
                  <div class="wp-hint hidden">Trouble playing? Some formats need the free desktop app —
                    <a href="https://couchking.app/downloads" target="_blank">couchking.app/downloads</a></div>
                </div>`;
            player.querySelector('.wp-title').textContent = title || '';
            const v = player.querySelector('video');
            const ui = player.querySelector('.wp-ui');
            const src = (t) => localFile ? localFile : `${SVC}/webplay?u=${u}&t=${Math.floor(t)}`;
            v.src = src(startSec);
            if (localFile && startSec > 0) v.currentTime = startSec;
            // silent mpv fallback (desktop): if the in-window engine can't produce a frame
            // (codec the probe missed, remux hiccup), hand the SAME opts to mpv — the
            // viewer just sees playback start, never an error to deal with
            if (hooks?.fallback) state.fbTimer = setTimeout(() => {
                if (state && !state.started) { closePlayer(false); hooks.fallback(); }
            }, 12000);

            // ---- subtitles: OpenSubtitles v3 feed (same source as the TV app) via our
            // /websub CORS+VTT converter. Rendered by US into a centered, readable-width
            // block (never native full-screen-wide cues); cue times are ABSOLUTE, compared
            // against offset+currentTime, so seeking never needs a re-shift. ----
            const cueEl = player.querySelector('.wp-cue');
            const SIZES = [[.8, 'Small'], [1.0, 'Normal'], [1.3, 'Large'], [1.6, 'Huge']];
            let sizeIx = Math.max(0, SIZES.findIndex(x => Math.abs(x[0] - subScale) < .01));
            const styleCue = () => {
                cueEl.style.fontSize = (3.4 * SIZES[sizeIx][0]).toFixed(2) + 'vh';
                cueEl.style.background = subBg ? 'rgba(0,0,0,.75)' : 'transparent';
                cueEl.style.textShadow = subOutline
                    ? '0 0 5px #000, 0 0 5px #000, 1px 1px 2px #000, -1px -1px 2px #000' : 'none';
                cueEl.style.bottom = ({ 0: '9vh', 1: '16vh', 2: '24vh' })[subPos] || '9vh';
            };
            styleCue();
            const parseVtt = (txt) => {
                const cues = [];
                const re = /(\d{2,}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2,}):(\d{2}):(\d{2})[.,](\d{3})/;
                for (const b of txt.replace(/\r/g, '').split(/\n\n+/)) {
                    const lines = b.split('\n');
                    const ti = lines.findIndex(l => l.includes('-->'));
                    if (ti < 0) continue;
                    const m = lines[ti].match(re);
                    if (!m) continue;
                    const s = +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
                    const e = +m[5] * 3600 + +m[6] * 60 + +m[7] + +m[8] / 1000;
                    const text = lines.slice(ti + 1).join('\n').replace(/<[^>]+>/g, '').trim();
                    if (text && e > s) cues.push({ s, e, text });
                }
                return cues;
            };
            let subList = [], curSub = null;
            const paintCue = () => {
                if (!state) return;
                const t = cur();
                const c = state.cues.length ? state.cues.find(x => t >= x.s && t <= x.e) : null;
                const want = c ? c.text : '';
                if (cueEl.dataset.t !== want) { cueEl.dataset.t = want; cueEl.textContent = want; }
                cueEl.style.display = want ? 'block' : 'none';
            };
            const selectSub = async (s) => {
                curSub = s;
                if (state) state.cues = [];
                paintCue();
                player.querySelector('.wp-subs').classList.toggle('on', !!s);
                if (!s) return;
                try {
                    // downloaded episodes carry their subtitle text INSIDE the meta (offline)
                    const txt = s.vtt || await httpText(`${SVC}/websub?u=${b64u(s.url)}`);
                    if (!state || curSub !== s || !txt) return;
                    state.cues = parseVtt(txt);
                    state.lastCue = state.cues.reduce((m, c) => Math.max(m, c.e), 0);
                } catch {}
            };
            const menu = player.querySelector('.wp-menu');
            const openMenu = (items) => {
                menu.innerHTML = '';
                for (const [label, fn, on] of items) {
                    const b = document.createElement('button');
                    b.textContent = label; b.className = on ? 'on' : '';
                    b.onclick = () => { menu.classList.add('hidden'); fn(); };
                    menu.appendChild(b);
                }
                menu.classList.remove('hidden');
            };
            if (inlineSubs && inlineSubs.length) {
                // offline: subtitle text was saved WITH the download — no network at all
                subList = inlineSubs.map((x, i) => ({ vtt: x.vtt, lang: x.lang || 'English ' + (i + 1) }));
                if (subLang !== 'off' && subList[0]) selectSub(subList[0]);
            }
            if (sid && !localFile) {
                const type = sid.includes(':') ? 'series' : 'movie';
                // RANKED subs from the addon stream FIRST (release-matched = best sync, same
                // list the Firestick gets — AJ Sep 13: web only ever showed ONE English);
                // the public feed then fills more English options + other languages.
                const engCount = () => subList.filter(x => /^English/i.test(x.lang || '')).length;
                subList = (subs || []).filter(x => x && x.url)
                    .map((x, i) => ({ url: x.url, lang: 'English ' + (i + 1) }));
                if (subLang !== 'off' && subList[0]) selectSub(subList[0]);
                httpText(`https://opensubtitles-v3.strem.io/subtitles/${type}/${encodeURIComponent(sid)}.json`)
                    .then(t => JSON.parse(t || '{}')).then(d => {
                        const haveUrl = new Set(subList.map(x => x.url));
                        const perLang = new Set();
                        for (const s of (d.subtitles || [])) {
                            if (!s.url || haveUrl.has(s.url)) continue;
                            const en = /^en/i.test(s.lang || '');
                            if (en) {
                                if (engCount() >= 6) continue;
                                subList.push({ url: s.url, lang: 'English ' + (engCount() + 1) });
                            } else {
                                if (perLang.has(s.lang)) continue;
                                perLang.add(s.lang);
                                subList.push({ url: s.url, lang: s.lang });
                            }
                            haveUrl.add(s.url);
                        }
                        if (subLang === 'off' || curSub) return;
                        const pref = subList.find(x => (x.lang || '').toLowerCase().startsWith(subLang))
                            || subList.find(x => /^English/i.test(x.lang || ''));
                        if (pref) selectSub(pref);
                    }).catch(() => {});
            }
            player.querySelector('.wp-subs').onclick = () => menu.classList.contains('hidden')
                ? openMenu([['Subtitles off', () => selectSub(null), !curSub],
                    ...subList.slice(0, 14).map(s => [s.lang || '?', () => selectSub(s), curSub === s])])
                : menu.classList.add('hidden');
            player.querySelector('.wp-subsize').onclick = () => {
                sizeIx = (sizeIx + 1) % SIZES.length; styleCue();
                const c = player.querySelector('.wp-subsize'); c.textContent = SIZES[sizeIx][1];
                setTimeout(() => { c.textContent = 'Aa'; }, 1200);
            };
            const FITS = [['contain', 'Fit'], ['cover', 'Fill'], ['fill', 'Stretch']];
            let fitIx = 0;
            player.querySelector('.wp-scale').onclick = () => {
                fitIx = (fitIx + 1) % FITS.length;
                v.style.objectFit = FITS[fitIx][0];
                const c = player.querySelector('.wp-scale'); c.textContent = FITS[fitIx][1];
                setTimeout(() => { c.textContent = '⤢'; }, 1200);
            };
            // Speed: same cycle idea as the TV player's Speed button
            const SPEEDS = [1, 1.25, 1.5, 2, 0.75];
            let spIx = 0;
            player.querySelector('.wp-speed').onclick = () => {
                spIx = (spIx + 1) % SPEEDS.length;
                state.speed = SPEEDS[spIx];
                v.playbackRate = state.speed;
                player.querySelector('.wp-speed').textContent = SPEEDS[spIx] + '×';
            };
            // Info: what the stream actually is (web's version of the TV player's stats)
            const infoBox = player.querySelector('.wp-infobox');
            player.querySelector('.wp-info').onclick = () => {
                if (!infoBox.classList.contains('hidden')) { infoBox.classList.add('hidden'); return; }
                infoBox.textContent = [
                    v.videoWidth ? `${v.videoWidth}×${v.videoHeight}` : 'resolution unknown',
                    state.dur ? `length ${fmt(state.dur)}` : '',
                    `speed ${state.speed}×`,
                    `position ${fmt(cur())}`,
                ].filter(Boolean).join('\n');
                infoBox.classList.remove('hidden');
            };

            // real duration for the timeline (fMP4 stream itself reports none); the desktop
            // router already probed (probeDur rides in), a downloaded file reports its own
            if (!state.dur && !localFile)
                httpText(`${SVC}/webplay/probe?u=${u}`).then(t => {
                    const d = JSON.parse(t || '{}');
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
                state.offset = t; v.src = src(t);
                v.playbackRate = state.speed;
                v.play().catch(() => {});
                paintCue();
            };

            // ---- Skip intro + UP NEXT card + clock ("Ends h:mm"), 1-second ticker ----
            const skipBtn = player.querySelector('.wp-skip');
            const nextCard = player.querySelector('.wp-next');
            player.querySelector('.wpn-title').textContent = nextLabel || '';
            skipBtn.onclick = () => { state.introHandled = true; skipBtn.classList.add('hidden'); seekTo(introToMs / 1000); };
            const fireNext = () => {
                if (!state || !state.dur) { closePlayer(true, { next: true }); return; }
                const remMs = Math.max(0, Math.round((state.dur - cur()) * 1000));
                closePlayer(true, { next: true, credits: remMs });
            };
            if (hasNext) {
                player.querySelector('.wp-nextbtn').onclick = fireNext;
                player.querySelector('.wpn-play').onclick = fireNext;
                player.querySelector('.wpn-dismiss').onclick = () => nextCard.classList.add('hidden');
            }
            state.tick = setInterval(() => {
                if (!state) return;
                player.querySelector('.wp-clock').textContent = clock(new Date());
                if (state.dur > 0) {
                    const remaining = (state.dur - cur()) / (state.speed || 1);
                    player.querySelector('.wp-ends').textContent =
                        'Ends ' + clock(new Date(Date.now() + remaining * 1000));
                    // credits lead, best signal first (same rule as the TV player): the
                    // episode's own last subtitle cue → family's learned credits clicks → 90s
                    const subsLead = state.lastCue > 0 ? state.dur - state.lastCue - 2 : -1;
                    const lead = (subsLead >= 15 && subsLead <= 300) ? subsLead
                        : (creditsMs > 0 ? Math.min(240, Math.max(20, (creditsMs + 5000) / 1000)) : 90);
                    const remReal = state.dur - cur();
                    if (hasNext && !state.nextShown && remReal > 0 && remReal <= lead) {
                        state.nextShown = true;
                        nextCard.classList.remove('hidden');
                    }
                    // learned skip-intro window (from /player/resume): button lives inside it
                    if (!state.introHandled && introFromMs >= 0 && introToMs > introFromMs) {
                        const p = cur() * 1000;
                        const inWin = p >= introFromMs && p <= introToMs - 2000;
                        skipBtn.classList.toggle('hidden', !inWin);
                        if (!inWin && p >= introToMs - 2000) state.introHandled = true;
                    }
                }
                paintCue();
            }, 1000);

            v.addEventListener('loadedmetadata', () => {
                if (state && localFile && v.duration > 0 && isFinite(v.duration)) { state.dur = v.duration; paint(); }
            });
            v.addEventListener('timeupdate', () => {
                if (state && !state.started && v.currentTime > 0.3) { state.started = true; clearTimeout(state.fbTimer); }
                paint(); paintCue(); posCb && posCb({ pos: cur(), dur: state?.dur || 0 });
            });
            v.addEventListener('ended', () => {
                // finished for real: autoplay-next rides the exit (app decides via watched
                // rules); flag it so a finished episode advances even at odd durations
                if (hasNext && autonext) fireNext(); else closePlayer(true);
            });
            v.addEventListener('error', () => {
                // desktop: never show the viewer an error for a format problem — mpv takes
                // over silently with the exact same stream + resume point
                if (hooks?.fallback && state && !state.started) { closePlayer(false); hooks.fallback(); return; }
                player?.querySelector('.wp-hint')?.classList.remove('hidden');
            });
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
            return { ok: true, engine: 'web' };
    }

    if (!DESK) window.ck = {
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
        play: (o) => webPlay(o),
        stopPlay: async () => { closePlayer(true); return { ok: true }; },
        onMpvPos: (cb) => { posCb = cb; },
        onMpvExit: (cb) => { exitCb = cb; },
    };

    // ---- unified engine surface (0.9.13): app.js talks ONLY to these four ----
    const announceMpv = () => document.dispatchEvent(new CustomEvent('ck-engine', { detail: 'mpv' }));
    // codecs Chromium decodes; anything else (hevc/vc1/mpeg2...) goes straight to mpv.
    // Unknown/blank codec = try the window first — the 12s no-frame fallback still saves it.
    const CHROME_OK = ['', 'h264', 'avc1', 'vp8', 'vp9', 'av1', 'mpeg4', 'mjpeg'];
    window.ckPlay = async (opts) => {
        if (!DESK) return webPlay(opts);
        const toMpv = (o) => { engine = 'mpv'; announceMpv(); return window.ck.play(o); };
        if (opts.localFile)
            return webPlay(opts, { fallback: () => toMpv({ ...opts, url: opts.localFile }) });
        let p = null;
        try {
            const svc = await window.ck.service();
            const r = await window.ck.http({ url: `${svc}/webplay/probe?u=${b64u(opts.url)}`, timeoutMs: 14000 });
            p = r?.ok ? JSON.parse(r.text) : null;
        } catch {}
        if (p?.vcodec && !CHROME_OK.includes(String(p.vcodec).toLowerCase())) return toMpv(opts);
        if (p?.duration > 0) opts.probeDur = p.duration;
        return webPlay(opts, { fallback: () => toMpv(opts) });
    };
    window.ckStop = () => { if (DESK && engine === 'mpv') return window.ck.stopPlay(); closePlayer(true); };
    window.ckOnPos = (cb) => { posCb = cb; if (DESK) window.ck.onMpvPos((d) => { if (engine === 'mpv') cb(d); }); };
    window.ckOnExit = (cb) => { exitCb = cb; if (DESK) window.ck.onMpvExit((d) => { if (engine === 'mpv') { engine = null; cb(d); } }); };
})();
