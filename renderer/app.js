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
    const prof = (S.state.profiles || [])[0];
    S.user = prof?.name || S.email.split('@')[0];
    $('who').textContent = S.user + (S.subKey ? '' : '  (no service on this account)');
    show('main'); home();
}

function show(which) {
    for (const v of ['auth', 'main', 'detail']) $('view-' + v).classList.toggle('hidden', v !== which);
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
function addRow(label, items, progressOf) {
    if (!items?.length) return;
    const rows = $('rows');
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
    $('rows').innerHTML = '';
    const st = S.state.states?.[S.state.profiles?.[0]?.id] || S.state;
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
        if (!q) return home();
        $('rows').innerHTML = '';
        const [m, s] = await Promise.all([
            j(`${CINE}/catalog/movie/top/search=${encodeURIComponent(q)}.json`),
            j(`${CINE}/catalog/series/top/search=${encodeURIComponent(q)}.json`)
        ]);
        const map = (d, ty) => (d?.metas || []).slice(0, 25).map(x => ({ id: x.id, type: ty, name: x.name, poster: x.poster }));
        addRow('Movies', map(m, 'movie'));
        addRow('Series', map(s, 'series'));
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
    show('detail');
    const b = $('detail-body');
    b.innerHTML = `<div class="d-head"><img src="${meta.poster || t.poster || ''}">
        <div><h2>${meta.name}</h2>
        <div class="d-meta">${meta.year || ''} · ${meta.runtime || ''} · ⭐ ${meta.imdbRating || '—'}</div>
        <div class="d-desc">${meta.description || ''}</div>
        ${t.type === 'movie' ? '<br><button class="primary" id="d-play">▶ Play</button>' : ''}
        </div></div>
        <div id="d-eps"></div><div id="d-streams" class="streams"></div>`;
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
    const st = S.state.states?.[S.state.profiles?.[0]?.id] || S.state;
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
async function pickStream(sid, label) {
    const holder = $('d-streams');
    holder.innerHTML = '<div class="muted">Finding streams…</div>';
    if (!S.addons.length) { holder.innerHTML = '<div class="err">No service on this account.</div>'; return; }
    const base = S.addons[0].url.replace(/\/$/, '');
    const type = sid.includes(':') ? 'series' : 'movie';
    const d = await j(`${base}/stream/${type}/${encodeURIComponent(sid)}.json`, { timeoutMs: 30000 });
    const streams = d?.streams || [];
    if (!streams.length) { holder.innerHTML = '<div class="muted">Getting this ready — try again in a minute.</div>'; return; }
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
    await ck.play({ url, title: label, startSec });
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
});
const fmt = (s) => { s = Math.floor(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return (h ? h + ':' : '') + String(m).padStart(h ? 2 : 1, '0') + ':' + String(s % 60).padStart(2, '0'); };
$('playing-stop').onclick = () => ck.stopPlay();

// ---------- wiring ----------
$('auth-signin').onclick = () => auth('signin');
$('auth-signup').onclick = () => auth('signup');
$('back').onclick = () => { show('main'); };
$('signout').onclick = () => { localStorage.removeItem('ck'); location.reload(); };

(async () => {
    SERVICE = await ck.service();
    const saved = JSON.parse(localStorage.getItem('ck') || 'null');
    if (saved?.token) { S.email = saved.email; S.token = saved.token; await bootstrap(); }
    else show('auth');
})();
