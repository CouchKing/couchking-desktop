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

    // App-matched icons (AJ Sep 26 "look exactly like the app's icons") — these are the SAME
    // vector paths as the Android app's drawables (ic_play/ic_pause/ic_rew/ic_ffwd/… ), rendered
    // as inline SVG so the web player's buttons match the app pixel-for-pixel.
    const CK_ICONS = {
        play: 'M8,5v14l11,-7z',
        pause: 'M6,19h4V5H6zM14,5v14h4V5z',
        rew: 'M11,18V6l-8.5,6L11,18zM11.5,12l8.5,6V6l-8.5,6z',
        ffwd: 'M4,18l8.5,-6L4,6v12zM13,6v12l8.5,-6L13,6z',
        next: 'M6,18l8.5,-6L6,6v12zM16,6v12h2V6h-2z',
        subs: 'M20,4H4C2.9,4 2,4.9 2,6v12c0,1.1 0.9,2 2,2h16c1.1,0 2,-0.9 2,-2V6C22,4.9 21.1,4 20,4zM4,12h4v2H4V12zM14,18H4v-2h10V18zM20,18h-4v-2h4V18zM20,14H10v-2h10V14z',
        textsize: 'M2,10 h7 v2.3 h-2.3 V20 H4.3 v-7.7 H2 Z M11,4 h11 v2.8 h-4.1 V20 h-2.8 V6.8 H11 Z',
        scale: 'M15,3l2.3,2.3 -2.89,2.87 1.42,1.42L18.7,6.7 21,9V3h-6zM3,9l2.3,-2.3 2.87,2.89 1.42,-1.42L6.7,5.3 9,3H3v6zM9,21l-2.3,-2.3 2.89,-2.87 -1.42,-1.42L5.3,17.3 3,15v6h6zM21,15l-2.3,2.3 -2.87,-2.89 -1.42,1.42 2.89,2.87L15,21h6v-6z',
        speed: 'M20.38,8.57l-1.23,1.85a8,8 0,0 1,-0.22 7.58H5.07A8,8 0,0 1,15.58 6.85l1.85,-1.23A10,10 0,0 0,3.35 19a2,2 0,0 0,1.72 1h13.85a2,2 0,0 0,1.74 -1,10 10,0 0,0 -0.27,-10.44zM10.59,15.41a2,2 0,0 0,2.83 0l5.66,-8.49 -8.49,5.66a2,2 0,0 0,0 2.83z',
        info: 'M12,2C6.48,2 2,6.48 2,12s4.48,10 10,10 10,-4.48 10,-10S17.52,2 12,2zM13,17h-2v-6h2v6zM13,9h-2V7h2v2z',
        fav: 'M12,17.27L18.18,21l-1.64,-7.03L22,9.24l-7.19,-0.61L12,2 9.19,8.63 2,9.24l5.46,4.73L5.82,21z',
        guide: 'M3,5h18v2H3zM3,9h18v2H3zM3,13h12v2H3zM3,17h12v2H3z',
        fs: 'M7,14H5v5h5v-2H7v-3zM5,10h2V7h3V5H5v5zM17,17h-3v2h5v-5h-2v3zM14,5v2h3v3h2V5h-5z',
        pip: 'M19,7h-8v6h8V7zM21,3H3C1.9,3 1,3.9 1,5v14c0,1.1 0.9,2 2,2h18c1.1,0 2,-0.9 2,-2V5C23,3.9 22.1,3 21,3zM21,19H3V4.98h18V19z',
        cast: 'M1,18v3h3c0,-1.66 -1.34,-3 -3,-3zM1,14v2c2.76,0 5,2.24 5,5h2c0,-3.87 -3.13,-7 -7,-7zM1,10v2c4.97,0 9,4.03 9,9h2c0,-6.08 -4.93,-11 -11,-11zM21,3H3C1.9,3 1,3.9 1,5v3h2V5h18v14h-7v2h7c1.1,0 2,-0.9 2,-2V5C23,3.9 22.1,3 21,3z',
        restart: 'M12,5V1L7,6l5,5V7c3.31,0 6,2.69 6,6s-2.69,6 -6,6s-6,-2.69 -6,-6H4c0,4.42 3.58,8 8,8s8,-3.58 8,-8S16.42,5 12,5z',
    };
    const ckIc = (n) => `<svg viewBox="0 0 24 24" class="wpi" aria-hidden="true"><path d="${CK_ICONS[n] || ''}"/></svg>`;

    // Live-captions side panel CSS — matches the look of .wp-menu (see style.css) but
    // pinned to the RIGHT edge and vertically centred so it stays open while the viewer
    // clicks through tracks, and never covers the bottom-centre .wp-cue captions.
    if (!document.getElementById('wp-subpanel-css')) {
        const st = document.createElement('style');
        st.id = 'wp-subpanel-css';
        st.textContent = `
#web-player .wp-subpanel { position:absolute; right:0; top:50%; transform:translateY(-50%);
                           max-height:70vh; width:280px; overflow-y:auto;
                           background:var(--card); border:1px solid #37315C; border-right:none;
                           border-radius:16px 0 0 16px; padding:.7rem;
                           display:flex; flex-direction:column; gap:.2rem;
                           box-shadow:0 12px 40px #000C; z-index:120; }
#web-player .wp-subpanel .wp-sptitle { color:var(--muted); font-size:.72rem; font-weight:800;
                           text-transform:uppercase; letter-spacing:.08em; padding:.2rem .9rem .5rem; }
#web-player .wp-subpanel button { background:transparent; padding:.55rem .9rem; text-align:left;
                           border-radius:10px; font-size:.95rem; color:#fff; }
#web-player .wp-subpanel button:hover { background:#332D55; }
#web-player .wp-subpanel button.on { background:transparent; color:var(--accent); font-weight:800; }
#web-player .wp-subpanel button.on:hover { background:#332D55; }`;
        document.head.appendChild(st);
    }
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
        clearTimeout(st?.noticeT);
        // DESTROY the streaming engine, don't just pause the <video> (AJ Sep 18: a closed web/
        // desktop player kept pulling segments = kept its Live TV device slot held). hls.js /
        // mpegts.js keep fetching after a bare pause; destroy() closes the connections so the
        // slot frees (server sweeps it within ~15s once the beats stop).
        try { st?.hls?.destroy(); } catch {}
        try { st?.mp?.destroy(); } catch {}
        try { v.pause(); v.removeAttribute('src'); v.load(); } catch {}
        player.remove(); player = null;
        document.body.style.overflow = '';
        if (fireExit && st) {
            engine = null;
            // notice rides the exit so app.js never reports progress/watched for a message clip
            exitCb && exitCb({ pos: posAtExit, dur: st.dur || 0, lastCue: st.lastCue || 0, notice: !!st.notice, ...(extra || {}) });
        }
    }

    async function service() {
        if (DESK) return window.ck.service();
        return location.origin.includes('couchking') ? location.origin : 'https://couchking.app';
    }

    async function webPlay({ url, title, startSec = 0, seekStep = 10, sid = '', subs = [],
                       subScale = 1.0, subLang = 'en', subBg = false, subOutline = true, subPos = 0,
                       introFromMs = -1, introToMs = -1, creditsMs = 0, probeDur = 0,
                       recapFromMs = -1, recapToMs = -1, creditsAtMs = 0, refetchMarkers = null,
                       afterCredits = [],
                       localFile = '', inlineSubs = [],
                       nextLabel = '', hasNext = false, autonext = true }, hooks = null) {
            closePlayer(false);
            engine = 'web';
            const SVC = await service();
            const u = b64u(url);
            state = { offset: localFile ? 0 : startSec, dur: probeDur || 0, u, SVC, step: seekStep || 10,
                      cues: [], lastCue: 0, introHandled: false, recapHandled: false, nextShown: false, speed: 1,
                      started: false, fbTimer: null,
                      // server NOTICE/WAITING clip handling (Oct 22): notice = the stream URL is
                      // 302-serving a short message clip right now; resumeSec = where the viewer
                      // actually wanted to be, so the real file rejoins there when it appears
                      notice: false, noticeT: 0, resumeSec: startSec };
            player = document.createElement('div');
            player.id = 'web-player';
            player.innerHTML = `
                <video autoplay playsinline></video>
                <canvas class="wp-hold hidden"></canvas>
                <div class="wp-cue"></div>
                <div class="wp-ui">
                  <div class="wp-top">
                    <button class="wp-btn wp-back">‹ Back</button><span class="wp-title"></span>
                    <span class="wp-right"><span class="wp-clock"></span><span class="wp-ends"></span></span>
                    <button class="wp-btn wp-corner wp-pip" title="Pop out">${ckIc('pip')}</button>
                    <button class="wp-btn wp-corner wp-cast" title="Cast">${ckIc('cast')}</button>
                  </div>
                  <div class="wp-skiprow hidden"><button class="wp-skip">Skip intro ⏭</button><button class="wp-skipx">Dismiss</button></div>
                  <div class="wp-shuttle hidden"></div>
                  <div class="wp-center">
                    <button class="wp-btn wp-rew">${ckIc('rew')}</button>
                    <button class="wp-btn wp-pp">${ckIc('pause')}</button>
                    <button class="wp-btn wp-fwd">${ckIc('ffwd')}</button>
                  </div>
                  <div class="wp-next hidden">
                    <div class="wpn-tag">UP NEXT</div><div class="wpn-title"></div>
                    <div class="wpn-btns"><button class="wpn-play">▶ Play now</button><button class="wpn-dismiss">Dismiss</button></div>
                  </div>
                  <div class="wp-bottom">
                    <div class="wp-bar"><div class="wp-fill"></div><div class="wp-dot"></div></div>
                    <div class="wp-times"><span class="wp-cur">0:00</span><span class="wp-dur">–:––</span></div>
                    <div class="wp-controls">
                      ${hasNext ? `<div class="wp-cell"><span>Next</span><button class="wp-btn wp-nextbtn">${ckIc('next')}</button></div>` : ''}
                      <div class="wp-cell"><span>Subtitles</span><button class="wp-btn wp-subs">${ckIc('subs')}</button></div>
                      <div class="wp-cell"><span>Sub Size</span><button class="wp-btn wp-subsize">${ckIc('textsize')}</button></div>
                      <div class="wp-cell"><span>Size</span><button class="wp-btn wp-scale">${ckIc('scale')}</button></div>
                      <div class="wp-cell"><span>Speed</span><button class="wp-btn wp-speed">${ckIc('speed')}</button></div>
                      <div class="wp-cell"><span>Restart</span><button class="wp-btn wp-restart" title="Play from beginning">${ckIc('restart')}</button></div>
                      <div class="wp-cell"><span>Info</span><button class="wp-btn wp-info">${ckIc('info')}</button></div>
                      <div class="wp-cell"><span>Report</span><button class="wp-btn wp-report" title="Report a problem">${ckIc('info')}</button></div>
                      <div class="wp-cell"><span>Volume</span><input class="wp-vol" type="range" min="0" max="1" step=".05" value="1"></div>
                      <div class="wp-cell"><span>Fullscreen</span><button class="wp-btn wp-fs">${ckIc('fs')}</button></div>
                    </div>
                  </div>
                  <div class="wp-menu hidden"></div>
                  <div class="wp-subpanel hidden"></div>
                  <div class="wp-infobox hidden"></div>
                  <div class="wp-hint hidden">Trouble playing? Some formats need the free desktop app —
                    <a href="https://couchking.app/downloads" target="_blank">couchking.app/downloads</a></div>
                </div>`;
            player.querySelector('.wp-title').textContent = title || '';
            const v = player.querySelector('video');
            const ui = player.querySelector('.wp-ui');
            // POP-OUT (Picture-in-Picture) + CAST (AJ Sep 26 "pop out view to read a text + cast button").
            // PiP: manual button AND auto pop-out when you leave/hide the tab while it's playing, so it
            // keeps going in the corner. Cast: Remote Playback API (AirPlay / Chromecast where supported).
            (() => {
                const pip = player.querySelector('.wp-pip'), cast = player.querySelector('.wp-cast');
                // coming back from pop-out shouldn't pause it (AJ Sep 26): some browsers pause on
                // PiP exit — resume if it wasn't a deliberate pause.
                v.addEventListener('leavepictureinpicture', () => setTimeout(() => { if (v.paused) v.play().catch(() => {}); }, 120));
                v.addEventListener('webkitpresentationmodechanged', () => { if (v.webkitPresentationMode !== 'picture-in-picture' && v.paused) v.play().catch(() => {}); });
                const stdPiP = document.pictureInPictureEnabled && !v.disablePictureInPicture;
                const wkPiP = typeof v.webkitSupportsPresentationMode === 'function'
                              && v.webkitSupportsPresentationMode('picture-in-picture');   // iOS Safari
                if (stdPiP) {                       // Android Chrome / desktop
                    pip.onclick = () => (document.pictureInPictureElement
                        ? document.exitPictureInPicture() : v.requestPictureInPicture()).catch(() => {});
                    // auto pop-out on app/tab switch — the browser must do this ITSELF (you can't
                    // request PiP once the page is already hidden, which is why swiping away kept
                    // audio but never popped out — AJ Sep 26). autoPictureInPicture is that hook.
                    try { v.autoPictureInPicture = true; v.setAttribute('autopictureinpicture', ''); } catch (e) {}
                } else if (wkPiP) {                 // iOS Safari WebKit PiP
                    pip.onclick = () => { try {
                        v.webkitSetPresentationMode(v.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
                    } catch (e) {} };
                } else { pip.style.display = 'none'; }
                // Cast: Remote Playback (Android/desktop Chrome → Chromecast) or WebKit AirPlay (iOS)
                if (v.remote && typeof v.remote.prompt === 'function') {
                    try { v.remote.watchAvailability(() => {}).catch(() => {}); } catch (e) {}  // start cast-device discovery NOW so the button is ready fast (AJ Sep 26)
                    cast.onclick = () => v.remote.prompt().catch(() => {});
                } else if (typeof v.webkitShowPlaybackTargetPicker === 'function') {
                    cast.onclick = () => { try { v.webkitShowPlaybackTargetPicker(); } catch (e) {} };
                } else { cast.style.display = 'none'; }
            })();
            // iPhone/iPad Safari can't play the fragmented-MP4 /webplay stream, but it plays HLS
            // natively (AJ Sep 26 "make it work on iphone"). Route iOS through /webhls; everything
            // else keeps the fMP4 fast path. (iPadOS reports as Mac, so also catch touch-Mac.)
            const _isIOS = /iP(hone|ad|od)/.test(navigator.userAgent)
                || (/Macintosh/.test(navigator.userAgent) && (navigator.maxTouchPoints || 0) > 1);
            const src = (t) => localFile ? localFile
                : `${SVC}/${_isIOS ? 'webhls' : 'webplay'}?u=${u}&t=${Math.floor(t)}`;
            // /webplay stream-copies video, so after a seek it really starts at the
            // KEYFRAME before the asked second — up to several seconds early. Everything
            // here (cues, timeline, reported resume) assumed start == asked second, which
            // is why subs drifted after seeks while phones (exact-seek, original file)
            // stayed accurate. The server now reports the real start; snap offset to it.
            let seekSeq = 0;
            const syncStart = (t) => {
                if (localFile || !state || t <= 0) return;
                const seq = ++seekSeq;
                fetch(`${SVC}/webplay/start?u=${u}&t=${Math.floor(t)}`)
                    .then(r => r.json()).then(d => {
                        if (!state || seq !== seekSeq) return;
                        const real = +d.start;
                        if (isFinite(real) && real >= 0 && Math.abs(real - t) < 30) state.offset = real;
                    }).catch(() => {});
            };
            v.src = src(startSec);
            if (localFile && startSec > 0) v.currentTime = startSec;
            syncStart(startSec);
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
            // entities show up literally in a hand-rendered cue (&amp;#39; etc) — decode;
            // strip tags again AFTER decoding so encoded markup (&lt;i&gt;) drops too.
            // Two passes: OpenSubtitles files are often DOUBLE-encoded (&amp;#39;)
            const unent1 = (s) => s
                .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
                .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
                .replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
            const unent = (s) => unent1(unent1(s));
            const parseVtt = (txt) => {
                const cues = [];
                // hours are OPTIONAL (MM:SS.mmm is legal VTT and common) — the old
                // HH:MM:SS-only regex silently dropped every hourless cue
                const re = /(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[.,](\d{3})\s*-->\s*(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[.,](\d{3})/;
                for (const b of txt.replace(/\r/g, '').split(/\n\n+/)) {
                    const lines = b.split('\n');
                    const ti = lines.findIndex(l => l.includes('-->'));
                    if (ti < 0) continue;
                    const m = lines[ti].match(re);
                    if (!m) continue;
                    const s = (+m[1] || 0) * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
                    const e = (+m[5] || 0) * 3600 + +m[6] * 60 + +m[7] + +m[8] / 1000;
                    const text = unent(lines.slice(ti + 1).join('\n').replace(/<[^>]+>/g, ''))
                        .replace(/<[^>]+>/g, '').trim();
                    if (text && e > s) cues.push({ s, e, text });
                }
                return cues;
            };
            let subList = [], curSub = null, subAbort = null, subAuto = true;
            const paintCue = () => {
                if (!state) return;
                const t = cur();
                const c = state.cues.length ? state.cues.find(x => t >= x.s && t <= x.e) : null;
                const want = c ? c.text : '';
                if (cueEl.dataset.t !== want) { cueEl.dataset.t = want; cueEl.textContent = want; }
                cueEl.style.display = want ? 'block' : 'none';
            };
            // Embedded tracks stream PROGRESSIVELY from the current position: subtitle
            // packets are interleaved through the whole video, so a from-the-top pull
            // would take minutes — from-here makes the visible cues arrive immediately
            // while the rest fills in behind. -copyts on the server keeps timestamps
            // absolute, so cues drop straight into the same clock as everything else.
            const loadEmbed = (s, from) => {
                const ac = new AbortController(); subAbort = ac;
                fetch(`${SVC}/webplay/subx?u=${u}&i=${s.embed}&t=${Math.max(0, Math.floor((from || 0) - 8))}`,
                    { signal: ac.signal }).then(async r => {
                    if (!r.ok || !r.body) return;
                    const rd = r.body.getReader(); const dec = new TextDecoder();
                    let buf = '';
                    while (true) {
                        const { done, value } = await rd.read();
                        if (!state || curSub !== s) { ac.abort(); return; }
                        if (value) { buf += dec.decode(value, { stream: true }); state.cues = parseVtt(buf); }
                        if (done) break;
                    }
                    if (state && curSub === s)
                        state.lastCue = state.cues.reduce((m, c) => Math.max(m, c.e), 0);
                }).catch(() => {});
            };
            const selectSub = async (s, auto) => {
                curSub = s; subAuto = !!auto;
                if (subAbort) { subAbort.abort(); subAbort = null; }
                if (state) state.cues = [];
                paintCue();
                player.querySelector('.wp-subs').classList.toggle('on', !!s);
                if (!s) return;
                if (s.embed != null) { loadEmbed(s, cur()); return; }
                try {
                    // downloaded episodes carry their subtitle text INSIDE the meta (offline)
                    const txt = s.vtt || await httpText(`${SVC}/websub?u=${b64u(s.url)}`);
                    if (!state || curSub !== s || !txt) return;
                    state.cues = parseVtt(txt);
                    state.lastCue = state.cues.reduce((m, c) => Math.max(m, c.e), 0);
                } catch {}
            };
            const menu = player.querySelector('.wp-menu');
            // Live-captions side panel: a scrollable track list pinned to the right that
            // STAYS OPEN as tracks are clicked (each applied live via selectSub), so the
            // viewer can watch the on-screen cues and find the one that lines up. It only
            // closes on the 💬 toggle, Back/close, or a controls tap.
            const subPanel = player.querySelector('.wp-subpanel');
            const renderSubPanel = () => {
                subPanel.innerHTML = '';
                const h = document.createElement('div');
                h.className = 'wp-sptitle'; h.textContent = 'Subtitles';
                subPanel.appendChild(h);
                const row = (label, fn, on) => {
                    const b = document.createElement('button');
                    b.textContent = on ? label + '   ✓' : label;
                    b.className = on ? 'on' : '';
                    b.onclick = () => { fn(); renderSubPanel(); };   // re-render moves the ✓, panel stays open
                    subPanel.appendChild(b);
                };
                // a USER pick here is a profile choice — persist it like the Firestick's
                // in-player toggle does (app.js listens and writes the synced sublang pref)
                const saySub = (v) => { try { document.dispatchEvent(new CustomEvent('ck-sublang', { detail: v })); } catch {} };
                row('Subtitles off', () => { selectSub(null); saySub('off'); }, !curSub);
                for (const s of subList) row(s.lang || '?', () => { selectSub(s); saySub('en'); }, curSub === s);
            };
            // CouchKing panel: section title on top, current choice purple with a ✓
            const openMenu = (title, items) => {
                menu.innerHTML = '';
                const h = document.createElement('div');
                h.className = 'wp-mtitle'; h.textContent = title;
                menu.appendChild(h);
                let onBtn = null;
                for (const [label, fn, on] of items) {
                    const b = document.createElement('button');
                    b.textContent = label; b.className = on ? 'on' : '';
                    if (on) { b.textContent += '   ✓'; onBtn = b; }
                    b.onclick = () => { menu.classList.add('hidden'); fn(); };
                    menu.appendChild(b);
                }
                menu.classList.remove('hidden');
                if (onBtn) onBtn.scrollIntoView({ block: 'nearest' });
            };
            if (inlineSubs && inlineSubs.length) {
                // offline: subtitle text was saved WITH the download — no network at all
                subList = inlineSubs.map((x, i) => ({ vtt: x.vtt, lang: x.lang || 'English ' + (i + 1) }));
                if (subLang !== 'off' && subList[0]) selectSub(subList[0]);
            }
            if (sid && !localFile) {
                const type = sid.includes(':') ? 'series' : 'movie';
                // ENGLISH ONLY, BEST FIRST (AJ Sep 14): embedded in-video tracks land on
                // top when the probe answers (exact-release sync), then the addon's
                // RANKED list (release-matched, HI labeled), then feed extras. No other
                // languages in the menu at all.
                const engCount = () => subList.filter(x => x.url).length;
                subList = (subs || []).filter(x => x && x.url)
                    .map((x, i) => ({ url: x.url, lang: x.name || 'English ' + (i + 1) }));
                if (subLang !== 'off' && subList[0]) selectSub(subList[0], true);
                httpText(`https://opensubtitles-v3.strem.io/subtitles/${type}/${encodeURIComponent(sid)}.json`)
                    .then(t => JSON.parse(t || '{}')).then(d => {
                        const haveUrl = new Set(subList.map(x => x.url));
                        for (const s of (d.subtitles || [])) {
                            if (!s.url || haveUrl.has(s.url)) continue;
                            if (!/^en/i.test(s.lang || '')) continue;
                            if (engCount() >= 20) break;
                            subList.push({ url: s.url, lang: 'English ' + (engCount() + 1) });
                            haveUrl.add(s.url);
                        }
                        if (subLang === 'off' || curSub) return;
                        const pref = subList.find(x => x.url);
                        if (pref) selectSub(pref, true);
                    }).catch(() => {});
            }
            // TOGGLE the live side panel (not the auto-closing openMenu) so tracks can be
            // sampled one after another; empty subList still shows just "Subtitles off"
            player.querySelector('.wp-subs').onclick = () => {
                if (subPanel.classList.contains('hidden')) { renderSubPanel(); subPanel.classList.remove('hidden'); }
                else subPanel.classList.add('hidden');
            };
            // reset timers are CANCELLED on re-click — stacked timeouts made the label
            // flip back mid-cycling and lag behind fast presses (AJ Sep 14)
            let sizeT = null, fitT = null;
            player.querySelector('.wp-subsize').onclick = () => {
                sizeIx = (sizeIx + 1) % SIZES.length; styleCue();
                const c = player.querySelector('.wp-subsize'); c.textContent = SIZES[sizeIx][1];
                clearTimeout(sizeT); sizeT = setTimeout(() => { c.textContent = 'Aa'; }, 1200);
            };
            const FITS = [['contain', 'Fit'], ['cover', 'Fill'], ['fill', 'Stretch']];
            let fitIx = 0;
            player.querySelector('.wp-scale').onclick = () => {
                fitIx = (fitIx + 1) % FITS.length;
                v.style.objectFit = FITS[fitIx][0];
                const c = player.querySelector('.wp-scale'); c.textContent = FITS[fitIx][1];
                clearTimeout(fitT); fitT = setTimeout(() => { c.textContent = '⤢'; }, 1200);
            };
            // Speed: real menu, same options + look as the TV/player apps
            const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
            player.querySelector('.wp-speed').onclick = () => menu.classList.contains('hidden')
                ? openMenu('Speed', SPEEDS.map(sp => [sp === 1 ? 'Normal' : sp + '×', () => {
                    state.speed = sp; v.playbackRate = sp;
                    player.querySelector('.wp-speed').title = sp + '×';
                }, state.speed === sp]))
                : menu.classList.add('hidden');
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
            // 🛟 REPORT A PROBLEM (AJ Oct 17): type the problem, Send → the server's Problem
            // Reports channel with who/where/version attached. Identity rides window.ckIdent
            // (app.js keeps it current with the active profile); absent = IP-labelled.
            const reportBtn = player.querySelector('.wp-report');
            if (reportBtn) reportBtn.onclick = () => {
                if (!infoBox.classList.contains('hidden')) infoBox.classList.add('hidden');
                let box = player.querySelector('.wp-reportbox');
                if (box) { box.remove(); return; }   // toggle off
                box = document.createElement('div');
                box.className = 'wp-reportbox';
                box.innerHTML = `<div class="wp-rpt-title">🛟 Report a problem</div>
                    <textarea class="wp-rpt-text" rows="3" placeholder="What's wrong? Type it here…"></textarea>
                    <div class="wp-rpt-row"><button class="wp-btn wp-rpt-send">Send</button>
                    <button class="wp-btn wp-rpt-cancel">Cancel</button></div>`;
                player.querySelector('.wp-ui').appendChild(box);
                const ta = box.querySelector('.wp-rpt-text'); ta.focus();
                box.querySelector('.wp-rpt-cancel').onclick = () => box.remove();
                box.querySelector('.wp-rpt-send').onclick = async () => {
                    const txt = ta.value.trim();
                    if (!txt) { ta.focus(); return; }
                    const id = (window.ckIdent || {});
                    const posS = Math.floor(cur());
                    try {
                        await fetch(`${SVC}/tvapp/report`, {
                            method: 'POST', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                text: txt, u: id.user || '', key: id.key || '',
                                v: 'web', model: navigator.platform || 'web',
                                ctx: `Web player — ${title || '?'} @ ${Math.floor(posS / 60)}m${posS % 60}s`,
                            }),
                        });
                        box.innerHTML = '<div class="wp-rpt-title">Sent — thank you! 🛟</div>';
                        setTimeout(() => box.remove(), 1600);
                    } catch { box.innerHTML = '<div class="wp-rpt-title">Couldn\'t send — try again in a minute</div>'; setTimeout(() => box.remove(), 2200); }
                };
            };

            // real duration for the timeline (fMP4 stream itself reports none); the desktop
            // router already probed (probeDur rides in), a downloaded file reports its own
            if (!state.dur && !localFile)
                httpText(`${SVC}/webplay/probe?u=${u}`).then(t => {
                    const d = JSON.parse(t || '{}');
                    if (state) { state.dur = d.duration || 0; paint(); maybeNotice(); }
                    // embedded ENGLISH tracks (full + SDH; forced skipped) go on TOP of
                    // the subtitle menu — cut for this exact release, best sync we have.
                    // An automatic pick upgrades to the full embedded track; a choice
                    // the viewer made by hand is never overridden.
                    if (state && Array.isArray(d.subs) && !localFile) {
                        const isEng = x => /^en/i.test(x.lang || '') || /english/i.test(x.title || '');
                        const isSdh = x => !!x.hi || /sdh|hearing|\bcc\b/i.test(x.title || '');
                        const isForced = x => !!x.forced || /forced/i.test(x.title || '');
                        // fully-untagged in-mux text track (TrollHD-style WEB-DLs) = the release's
                        // own English subs cut for THIS file — count it (AJ Oct 12, Gilmore S1E7)
                        const isUntagged = x => !(x.lang && x.lang !== 'und') && !x.title;
                        const emb = d.subs.filter(x => (isEng(x) || isUntagged(x)) && !isForced(x))
                            .sort((a, b) => isSdh(b) - isSdh(a)) // SDH FIRST (AJ Oct 22): emb[0] is auto-selected below — the release's SDH track is the default now
                            .map(x => ({ embed: x.i, lang: 'English — in video' + (isSdh(x) ? ' (SDH)' : '') }));
                        const seen = {};
                        for (const e of emb) {
                            if (seen[e.lang]) e.lang += ' ' + (++seen[e.lang]);
                            else seen[e.lang] = 1;
                        }
                        if (emb.length) {
                            subList.unshift(...emb);
                            if (subLang !== 'off' && (subAuto || !curSub)) selectSub(emb[0], true);
                        }
                    }
                }).catch(() => {});

            const cur = () => state ? state.offset + (v.currentTime || 0) : 0;
            let dragging = false;   // scrubbing the seekbar — don't let the tick overwrite the drag
            const paint = () => {
                if (!state || dragging) return;
                player.querySelector('.wp-cur').textContent = fmt(cur());
                player.querySelector('.wp-dur').textContent = state.dur ? fmt(state.dur) : '–:––';
                const pct = state.dur ? Math.min(100, 100 * cur() / state.dur) : 0;
                player.querySelector('.wp-fill').style.width = pct + '%';
                player.querySelector('.wp-dot').style.left = pct + '%';
            };
            // HOLD LAST FRAME over the seek reload (AJ Oct 4 "black screen looks dead"): snapshot
            // the on-screen frame into a canvas overlay BEFORE swapping src, drop it the moment
            // the new stream paints its first frame (rVFC where available). A cross-origin frame
            // only taints the canvas for readback — drawing + displaying is always allowed.
            const holdC = player.querySelector('.wp-hold');
            let holdT = null;
            const holdHide = () => { clearTimeout(holdT); holdC.classList.add('hidden'); };
            const holdShow = () => { try {
                if (!v.videoWidth || v.readyState < 2) return;
                holdC.width = v.videoWidth; holdC.height = v.videoHeight;
                holdC.getContext('2d').drawImage(v, 0, 0);
                holdC.classList.remove('hidden');
                clearTimeout(holdT);
                holdT = setTimeout(holdHide, 20000);   // never stick past a genuinely dead reload
            } catch (e) {} };
            const seekTo = (t) => {
                if (!state) return;
                t = Math.max(0, state.dur ? Math.min(t, state.dur - 5) : t);
                holdShow();
                state.offset = t; v.src = src(t); syncStart(t);
                // hide on the NEW source's first decodable frame. NOT rVFC-at-swap: a last
                // composited frame of the OLD stream satisfies that instantly and the hold
                // vanished before the reload even started (AJ Oct 4 "web doesn't do it")
                v.addEventListener('loadeddata', holdHide, { once: true });
                // an embedded track only streamed from the old position — refetch from here
                if (curSub && curSub.embed != null) {
                    if (subAbort) subAbort.abort();
                    state.cues = [];
                    loadEmbed(curSub, t);
                }
                v.playbackRate = state.speed;
                v.play().catch(() => {});
                paintCue();
            };

            // ---- Skip intro + UP NEXT card + clock ("Ends h:mm"), 1-second ticker ----
            const skipBtn = player.querySelector('.wp-skip');
            const skipRow = player.querySelector('.wp-skiprow');
            const nextCard = player.querySelector('.wp-next');
            player.querySelector('.wpn-title').textContent = nextLabel || '';
            skipBtn.onclick = () => {
                if (state.skipMode === 'after' && state.pendingAfter > 0) {
                    skipRow.classList.add('hidden'); seekTo(state.pendingAfter / 1000);
                } else if (state.skipMode === 'recap') {
                    // Skip Recap (Oct 16, parity with the TV player): recapTo = the measured
                    // intro start, so this can never overshoot content
                    state.recapHandled = true; skipRow.classList.add('hidden');
                    // skipMode must leave 'recap' or the intro branch (guarded on it) never shows again
                    state.skipMode = 'intro';
                    if (recapToMs > cur() * 1000) seekTo(recapToMs / 1000);
                } else { state.introHandled = true; skipRow.classList.add('hidden'); seekTo(introToMs / 1000); }
            };
            // Dismiss (AJ Oct 15): hides the skip pill for the rest of this window, like
            // the next-up card's Dismiss
            player.querySelector('.wp-skipx').onclick = () => {
                if (state.skipMode === 'after') state.afterDismissed = true;
                else if (state.skipMode === 'recap') { state.recapHandled = true; state.skipMode = 'intro'; }
                else state.introHandled = true;
                skipRow.classList.add('hidden');
            };
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
            // ---- server NOTICE clips (Oct 22, parity w/ the TV app): the stream URL can 302
            // to a short message clip instead of the episode — ck-toomany (~24s device limit),
            // ck-notreleased (20s), ck-unaired / ck-nostream, or the "getting ready" loop
            // (~30s / ~5min signature). DURATION is the tell: no real episode/movie is ever
            // 3–90s or 295–305s. Treat it LIVE-style: seek bar + times hidden, NOTHING counts
            // (no progress, no watched, no next-up, no auto-advance), the clip loops on end,
            // and a 20s HEAD probe of the ORIGINAL stream URL hot-swaps the real file in at
            // the viewer's intended resume point the moment the 302 stops pointing at a notice.
            const NOTICE_RX = /_downloading|ck-toomany|ck-notreleased|ck-unaired|ck-nostream/;
            const noticeChrome = (on) => {
                for (const sel of ['.wp-bar', '.wp-times', '.wp-ends'])
                    { const el = player.querySelector(sel); if (el) el.style.display = on ? 'none' : ''; }
                if (on) nextCard.classList.add('hidden');
            };
            function maybeNotice() {
                if (!state || state.notice || localFile || !sid) return;
                const d = state.dur;
                if (!((d >= 3 && d <= 90) || (d >= 295 && d <= 305))) return;
                state.notice = true;
                state.nextShown = true;             // UP NEXT must never pop over a notice
                noticeChrome(true);
                // a resume point deeper than the clip = ffmpeg opens past EOF = black screen
                if (state.offset >= d - 1) seekTo(0);
                armNoticeProbe();
            }
            function armNoticeProbe() {
                if (!state) return;
                clearTimeout(state.noticeT);
                state.noticeT = setTimeout(async () => {
                    if (!state || !state.notice) return;
                    let fin = '';
                    try {
                        if (DESK && window.ck.http) {   // main process follows redirects CORS-free
                            const r = await window.ck.http({ url, method: 'HEAD', timeoutMs: 18000 });
                            fin = (r && r.url) || '';
                        } else {
                            const r = await fetch(url, { method: 'HEAD' });
                            fin = r.url || '';
                        }
                    } catch (e) {}   // cross-origin final hop (real CDN file, no CORS) = not a notice
                    if (!state || !state.notice) return;
                    if (fin && NOTICE_RX.test(fin)) { armNoticeProbe(); return; }   // still blocked — keep waiting
                    // the URL serves the real stream now — restore the chrome and rejoin where
                    // the viewer meant to be; if it's somehow STILL short, the re-probe re-flags
                    state.notice = false;
                    state.nextShown = false;
                    noticeChrome(false);
                    state.dur = 0;
                    httpText(`${SVC}/webplay/probe?u=${u}`).then(t => {
                        const d2 = JSON.parse(t || '{}');
                        if (state) { state.dur = d2.duration || 0; paint(); maybeNotice(); }
                    }).catch(() => {});
                    seekTo(state.resumeSec || 0);
                    v.play().catch(() => {});
                }, 20000);
            }
            // PiP + OS media controls (AJ Sep 28): expose 10s-back / 10s-forward / Next-episode as
            // buttons inside the Picture-in-Picture window (and the OS/lock-screen media UI) via the
            // Media Session API — Chrome/Edge render seek + next-track handlers as PiP buttons.
            if ('mediaSession' in navigator) {
                try {
                    navigator.mediaSession.metadata = new MediaMetadata({ title: title || 'CouchKing', artist: nextLabel ? '' : '' });
                    navigator.mediaSession.setActionHandler('seekbackward', () => seekTo(cur() - state.step));
                    navigator.mediaSession.setActionHandler('seekforward', () => seekTo(cur() + state.step));
                    navigator.mediaSession.setActionHandler('nexttrack', hasNext ? fireNext : null);
                } catch (e) {}
            }
            // MARKER RE-POLL (Oct 16, AJ's Landman E10): the analyzer often publishes
            // intro/recap windows DURING the first viewer's watch — one fetch at open missed
            // them and the pills never appeared. Markers only; never touches position.
            if (refetchMarkers && introFromMs < 0 && recapFromMs < 0) {
                for (const d of [300000, 720000]) setTimeout(async () => {
                    if (!state || introFromMs >= 0) return;
                    try {
                        const r = await refetchMarkers();
                        if (!state || !r) return;
                        if (r.introFrom != null && r.introTo > r.introFrom) { introFromMs = r.introFrom; introToMs = r.introTo; }
                        if (r.recapFrom != null && r.recapTo > r.recapFrom) { recapFromMs = r.recapFrom; recapToMs = r.recapTo; }
                        if (r.creditsAt > 0) creditsAtMs = r.creditsAt;
                        if (r.credits > 0) creditsMs = r.credits;
                    } catch (e) {}
                }, d);
            }
            state.tick = setInterval(() => {
                if (!state) return;
                player.querySelector('.wp-clock').textContent = clock(new Date());
                if (state.dur > 0) {
                    const remaining = (state.dur - cur()) / (state.speed || 1);
                    player.querySelector('.wp-ends').textContent =
                        'Ends ' + clock(new Date(Date.now() + remaining * 1000));
                    // credits lead, best signal first (same rule as the TV player): the
                    // episode's own last subtitle cue → family's learned credits clicks
                    const subsLead = state.lastCue > 0 ? state.dur - state.lastCue - 2 : -1;
                    // exact end-credits chapter from the served file (Oct 16) beats everything
                    const exactLead = creditsAtMs > 0 ? state.dur - creditsAtMs / 1000 : -1;
                    // card pops where the credits START, not early (AJ Oct 15 "right at the
                    // end almost"): the server already biases learned clicks 30s early, so
                    // the old client +30s stacked into "minutes early". No signal at all =
                    // 10s before file end (was a 90s guess). Still capped at 3min.
                    // +10s: pop BEFORE the content ends (AJ Oct 16 "10 seconds before the
                    // episode is over" — the learned next-click median is measured after people
                    // sat through some credits, so the signal alone runs late). No signal at
                    // all = 60s before file end (10s was deep in the credits on first watch).
                    const sig = (exactLead >= 10 && exactLead <= 600) ? exactLead
                        : (subsLead >= 15 && subsLead <= 300) ? subsLead
                        : (creditsMs > 0 ? Math.min(240, Math.max(20, (creditsMs + 5000) / 1000)) : -1);
                    const lead = sig >= 0 ? sig + 10 : 60;
                    const remReal = state.dur - cur();
                    if (hasNext && !state.nextShown && !state.notice && remReal > 0 && remReal <= Math.min(lead, 180)) {
                        state.nextShown = true;
                        nextCard.classList.remove('hidden');
                    }
                    // Skip Recap window (Oct 16): sits before the intro; chapter- or
                    // subtitle-derived ("previously on" cue), end = measured intro start
                    if (!state.recapHandled && recapFromMs >= 0 && recapToMs > recapFromMs) {
                        const p = cur() * 1000;
                        const inR = p >= recapFromMs && p <= recapToMs - 2000;
                        if (inR) {
                            state.skipMode = 'recap'; skipBtn.textContent = 'Skip recap ⏭';
                            skipRow.classList.remove('hidden');
                        } else if (state.skipMode === 'recap') {
                            skipRow.classList.add('hidden'); state.skipMode = 'intro';
                            if (p >= recapToMs - 2000) state.recapHandled = true;
                        }
                    }
                    // learned skip-intro window (from /player/resume): button lives inside it
                    if (!state.introHandled && introFromMs >= 0 && introToMs > introFromMs
                        && state.skipMode !== 'recap') {
                        const p = cur() * 1000;
                        const inWin = p >= introFromMs && p <= introToMs - 2000;
                        if (inWin) { state.skipMode = 'intro'; skipBtn.textContent = 'Skip intro ⏭'; }
                        skipRow.classList.toggle('hidden', !inWin);
                        if (!inWin && p >= introToMs - 2000) state.introHandled = true;
                    }
                    // after-credits (AJ Sep 16): jump-to-scene button per stinger, in sequence
                    if (afterCredits.length) {
                        const p = cur() * 1000;
                        const nextAc = afterCredits.find(x => x.from > p + 1500);
                        const prevEnd = Math.max(-1, ...afterCredits.filter(x => x.to <= p).map(x => x.to));
                        const creditsPt = (state.dur * 1000) - (creditsMs || 90000);
                        const floor = nextAc ? Math.max(creditsPt, nextAc.from - 90000, prevEnd) : Infinity;
                        const inAfter = nextAc && !state.afterDismissed && p >= floor && p < nextAc.from - 1500 && !(introFromMs >= 0 && p <= introToMs);
                        if (inAfter) {
                            state.skipMode = 'after'; state.pendingAfter = nextAc.from;
                            skipBtn.textContent = afterCredits.length > 1 ? `After credits ▶ (${afterCredits.indexOf(nextAc) + 1}/${afterCredits.length})` : 'After credits ▶';
                            skipRow.classList.remove('hidden');
                        } else if (state.skipMode === 'after') { skipRow.classList.add('hidden'); state.skipMode = 'intro'; }
                    }
                }
                paintCue();
            }, 1000);

            v.addEventListener('loadedmetadata', () => {
                if (state && localFile && v.duration > 0 && isFinite(v.duration)) { state.dur = v.duration; paint(); }
            });
            v.addEventListener('timeupdate', () => {
                if (state && !state.started && v.currentTime > 0.3) { state.started = true; clearTimeout(state.fbTimer); }
                if (state && v.currentTime > 10) { state.endedRetries = 0; state.errRetries = 0; }
                paint(); paintCue(); posCb && posCb({ pos: cur(), dur: state?.dur || 0, notice: !!state?.notice });
            });
            v.addEventListener('ended', () => {
                // NOTICE / waiting clip (Oct 22, + the original Oct 16 ~30s/~300s "getting
                // ready" signature): LOOP forever, live-style — a server message clip ending
                // must never mark watched, advance, or close the player. The 20s URL probe
                // (armNoticeProbe) is what eventually swaps the real stream in.
                if (!localFile && state && (state.notice
                        || (state.dur >= 295 && state.dur <= 305) || (state.dur >= 29 && state.dur <= 31))) {
                    if (state.offset > 0) seekTo(0);             // opened mid-clip — restart it clean
                    else { v.currentTime = 0; v.play().catch(() => {}); }
                    return;
                }
                // the remux stream has no known duration, so ANY server-side close reads as
                // 'ended' — a killed/crashed transcode mid-episode auto-advanced and even
                // chain-skipped episodes (AJ Oct 4 "skips 2 episodes"). Advance ONLY on a
                // POSITIVE tail reading: duration known AND position at it. Unknown duration
                // (probe still in flight while someone seek-spams right after open) must
                // reopen too, else early skips still episode-hopped. Bounded so a truly
                // finished stream with no duration can't reopen-loop forever.
                if (!localFile && state && !(state.dur > 0 && cur() >= state.dur - 45)) {
                    state.endedRetries = (state.endedRetries || 0) + 1;
                    if (state.endedRetries <= 4) { seekTo(cur()); return; }
                }
                // finished for real: autoplay-next rides the exit (app decides via watched
                // rules); flag it so a finished episode advances even at odd durations
                // autoplay OFF: surface the card on the end frame (TV-player parity — closing
                // straight out meant a natural end NEVER showed Play Now, AJ Oct 3)
                if (hasNext && autonext) fireNext();
                else if (hasNext && state && !state.nextShown) { state.nextShown = true; nextCard.classList.remove('hidden'); }
                else closePlayer(true);
            });
            v.addEventListener('error', () => {
                // desktop: never show the viewer an error for a format problem — mpv takes
                // over silently with the exact same stream + resume point
                if (hooks?.fallback && state && !state.started) { closePlayer(false); hooks.fallback(); return; }
                // transient open failure (TorBox 429 window, transcode hiccup): quietly
                // reopen where we were — the held frame + spinner stay up; the trouble
                // hint only earns its spot after three strikes (AJ Oct 4 "i dont wanna
                // see that")
                if (!localFile && state && (state.errRetries = (state.errRetries || 0) + 1) <= 3) {
                    setTimeout(() => { if (state) seekTo(cur()); }, 2500 * state.errRetries);
                    return;
                }
                player?.querySelector('.wp-hint')?.classList.remove('hidden');
            });
            v.addEventListener('play', () => { player.querySelector('.wp-pp').innerHTML = ckIc('pause'); });
            v.addEventListener('pause', () => { player.querySelector('.wp-pp').innerHTML = ckIc('play'); });

            player.querySelector('.wp-back').onclick = () => closePlayer(true);
            // ---- Netflix-style stepped FF/RW shuttle (AJ Oct 11) ----
            // Each press steps the scan one level (▶ ▶▶ ▶▶▶); the opposite direction steps back
            // down; play resumes right where the scan sits. The scan only moves the TIMELINE
            // PREVIEW — a single seek fires when you resume, because every seek reopens the
            // transcode (same reason the drag-scrubber seeks on release only).
            const shuttle = { level: 0, pos: 0, timer: null, rates: [10, 40, 120] };
            const shuttleBadge = player.querySelector('.wp-shuttle');
            const shuttlePreview = () => {
                if (!state?.dur) return;
                const f = Math.max(0, Math.min(1, shuttle.pos / state.dur));
                player.querySelector('.wp-fill').style.width = (f * 100) + '%';
                player.querySelector('.wp-dot').style.left = (f * 100) + '%';
                player.querySelector('.wp-cur').textContent = fmt(shuttle.pos);
            };
            const shuttleStop = (resume) => {
                if (!shuttle.level) return;
                clearInterval(shuttle.timer); shuttle.timer = null; shuttle.level = 0;
                shuttleBadge.classList.add('hidden');
                if (resume) { seekTo(shuttle.pos); v.play().catch(() => {}); }
            };
            const shuttleStep = (dir) => {
                if (!state?.dur) { seekTo(cur() + dir * state.step); return; }   // live/unknown-length: plain step
                const lvl = Math.max(-3, Math.min(3, shuttle.level + dir));
                if (lvl === 0) { shuttleStop(true); return; }
                if (!shuttle.level) { shuttle.pos = cur(); v.pause(); }
                shuttle.level = lvl;
                const n = Math.abs(lvl);
                shuttleBadge.textContent = `${(lvl > 0 ? '▶' : '◀').repeat(n)}  ${shuttle.rates[n - 1]}x`;
                shuttleBadge.classList.remove('hidden');
                wake();
                clearInterval(shuttle.timer);
                shuttle.timer = setInterval(() => {
                    if (!state) { clearInterval(shuttle.timer); shuttle.level = 0; return; }   // player closed mid-scan
                    shuttle.pos += shuttle.rates[Math.abs(shuttle.level) - 1] / 4 * Math.sign(shuttle.level);
                    if (shuttle.pos <= 0) { shuttle.pos = 0; shuttlePreview(); shuttleStop(true); return; }
                    if (shuttle.pos >= state.dur - 4) { shuttle.pos = state.dur - 4; shuttlePreview(); shuttleStop(true); return; }
                    shuttlePreview(); wake();
                }, 250);
            };
            player.querySelector('.wp-pp').onclick = () => {
                if (shuttle.level) { shuttleStop(true); return; }
                v.paused ? v.play() : v.pause();
            };
            // TAP = ±step every time; HOLD (500ms) = Netflix scan; taps then change speed
            const armSeekBtn = (sel, dir) => {
                const b = player.querySelector(sel);
                let t = null, held = false;
                b.onclick = null;
                b.onpointerdown = (e) => { held = false; e.preventDefault();
                    t = setTimeout(() => { held = true; shuttleStep(dir); }, 500); };
                b.onpointerup = () => { clearTimeout(t);
                    if (held) return;
                    if (shuttle.level) shuttleStep(dir);
                    else seekTo(cur() + dir * state.step); };
                b.onpointerleave = () => clearTimeout(t);
            };
            armSeekBtn('.wp-rew', -1);
            armSeekBtn('.wp-fwd', +1);
            // Restart = play from the very beginning (AJ Oct 11), beside Info
            player.querySelector('.wp-restart').onclick = () => { shuttleStop(false); seekTo(0); v.play().catch(() => {}); };
            player.querySelector('.wp-vol').oninput = (e) => { v.volume = +e.target.value; };
            // Fullscreen: use real element-fullscreen on desktop/Android/iPad. On iPHONE there is
            // no element fullscreen — the player is ALREADY full-viewport (position:fixed inset:0),
            // and iOS's native video fullscreen just slaps a source-URL banner on top (AJ Sep 26
            // "get rid of the website at the top"). So on iPhone we drop the redundant button.
            player.querySelector('.wp-fs').onclick = () => { try {
                if (document.fullscreenElement || document.webkitFullscreenElement)
                    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
                else if (player.requestFullscreen || player.webkitRequestFullscreen)
                    (player.requestFullscreen || player.webkitRequestFullscreen).call(player);
                else if (v.webkitEnterFullscreen) v.webkitEnterFullscreen();   // iPhone: native video FS
            } catch (e) {} };
            // DRAGGABLE scrubber (AJ Sep 26 "want to be able to drag the seekbar"): grab & drag the
            // bar/dot, the fill + time follow your finger, and it only seeks on RELEASE (one seek,
            // not one per pixel — important since each seek reopens the transcode). A plain tap
            // still seeks to that spot (pointerdown+up at one point).
            {
                const bar = player.querySelector('.wp-bar');
                const frac = (clientX) => {
                    const r = bar.getBoundingClientRect();
                    return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
                };
                const preview = (f) => {
                    player.querySelector('.wp-fill').style.width = (f * 100) + '%';
                    player.querySelector('.wp-dot').style.left = (f * 100) + '%';
                    if (state?.dur) player.querySelector('.wp-cur').textContent = fmt(state.dur * f);
                };
                const onMove = (e) => { if (dragging) { preview(frac(e.clientX)); wake(); } };
                const onUp = (e) => {
                    if (!dragging) return;
                    dragging = false; bar.classList.remove('drag');
                    document.removeEventListener('pointermove', onMove);
                    document.removeEventListener('pointerup', onUp);
                    if (state?.dur) seekTo(state.dur * frac(e.clientX));
                };
                bar.addEventListener('pointerdown', (e) => {
                    if (!state?.dur) return;
                    e.preventDefault();
                    dragging = true; bar.classList.add('drag'); wake();
                    preview(frac(e.clientX));
                    document.addEventListener('pointermove', onMove);
                    document.addEventListener('pointerup', onUp);
                });
            }
            // controls fade like the TV player: show on mouse move, hide after 3s idle
            let hideT = null;
            const wake = () => {
                ui.classList.remove('idle');
                clearTimeout(hideT);
                hideT = setTimeout(() => !v.paused && ui.classList.add('idle'), 3000);
            };
            // TAP anywhere — video OR the black letterbox — toggles the controls, NEVER pauses.
            // Capture idle state on pointerDOWN: a tap fires a synthetic mousemove first, which
            // runs wake() and clears 'idle' before the click — so checking idle in the click read
            // stale state and it could only ever HIDE, never show (AJ Sep 26). wasIdle fixes that.
            let wasIdle = false;
            player.addEventListener('pointerdown', () => { wasIdle = ui.classList.contains('idle'); });
            player.onclick = (e) => {
                if (e.target.closest('button, input, .wp-controls, .wp-menu, .wp-subpanel, .wp-infobox, .wp-next, .wp-bar')) return;
                menu.classList.add('hidden'); subPanel.classList.add('hidden');
                if (wasIdle) wake();
                else { clearTimeout(hideT); ui.classList.add('idle'); }
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
            maybeNotice();   // desktop pre-probed (probeDur rode in) — catch a notice-length file NOW
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
                // url = the FINAL post-redirect URL (notice-clip probe reads it; desktop main.js matches)
                return { ok: r.ok, status: r.status, url: r.url || '', text: await r.text() };
            } catch (e) { return { ok: false, status: 0, url: '', text: String(e).slice(0, 200) }; }
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
    // LIVE TV (Sep 17): endless HLS channels play natively — Safari has HLS built in,
    // everywhere else hls.js attaches to the same <video>. No /webplay remux (that path is
    // for files), no seeking, auto-failover to the channel's backup urls on fatal error.
    async function livePlay({ url, title, backups = [], guide = [], onTune = null, logo = '', now = '',
                              chid = '', fav = false, onFav = null, isFav = null, tsUrl = '',
                              lastCh = '', lastName = '', lastLogo = '', onClose = null }) {
        closePlayer(false);
        engine = 'web';
        state = { offset: 0, dur: 0 };
        player = document.createElement('div');
        player.id = 'web-player';
        player.innerHTML = `
            <video autoplay playsinline></video>
            <div class="wp-ui">
              <div class="wp-top">
                <button class="wp-btn wp-back">‹ Back</button><span class="wp-title"></span>
                <span class="wp-right"><span class="wp-live">🔴 LIVE</span><span class="wp-clock"></span></span>
              </div>
              <div class="wp-bottom">
                <div class="wp-controls">
                  <div class="wp-cell"><span>Play / Pause</span><button class="wp-btn wp-pp">${ckIc('pause')}</button></div>
                  <div class="wp-cell"><span>Favorite</span><button class="wp-btn wp-fav">☆</button></div>
                  <div class="wp-cell"><span>Guide</span><button class="wp-btn wp-guide">${ckIc('guide')}</button></div>
                  <div class="wp-cell wp-lastcell" style="display:none"><span>Last channel</span><button class="wp-btn wp-last" title="Last channel">↩</button></div>
                  <div class="wp-cell"><span>Pop out</span><button class="wp-btn wp-pip">${ckIc('pip')}</button></div>
                  <div class="wp-cell"><span>Cast</span><button class="wp-btn wp-cast">${ckIc('cast')}</button></div>
                  <div class="wp-cell"><span>Volume</span><input class="wp-vol" type="range" min="0" max="1" step=".05" value="1"></div>
                  <div class="wp-cell"><span>Fullscreen</span><button class="wp-btn wp-fs">${ckIc('fs')}</button></div>
                </div>
              </div>
              <div class="lv-guidepanel hidden"></div>
            </div>`;
        player.querySelector('.wp-title').textContent = title || '';
        // POP-OUT (PiP) + CAST for Live TV (AJ Sep 26) — same Android/iOS paths as the VOD player.
        (() => {
            const lv = player.querySelector('video');
            const pip = player.querySelector('.wp-pip'), cast = player.querySelector('.wp-cast');
            lv.addEventListener('leavepictureinpicture', () => setTimeout(() => { if (lv.paused) lv.play().catch(() => {}); }, 120));
            lv.addEventListener('webkitpresentationmodechanged', () => { if (lv.webkitPresentationMode !== 'picture-in-picture' && lv.paused) lv.play().catch(() => {}); });
            const stdPiP = document.pictureInPictureEnabled && !lv.disablePictureInPicture;
            const wkPiP = typeof lv.webkitSupportsPresentationMode === 'function'
                          && lv.webkitSupportsPresentationMode('picture-in-picture');
            if (stdPiP) {
                pip.onclick = () => (document.pictureInPictureElement
                    ? document.exitPictureInPicture() : lv.requestPictureInPicture()).catch(() => {});
                document.addEventListener('visibilitychange', () => {
                    if (document.hidden && !lv.paused && !document.pictureInPictureElement)
                        lv.requestPictureInPicture().catch(() => {});
                });
            } else if (wkPiP) {
                pip.onclick = () => { try {
                    lv.webkitSetPresentationMode(lv.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
                } catch (e) {} };
            } else { pip.style.display = 'none'; }
            if (lv.remote && typeof lv.remote.prompt === 'function') {
                try { lv.remote.watchAvailability(() => {}).catch(() => {}); } catch (e) {}  // start cast-device discovery NOW so the button is ready fast (AJ Sep 26)
                    cast.onclick = () => lv.remote.prompt().catch(() => {});
            } else if (typeof lv.webkitShowPlaybackTargetPicker === 'function') {
                cast.onclick = () => { try { lv.webkitShowPlaybackTargetPicker(); } catch (e) {} };
            } else { cast.style.display = 'none'; }
        })();
        document.body.appendChild(player);
        document.body.style.overflow = 'hidden';
        const v = player.querySelector('video');
        // LIVE = NO captions, ever (TV 2.0.258 parity): broadcast feeds carry embedded
        // CEA-608/708 + WebVTT tracks that Safari's native HLS (and hls.js) can auto-show
        // from system caption prefs — force every text track off, including tracks added
        // later by engine swaps / channel hops. VOD subtitles are untouched (webPlay).
        const killCc = () => { try { for (const tt of v.textTracks) if (tt.mode !== 'disabled') tt.mode = 'disabled'; } catch {} };
        killCc();
        try { v.textTracks.addEventListener('addtrack', killCc); v.textTracks.addEventListener('change', killCc); } catch {}
        // TUNING SCREEN (AJ Sep 17 "2-3 seconds to load anything"): instant logo + channel
        // + what's on, up until real frames flow; a 12s watchdog walks the backup sources
        // so a dead first url self-heals instead of spinning forever.
        if (!document.getElementById('ck-spin-kf')) {
            const st = document.createElement('style'); st.id = 'ck-spin-kf';
            st.textContent = '@keyframes ckspin{to{transform:rotate(360deg)}}';
            document.head.appendChild(st);
        }
        const ov = document.createElement('div');
        ov.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;background:#0c0c10;z-index:6';
        const ovImg = document.createElement('img');
        // hide (never remove) on error — the element must survive for channel-hop logos
        ovImg.style.cssText = 'max-height:90px;max-width:220px'; ovImg.onerror = () => { ovImg.style.display = 'none'; };
        if (logo) ovImg.src = logo; else ovImg.style.display = 'none';
        const ovSpin = document.createElement('div');
        ovSpin.style.cssText = 'width:34px;height:34px;border:3px solid #333;border-top-color:#e64545;border-radius:50%;animation:ckspin 1s linear infinite';
        const ovName = document.createElement('div'); ovName.style.cssText = 'font-size:21px;color:#fff;font-weight:600';
        const ovNow = document.createElement('div'); ovNow.style.cssText = 'font-size:15px;color:#9a9aa4';
        ov.append(ovImg, ovSpin, ovName, ovNow);
        // the overlay used to cover the Back button = trapped watching "Tuning…" while
        // the watchdog walked dead sources (AJ Sep 17) — escape hatch ON the overlay
        const ovBack = document.createElement('button');
        ovBack.textContent = '‹ Back';
        ovBack.style.cssText = 'position:absolute;top:18px;left:18px;background:#1c1c22;border:1px solid #3a3a44;color:#fff;border-radius:10px;padding:8px 16px;font-size:15px;cursor:pointer';
        ovBack.onclick = () => bail();
        ov.appendChild(ovBack);
        player.appendChild(ov);
        let tuned = false, dogT = 0;
        const showOv = (nm, nw, lg) => { tuned = false; ovName.textContent = 'Tuning ' + (nm || 'channel') + '…';
            ovNow.textContent = nw ? 'Now: ' + nw : ''; ovSpin.style.display = ''; ov.style.display = 'flex';
            // channel hop: the overlay shows the NEW channel's logo, not the session's first
            // (AJ Sep 26 "doesn't change the logo channel to channel") — no logo = hide it
            if (lg !== undefined) { if (lg) { ovImg.src = lg; ovImg.style.display = ''; } else ovImg.style.display = 'none'; } };
        showOv(title, now);
        v.addEventListener('playing', () => { tuned = true; clearTimeout(dogT); clearTimeout(stallT); ov.style.display = 'none'; });
        // MID-PLAY stall heal (AJ Sep 17 Buffy "freezes after 7 seconds"): panel sessions
        // die under the player — stuck >12s → re-attach = fresh upstream session
        let stallT = 0;
        v.addEventListener('waiting', () => {
            if (!tuned || !state) return;
            clearTimeout(stallT);
            stallT = setTimeout(() => {
                if (!state) return;
                showOv(player.querySelector('.wp-title').textContent, '');
                // a stall = the HLS session is sick; a fresh session just dies again.
                // Straight to the server-side ffmpeg hub feed (continuous, restart-proof).
                if (tsCur) playTs(tsCur); else attach(sources[si] || sources[0]);
                armDog();
            }, 12000);
        });
        const sources = [url, ...backups];
        let si = 0;
        const attach = async (u) => {
            if (!u) return;
            try { state?.mp?.destroy(); } catch {} if (state) state.mp = null;
            try { state?.hls?.destroy(); } catch {}
            if (v.canPlayType('application/vnd.apple.mpegurl')) { v.src = u; return; }
            if (!window.Hls) await new Promise((res, rej) => {
                const sc = document.createElement('script');
                sc.src = 'hls.min.js';   // self-hosted (CDN/CSP can't break playback)
                sc.onload = res;
                sc.onerror = () => { const c = document.createElement('script');
                    c.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.20/dist/hls.min.js';
                    c.onload = res; c.onerror = rej; document.head.appendChild(c); };
                document.head.appendChild(sc);
            });
            // long back buffer = pause keeps your place for a few minutes of live TV.
            // subtitle/caption parsing OFF at the engine level — live is captionless (TV 2.0.258)
            const h = new window.Hls({ maxBufferLength: 30, backBufferLength: 300,
                subtitleDisplay: false, enableCEA708Captions: false, enableWebVTT: false, enableIMSC1: false });
            h.on(window.Hls.Events.ERROR, (_, d) => {
                if (d.fatal && state) {
                    if (++si < sources.length) attach(sources[si]);     // next backup
                    else { try { h.destroy(); } catch {} }
                }
            });
            h.loadSource(u); h.attachMedia(v);
            if (state) state.hls = h;
        };
        // STEADY-FEED engine (AJ Sep 17 "skipped forward then it froze"): panel HLS runs
        // on server-side sessions that reset mid-play; the continuous .ts via mpegts.js
        // has no sessions to break. HLS stays as the fallback chain.
        let tsCur = tsUrl;
        const stopMp = () => { try { state?.mp?.destroy(); } catch {} if (state) state.mp = null; };
        const playTs = async (tsu) => {
            if (!window.mpegts) await new Promise((res2) => {
                const sc = document.createElement('script'); sc.src = 'mpegts.min.js';
                sc.onload = res2; sc.onerror = res2; document.head.appendChild(sc);
            });
            if (!window.mpegts?.isSupported?.()) return false;
            stopMp(); try { state?.hls?.destroy(); } catch {}
            const mp = window.mpegts.createPlayer({ type: 'mpegts', isLive: true, url: tsu });
            mp.attachMediaElement(v); mp.load(); v.play().catch(() => {});
            mp.on(window.mpegts.Events.ERROR, () => {
                stopMp();
                if (sources.length && sources[si || 0]) { attach(sources[si] || sources[0]); armDog(); }
            });
            if (state) state.mp = mp;
            return true;
        };
        const armDog = () => { clearTimeout(dogT); dogT = setTimeout(() => {
            if (tuned || !state) return;
            if (++si < sources.length) { showOv(player.querySelector('.wp-title').textContent, ''); stopMp(); attach(sources[si]); armDog(); }
            else { ovSpin.style.display = 'none'; ovName.textContent = 'This channel is down right now'; ovNow.textContent = 'Try another one — this one gets benched so it stops showing up';
                   setTimeout(() => { if (!tuned) bail(); }, 3000); }
        }, 12000); };
        // HLS FIRST (Sep 17 rollback: preferring the panel's direct .ts froze EVERY
        // channel — their raw feed is the broken part). .ts hub = fallback only.
        if (sources[0]) await attach(sources[0]); else if (tsCur) await playTs(tsCur);
        armDog();
        const bail = () => { clearTimeout(dogT); clearTimeout(stallT); stopMp(); try { state?.hls?.destroy(); } catch {} engine = null; closePlayer(false);
            // the guide under the player froze at tune time — let the page re-align its
            // red now-line (AJ Sep 24: "doesn't update unless you update the page")
            try { onClose && onClose(); } catch {} };
        player.querySelector('.wp-back').onclick = bail;
        // FULL GUIDE + CORNER VIDEO (Nov 7, TV-app "mini guide" parity): the Guide button
        // (or Esc stepping out) opens a full-screen guide while the SAME <video> shrinks to
        // the top-right corner — playback never stops, no engine churn. Click the playing
        // channel (or the corner video) = back to fullscreen; click another channel = tune
        // with the guide still up. Replaces the old narrow side panel.
        const gp = player.querySelector('.lv-guidepanel');   // legacy panel (kept hidden; CSS reused)
        const gbtn = player.querySelector('.wp-guide');
        let fgEl = null;
        const hideFullGuide = () => { if (!fgEl) return; fgEl.remove(); fgEl = null; v.classList.remove('wp-corner'); };
        const showFullGuide = () => {
            if (fgEl || !guide.length || !onTune) return;
            v.classList.add('wp-corner');
            fgEl = document.createElement('div');
            fgEl.className = 'wp-fullguide';
            const head = document.createElement('div'); head.className = 'wpg-head';
            const body = document.createElement('div'); body.className = 'wpg-body';
            fgEl.append(head, body);
            const paintHead = () => {
                head.innerHTML = '';
                if (curLogo) { const im = document.createElement('img'); im.src = curLogo; im.onerror = () => im.remove(); head.appendChild(im); }
                const t = document.createElement('div');
                const b = document.createElement('b'); b.textContent = curName || '';
                const s = document.createElement('span'); s.textContent = 'Watching now — click a channel to switch · click the video for fullscreen · Esc closes';
                t.append(b, s); head.appendChild(t);
            };
            const rowEls = [];
            const paintRows = () => { rowEls.forEach(([el2, id2, nm2]) => {
                const on = id2 === curCh;
                el2.querySelector('.lvg-name').textContent = (on ? '▶ ' : '') + nm2;
                el2.querySelector('.lvg-name').style.color = on ? '#b9a6ff' : '';
            }); paintHead(); };
            for (const ch of guide) {
                if (ch.hdr) {   // section BAND: color-coded left bar + faint tint (🔴 red,
                    // ★ gold, ↻ teal, sections purple) — same language as the TV guide
                    const color = ch.hdr.startsWith('🔴') ? '#e64545'
                        : ch.hdr.startsWith('★') ? '#f5c542'
                        : ch.hdr.startsWith('↻') ? '#4ec9b0' : '#b9a6ff';
                    const h = document.createElement('div');
                    h.textContent = ch.hdr;
                    h.style.cssText = `color:${color};background:${color}26;border-left:4px solid ${color};` +
                        'font-weight:700;font-size:12px;padding:7px 8px;margin:12px 0 4px;border-radius:8px;' +
                        'pointer-events:none;text-transform:uppercase;letter-spacing:.5px';
                    body.appendChild(h); continue;
                }
                const r = document.createElement('div'); r.className = 'lvg-row';
                r.innerHTML = `<span class="lvg-name"></span><span class="lvg-now"></span>`;
                r.querySelector('.lvg-name').textContent = ch.name;
                r.querySelector('.lvg-now').textContent = ch.now || '';
                if (ch.live) r.querySelector('.lvg-now').style.color = '#e64545';   // 🔴 game rows
                rowEls.push([r, ch.id, ch.name]);
                r.onclick = async () => {
                    if (ch.id === curCh) { hideFullGuide(); return; }   // what's playing = fullscreen
                    r.classList.add('busy');
                    try { await hopTo(ch.id, ch.name, ch.logo || '', ch.now, paintRows); }
                    finally { r.classList.remove('busy'); }
                };
                body.appendChild(r);
            }
            player.appendChild(fgEl);
            paintRows();
        };
        if (guide.length && onTune) {
            gbtn.onclick = () => (fgEl ? hideFullGuide() : showFullGuide());
            v.addEventListener('click', () => { if (fgEl) hideFullGuide(); });
        } else gbtn.parentElement.style.display = 'none';
        // ★ the channel you're WATCHING (AJ Sep 17) — state follows in-player channel hops
        const favB = player.querySelector('.wp-fav');
        let curCh = chid, curFav = !!fav, curName = title, curLogo = logo;
        const paintFav = () => { favB.textContent = curFav ? '★' : '☆'; favB.style.color = curFav ? '#f5c542' : ''; };
        // ↩ LAST CHANNEL (AJ Oct 27 "the last button like last channel they were on even when
        // they click out"): classic cable-box recall — one tap bounces to the previously-tuned
        // channel. Seeded from the key's last tune (lastCh, server-synced across web/iOS/TV via
        // lvrec), so it works the instant you open — even before hopping — then tracks every hop.
        let prevCh = (lastCh && lastCh !== chid) ? lastCh : '', prevName = lastName || '', prevLogo = lastLogo || '';
        const lastCell = player.querySelector('.wp-lastcell'), lastBtn = player.querySelector('.wp-last');
        const paintLast = () => { if (lastCell) lastCell.style.display = prevCh ? '' : 'none'; if (lastBtn && prevName) lastBtn.title = 'Last: ' + prevName; };
        // shared tune-over used by BOTH the guide rows and the ↩ Last button (was inline in the
        // guide row — extracted so recall reuses the exact same engine swap + overlay + watchdog)
        const hopTo = async (id, nm, lg, nwTxt, after) => {
            const r2 = await onTune(id);
            const hls = r2?.hls || (typeof r2 === 'string' && r2 ? [r2] : []);
            const ts2 = r2?.ts || '';
            if (!hls.length && !ts2) return false;
            if (curCh && curCh !== id) { prevCh = curCh; prevName = curName; prevLogo = curLogo; }  // remember where we left
            si = 0; sources.length = 0; hls.forEach(u2 => sources.push(u2));
            tsCur = ts2;
            player.querySelector('.wp-title').textContent = nm;
            curCh = id; curName = nm; curLogo = lg || ''; curFav = !!(isFav && isFav(id));
            paintFav(); paintLast(); if (after) after();
            showOv(nm, nwTxt, lg || ''); armDog();
            if (sources[0]) await attach(sources[0]); else if (ts2) await playTs(ts2);
            return true;
        };
        paintLast();
        if (lastBtn) lastBtn.onclick = async () => {
            if (!prevCh) return;
            lastBtn.classList.add('busy');
            try { await hopTo(prevCh, prevName, prevLogo, '', null); } finally { lastBtn.classList.remove('busy'); }
        };
        if (onFav && chid) {
            paintFav();
            favB.onclick = () => { curFav = !curFav; paintFav(); onFav(curCh, curFav); };
        } else favB.parentElement.style.display = 'none';
        const pp = player.querySelector('.wp-pp');
        pp.onclick = () => { if (v.paused) { v.play(); pp.innerHTML = ckIc('pause'); } else { v.pause(); pp.innerHTML = ckIc('play'); } };
        player.querySelector('.wp-vol').oninput = (e) => v.volume = +e.target.value;
        player.querySelector('.wp-fs').onclick = () => { try {
            if (document.fullscreenElement || document.webkitFullscreenElement)
                (document.exitFullscreen || document.webkitExitFullscreen).call(document);
            else if (player.requestFullscreen || player.webkitRequestFullscreen)
                (player.requestFullscreen || player.webkitRequestFullscreen).call(player);
            else if (v.webkitEnterFullscreen) v.webkitEnterFullscreen();   // iPhone: native video FS
        } catch (e) {} };
        const ckEl = player.querySelector('.wp-clock');
        ckEl.textContent = clock(new Date());
        state.tick = setInterval(() => { if (player) ckEl.textContent = clock(new Date()); }, 30000);
        // controls fade like the VOD player (AJ Sep 24 mobile: "you can't get rid of the
        // player UI"): 3s idle hides them, mouse move wakes them, tapping the video
        // toggles them. Stay up while paused or while the guide panel is open.
        const ui = player.querySelector('.wp-ui');
        let hideT = null;
        const wake = () => {
            ui.classList.remove('idle');
            clearTimeout(hideT);
            hideT = setTimeout(() => {
                if (!v.paused && gp.classList.contains('hidden')) ui.classList.add('idle');
            }, 3000);
        };
        player.addEventListener('mousemove', wake); wake();
        // a tap fires compat mousemove (= wake) BEFORE click, so snapshot the state at
        // pointerdown — else tap-to-show would instantly re-hide what it just showed
        let wasIdle = false;
        player.addEventListener('pointerdown', () => { wasIdle = ui.classList.contains('idle'); });
        // tap anywhere incl. the black letterbox toggles the UI; real controls handle their own taps
        player.onclick = (e) => {
            if (e.target.closest('button, input, .wp-controls, .lv-guidepanel, .wp-fullguide')) return;
            if (wasIdle) wake(); else { clearTimeout(hideT); ui.classList.add('idle'); }
        };
        document.addEventListener('keydown', function esc(e) {
            if (!player) { document.removeEventListener('keydown', esc); return; }
            // step-out ladder (TV parity): Esc with the full guide up = back to fullscreen;
            // Esc from fullscreen = leave the player.
            if (e.key === 'Escape') {
                if (fgEl) { hideFullGuide(); return; }
                bail(); document.removeEventListener('keydown', esc);
            }
        });
    }

    window.ckPlay = async (opts) => {
        if (opts?.live) return livePlay(opts);
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
