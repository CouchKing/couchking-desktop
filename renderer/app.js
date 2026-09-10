// CouchKing Desktop renderer — v0.1
// Same account/endpoints as the TV app; playback hands off to mpv (main process).
const TMDB = 'b05e998c589bf1393c1059bd1d4c5895';
const CINE = 'https://v3-cinemeta.strem.io';
let SERVICE = 'https://couchking.app';
let S = { email: '', token: '', user: '', subKey: '', addons: [], state: {} };

const $ = (id) => document.getElementById(id);
const j = async (url, opts = {}) => {
    const r = await ck.http({ url, ...opts });
    try { return JSON.parse(r.text); } catch { return null; }
};

// ---------- auth ----------
async function auth(mode) {
    $('auth-error').textContent = '';
    const email = $('auth-email').value.trim(), password = $('auth-pass').value;
    const r = await j(`${SERVICE}/tvapp/auth`, { method: 'POST', body: { email, password, mode, appVer: 'desktop-0.1' } });
    if (!r?.ok) { $('auth-error').textContent = r?.error || 'Couldn’t sign in'; return; }
    S.email = email.toLowerCase(); S.token = r.token;
    localStorage.setItem('ck', JSON.stringify({ email: S.email, token: S.token }));
    await bootstrap();
}

async function bootstrap() {
    // assigned addon auto-install (same as the store app) + full account state
    const acc = await j(`${SERVICE}/tvapp/access?e=${encodeURIComponent(S.email)}&t=${encodeURIComponent(S.token)}`);
    S.state = await j(`${SERVICE}/tvapp/state?e=${encodeURIComponent(S.email)}&t=${encodeURIComponent(S.token)}`) || {};
    S.addons = S.state.addons || [];
    if (!S.addons.length && acc?.allowed && acc.addon) S.addons = [{ url: acc.addon, name: 'CouchKing' }];
    // subKey rides inside the addon url ({"subKey":"CKG-…"} url-encoded)
    try {
        const seg = decodeURIComponent(new URL(S.addons[0].url).pathname.split('/')[1]);
        S.subKey = JSON.parse(seg).subKey || '';
    } catch {}
    const savedPid = localStorage.getItem('ck-pid');
    const profs = S.state.profiles || [];
    S.pid = profs.find(p => p.id === savedPid)?.id || profs[0]?.id || '';
    const prof = profs.find(p => p.id === S.pid);
    S.user = prof?.name || S.email.split('@')[0];
    $('prof-name').textContent = S.user;
    $('prof-avatar').textContent = (S.state.profiles || []).find(p => p.id === S.pid)?.avatar || '👤';
    $('set-email').textContent = S.email;
    $('set-service').textContent = S.subKey ? 'Connected (' + S.subKey.slice(0, 8) + '…)' : 'None on this account';
    show('main'); home();
}

// rail navigation: pages live side by side, rail icon marks the active one
let page = 'home';
function nav(which) {
    page = which;
    document.querySelectorAll('.rail-item.nav').forEach(n => n.classList.toggle('on', n.dataset.nav === which));
    for (const v of ['home', 'search', 'discover', 'library', 'settings', 'detail'])
        $('view-' + v)?.classList.toggle('hidden', v !== which);
    if (which === 'search') setTimeout(() => $('search').focus(), 50);
    if (which === 'discover' && !$('discover-rows').childElementCount) discover();
    if (which === 'library') library();
    if (which === 'settings') renderSettings();
}
function show(which) {
    $('view-auth').classList.toggle('hidden', which !== 'auth');
    $('shell').classList.toggle('hidden', which === 'auth');
    if (which !== 'auth') nav('home');
}

// ---------- home ----------
const IMG = (p, w = 342) => p ? (p.startsWith('http') ? p : `https://image.tmdb.org/t/p/w${w}${p}`) : '';
function posterEl(t, pct) {
    const d = document.createElement('div'); d.className = 'poster';
    d.innerHTML = `<img loading="lazy" src="${t.poster || ''}"><div class="pt">${t.name || ''}</div>` +
        (pct > 0 ? `<div class="bar"><div style="width:${pct}%"></div></div>` : '');
    d.onclick = () => detail(t);
    return d;
}
function addRow(label, items, progressOf, holder) {
    if (!items?.length) return;
    const rows = holder || document.querySelector('#view-home .rows');
    const l = document.createElement('div'); l.className = 'row-label'; l.textContent = label; rows.appendChild(l);
    const s = document.createElement('div'); s.className = 'strip';
    for (const t of items) s.appendChild(posterEl(t, progressOf ? progressOf(t) : 0));
    rows.appendChild(s);
}
async function tmdbRow(kind, path) {
    const d = await j(`https://api.themoviedb.org/3/${path}${path.includes('?') ? '&' : '?'}api_key=${TMDB}`);
    const out = [];
    for (const r of (d?.results || []).slice(0, 30)) {
        out.push({ tmdb: r.id, type: kind === 'tv' ? 'series' : 'movie', name: r.title || r.name, poster: IMG(r.poster_path) });
    }
    return out;
}
async function home() {
    document.querySelector('#view-home .rows').innerHTML = '';
    const st = pstate();
    const pos = st.positions || {};
    const pctOf = (t) => {
        let best = 0;
        for (const [k, v] of Object.entries(pos)) {
            if (k === t.id || k.startsWith(t.id + ':')) {
                const [p, d] = String(v).split('|').map(Number);
                if (d > 0) best = Math.max(best, Math.round(100 * p / d));
            }
        }
        return best;
    };
    addRow('Continue Watching', (st.continue || []).map(t => ({ ...t })), pctOf);
    addRow('Trending Movies', await tmdbRow('movie', 'trending/movie/week'));
    addRow('Trending Series', await tmdbRow('tv', 'trending/tv/week'));
    addRow('Top Rated Movies', await tmdbRow('movie', 'movie/top_rated'));
    addRow('Top Rated Series', await tmdbRow('tv', 'tv/top_rated'));
}

// ---------- search ----------
let searchT = null;
$('search').addEventListener('input', () => {
    clearTimeout(searchT);
    searchT = setTimeout(async () => {
        const q = $('search').value.trim();
        const holder = $('search-rows');
        holder.innerHTML = '';
        if (!q) return;
        const [m, s] = await Promise.all([
            j(`${CINE}/catalog/movie/top/search=${encodeURIComponent(q)}.json`),
            j(`${CINE}/catalog/series/top/search=${encodeURIComponent(q)}.json`)
        ]);
        const map = (d, ty) => (d?.metas || []).slice(0, 25).map(x => ({ id: x.id, type: ty, name: x.name, poster: x.poster }));
        addRow('Movies', map(m, 'movie'), null, holder);
        addRow('Series', map(s, 'series'), null, holder);
    }, 400);
});

// ---------- detail ----------
async function resolveImdb(t) {
    if (t.id?.startsWith('tt')) return t.id;
    const d = await j(`https://api.themoviedb.org/3/${t.type === 'series' ? 'tv' : 'movie'}/${t.tmdb}/external_ids?api_key=${TMDB}`);
    return d?.imdb_id || null;
}
let cur = null;
async function detail(t) {
    const imdb = await resolveImdb(t);
    if (!imdb) return;
    const meta = (await j(`${CINE}/meta/${t.type}/${imdb}.json`))?.meta;
    if (!meta) return;
    cur = { imdb, type: t.type, meta };
    nav('detail');
    const b = $('detail-body');
    b.innerHTML = `<div class="d-head"><img src="${meta.poster || t.poster || ''}">
        <div><h2>${meta.name}</h2>
        <div class="d-meta">${meta.year || ''} · ${meta.runtime || ''} · ⭐ ${meta.imdbRating || '—'}</div>
        <div class="d-desc">${meta.description || ''}</div>
        <div style="display:flex;gap:.6rem;margin-top:.9rem">
          ${t.type === 'movie' ? '<button class="primary" id="d-play">▶ Play</button>' : ''}
          <button class="ghost" id="d-list"></button>
          <button class="ghost" id="d-watched"></button>
        </div>
        </div></div>
        <div id="d-eps"></div><div id="d-streams" class="streams"></div>`;
    const tt = { id: imdb, type: t.type, name: meta.name, poster: meta.poster || t.poster || '' };
    const paintBtns = () => {
        const st = pstate();
        $('d-list').textContent = (st.watchlist || []).some(x => x.id === imdb) ? '✓ In My List' : '+ My List';
        $('d-watched').textContent = (st.watchedIds || []).includes(imdb) ? '✓ Watched' : 'Mark watched';
    };
    $('d-list').onclick = () => { toggleList(tt); paintBtns(); };
    $('d-watched').onclick = () => { toggleWatchedTitle(tt); paintBtns(); };
    paintBtns();
    if (t.type === 'movie') $('d-play').onclick = () => pickStream(imdb, meta.name);
    else seasons(meta);
}
function seasons(meta) {
    const eps = (meta.videos || []).filter(v => v.season > 0);
    const ss = [...new Set(eps.map(e => e.season))].sort((a, b) => a - b);
    const holder = $('d-eps');
    const tabs = document.createElement('div'); tabs.className = 'season-tabs';
    const list = document.createElement('div');
    holder.replaceChildren(tabs, list);
    const st = pstate();
    const pos = st.positions || {};
    const paint = (sn) => {
        [...tabs.children].forEach(c => c.classList.toggle('on', +c.dataset.s === sn));
        list.innerHTML = '';
        for (const e of eps.filter(x => x.season === sn).sort((a, b) => a.episode - b.episode)) {
            const key = `${cur.imdb}:${e.season}:${e.episode}`;
            const [p, d] = String(pos[key] || '').split('|').map(Number);
            const pct = d > 0 ? Math.round(100 * p / d) : 0;
            const el = document.createElement('div'); el.className = 'ep';
            el.innerHTML = `<img loading="lazy" src="${e.thumbnail || ''}">
                <div class="et"><b>${e.episode}. ${e.name || ''}</b><span>${(e.released || '').slice(0, 10)}</span></div>` +
                (pct > 0 ? `<div class="ebar"><div style="width:${pct}%"></div></div>` : '');
            el.onclick = () => pickStream(key, `${meta.name} S${e.season}E${e.episode}`);
            list.appendChild(el);
        }
    };
    for (const sn of ss) {
        const btn = document.createElement('button'); btn.className = 'ghost small'; btn.dataset.s = sn;
        btn.textContent = 'Season ' + sn; btn.onclick = () => paint(sn);
        tabs.appendChild(btn);
    }
    paint(ss[0]);
}

// ---------- streams + play ----------
async function pickStream(sid, label, autoFirst = false) {
    const holder = $('d-streams');
    holder.innerHTML = '<div class="muted">Finding streams…</div>';
    if (!S.addons.length) { holder.innerHTML = '<div class="err">No service on this account.</div>'; return; }
    const base = S.addons[0].url.replace(/\/$/, '');
    const type = sid.includes(':') ? 'series' : 'movie';
    const d = await j(`${base}/stream/${type}/${encodeURIComponent(sid)}.json`, { timeoutMs: 30000 });
    const streams = d?.streams || [];
    if (!streams.length) { holder.innerHTML = '<div class="muted">Getting this ready — try again in a minute.</div>'; return; }
    if (autoFirst && streams[0]) { play(streams[0].url, label, sid); return; }
    holder.innerHTML = '<div class="row-label">Streams</div>';
    for (const st of streams) {
        const el = document.createElement('div'); el.className = 'stream';
        el.innerHTML = `<b>${(st.name || '').replace(/\n/g, ' ')}</b>${(st.description || st.title || '').split('\n')[0]}`;
        el.onclick = () => play(st.url, label, sid);
        holder.appendChild(el);
    }
    holder.scrollIntoView({ behavior: 'smooth' });
}

let playing = null;
async function play(url, label, sid) {
    const imdb = sid.split(':')[0];
    const [, s, e] = sid.split(':');
    // cross-device resume: whichever device is further in wins (same as the TV app)
    let startSec = 0;
    try {
        const r = await j(`${SERVICE}/player/resume?k=${S.subKey}&u=${encodeURIComponent(S.user)}&i=${imdb}&s=${s || ''}&e=${e || ''}`);
        if (r && String(r.s || '') === String(s || '') && String(r.e || '') === String(e || '') && r.pos > 60000 && r.pct < 92)
            startSec = Math.floor(r.pos / 1000);
    } catch {}
    playing = { sid, imdb, s, e, label, pos: 0, dur: 0 };
    $('playing-title').textContent = label;
    $('playing').classList.remove('hidden');
    await ck.play({ url, title: label, startSec, subScale: PREF('subscale', 1.0) });
}
ck.onMpvPos(({ pos, dur }) => {
    if (!playing) return;
    playing.pos = pos; playing.dur = dur;
    if (dur > 0) $('playing-pos').textContent = `${fmt(pos)} / ${fmt(dur)}`;
});
ck.onMpvExit(async ({ pos, dur }) => {
    $('playing').classList.add('hidden');
    const p = playing; playing = null;
    if (!p || !dur || pos < 5) return;
    // one beacon per sit-down — powers For You + cross-device resume (same as TV app)
    await j(`${SERVICE}/player/progress`, { method: 'POST', body: {
        k: S.subKey, u: S.user, i: p.imdb, s: p.s || '', e: p.e || '',
        pos: Math.floor(pos * 1000), dur: Math.floor(dur * 1000) } });
    S.state = await j(`${SERVICE}/tvapp/state?e=${encodeURIComponent(S.email)}&t=${encodeURIComponent(S.token)}`) || S.state;
    // AUTOPLAY NEXT: finished a series episode (>=92%) with the setting on → roll the next one
    if (PREF('autonext', true) && p.s && pos / dur >= 0.92 && cur?.meta?.videos) {
        const eps = cur.meta.videos.filter(v => v.season > 0).sort((a, b) => a.season - b.season || a.episode - b.episode);
        const i = eps.findIndex(x => x.season == p.s && x.episode == p.e);
        const nxt = eps[i + 1];
        if (nxt && (!nxt.released || new Date(nxt.released) <= new Date()))
            pickStream(`${p.imdb}:${nxt.season}:${nxt.episode}`, `${cur.meta.name} S${nxt.season}E${nxt.episode}`, true);
    }
});
const fmt = (s) => { s = Math.floor(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return (h ? h + ':' : '') + String(m).padStart(h ? 2 : 1, '0') + ':' + String(s % 60).padStart(2, '0'); };
$('playing-stop').onclick = () => ck.stopPlay();

// ---------- wiring ----------
$('auth-signin').onclick = () => auth('signin');
$('auth-signup').onclick = () => auth('signup');
$('back').onclick = () => { nav('home'); };
$('signout').onclick = () => { localStorage.removeItem('ck'); location.reload(); };

(async () => {
    SERVICE = await ck.service();
    const saved = JSON.parse(localStorage.getItem('ck') || 'null');
    if (saved?.token) { S.email = saved.email; S.token = saved.token; await bootstrap(); }
    else show('auth');
})();


// ---------- discover ----------
async function discover() {
    const h = $('discover-rows'); h.innerHTML = '';
    addRow('New in Theaters', await tmdbRow('movie', 'movie/now_playing'), null, h);
    addRow('Popular Movies', await tmdbRow('movie', 'movie/popular'), null, h);
    addRow('Popular Series', await tmdbRow('tv', 'tv/popular'), null, h);
    addRow('Certified Fresh', await tmdbRow('movie', 'discover/movie?vote_average.gte=7.4&vote_count.gte=300&sort_by=popularity.desc'), null, h);
    addRow('Anime', await tmdbRow('tv', 'discover/tv?with_genres=16&with_origin_country=JP&sort_by=popularity.desc'), null, h);
}

// ---------- library ----------
let libType = 'All', libSort = 'Recent';
function library() {
    const h = $('library-rows'); h.innerHTML = '';
    const st = pstate();
    // filter + sort bar (same options as the TV app's Library)
    const bar = document.createElement('div'); bar.className = 'season-tabs';
    for (const t of ['All', 'Movies', 'Shows']) {
        const b = document.createElement('button'); b.className = 'ghost small' + (libType === t ? ' on' : '');
        b.textContent = t; b.onclick = () => { libType = t; library(); };
        bar.appendChild(b);
    }
    const sp = document.createElement('span'); sp.style.width = '1rem'; bar.appendChild(sp);
    for (const t of ['Recent', 'A-Z']) {
        const b = document.createElement('button'); b.className = 'ghost small' + (libSort === t ? ' on' : '');
        b.textContent = t; b.onclick = () => { libSort = t; library(); };
        bar.appendChild(b);
    }
    h.appendChild(bar);
    const fil = (l) => (l || []).filter(x => libType === 'All' || (libType === 'Movies' ? x.type !== 'series' : x.type === 'series'));
    const srt = (l) => libSort === 'A-Z' ? [...l].sort((a, b) => (a.name || '').localeCompare(b.name || '')) : l;
    addRow('My List', srt(fil(st.watchlist)), null, h);
    addRow('Watched', srt(fil(st.watchedTitles)), null, h);
    if (h.childElementCount <= 1) h.insertAdjacentHTML('beforeend', '<p class="muted" style="padding-top:1rem">Nothing in your library yet — add shows and movies from their pages.</p>');
}

// ---------- rail ----------
document.querySelectorAll('.rail-item.nav').forEach(n => n.onclick = () => nav(n.dataset.nav));


// ---------- active profile ----------
function pstate() { return S.state.states?.[S.pid] || S.state; }
$('rail-profile').onclick = () => {
    const profs = S.state.profiles || [];
    if (profs.length < 2) return;
    // simple picker: cycle is annoying — show a chooser overlay
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:#000A;display:flex;align-items:center;justify-content:center;z-index:50';
    const card = document.createElement('div');
    card.style.cssText = 'background:var(--card);border-radius:16px;padding:1.4rem;display:flex;gap:1rem';
    for (const p of profs) {
        const b = document.createElement('button'); b.className = p.id === S.pid ? 'primary' : 'ghost';
        b.textContent = (p.avatar || '👤') + '  ' + p.name;
        b.onclick = () => {
            S.pid = p.id; S.user = p.name; localStorage.setItem('ck-pid', p.id);
            $('prof-name').textContent = p.name; $('prof-avatar').textContent = p.avatar || '👤';
            ov.remove(); home(); if (page === 'library') library();
        };
        card.appendChild(b);
    }
    ov.appendChild(card); ov.onclick = (e) => { if (e.target === ov) ov.remove(); };
    document.body.appendChild(ov);
};

// ---------- account write-back (server MERGES, so partial pushes are safe) ----------
async function pushAccount() {
    await j(`${SERVICE}/tvapp/state`, { method: 'POST', body: { email: S.email, token: S.token, appVer: 'desktop-0.3', state: S.state } });
}
function stamp(map, id) { const m = map || {}; m[id] = Date.now(); return m; }
function toggleList(t) {
    const st = pstate(); st.watchlist = st.watchlist || [];
    const has = st.watchlist.some(x => x.id === t.id);
    if (has) { st.watchlist = st.watchlist.filter(x => x.id !== t.id); st.removedTs = stamp(st.removedTs, t.id); }
    else { st.watchlist.unshift({ id: t.id, type: t.type, name: t.name, poster: t.poster || '' }); st.addedTs = stamp(st.addedTs, t.id); }
    pushAccount(); return !has;
}
function toggleWatchedTitle(t) {
    const st = pstate(); st.watchedIds = st.watchedIds || []; st.watchedTitles = st.watchedTitles || [];
    const has = st.watchedIds.includes(t.id);
    if (has) { st.watchedIds = st.watchedIds.filter(x => x !== t.id); st.watchedTitles = st.watchedTitles.filter(x => x.id !== t.id); st.removedTs = stamp(st.removedTs, t.id); }
    else { st.watchedIds.push(t.id); st.watchedTitles.unshift({ id: t.id, type: t.type, name: t.name, poster: t.poster || '' }); st.addedTs = stamp(st.addedTs, t.id); }
    pushAccount(); return !has;
}

// ---------- settings that DO something ----------
const PREF = (k, d) => JSON.parse(localStorage.getItem('ckp-' + k) ?? JSON.stringify(d));
const SETPREF = (k, v) => localStorage.setItem('ckp-' + k, JSON.stringify(v));
function renderSettings() {
    const holder = $('settings-extra'); if (!holder) return;
    holder.innerHTML = '';
    const rows = [
        ['Autoplay next episode', 'autonext', true],
        ['Subtitle size', 'subscale', 1.0, [['Small', .8], ['Normal', 1.0], ['Large', 1.3], ['Giant', 1.7]]],
    ];
    for (const [label, key, dflt, opts] of rows) {
        const card = document.createElement('div'); card.className = 'set-card';
        const cur = PREF(key, dflt);
        if (!opts) {
            card.innerHTML = `<b>${label}</b>`;
            const b = document.createElement('button'); b.className = cur ? 'primary small' : 'ghost small';
            b.textContent = cur ? 'On' : 'Off';
            b.onclick = () => { SETPREF(key, !PREF(key, dflt)); renderSettings(); };
            card.appendChild(b);
        } else {
            card.innerHTML = `<b>${label}</b>`;
            const wrap = document.createElement('div');
            for (const [name, val] of opts) {
                const b = document.createElement('button'); b.className = (cur === val ? 'primary' : 'ghost') + ' small';
                b.style.marginLeft = '.4rem'; b.textContent = name;
                b.onclick = () => { SETPREF(key, val); renderSettings(); };
                wrap.appendChild(b);
            }
            card.appendChild(wrap);
        }
        holder.appendChild(card);
    }
}
