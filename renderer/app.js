// CouchKing renderer — one codebase for the desktop app (Electron + mpv) AND the
// web version at couchking.app/app (ck-web.js shim + HTML5 player). Same account
// endpoints as the TV app; everything syncs through /tvapp/state + /player/progress.
const TMDB = 'b05e998c589bf1393c1059bd1d4c5895';
const CINE = 'https://v3-cinemeta.strem.io';
let SERVICE = 'https://couchking.app';
let S = { email: '', token: '', user: '', useg: '', subKey: '', addons: [], state: {}, guest: false, access: null };
const APPVER = () => (ck.platform === 'web' ? 'web' : 'desktop') + '-0.9';
// the app is a NEUTRAL TRACKER SHELL until an account with an assigned service signs in
// (guests and key-less accounts browse + track + see where-to-watch; no stream buttons)
const hasService = () => !S.guest && S.addons.length > 0;

const $ = (id) => document.getElementById(id);
const j = async (url, opts = {}) => {
    const r = await ck.http({ url, ...opts });
    try { return JSON.parse(r.text); } catch { return null; }
};

// external links (terms/privacy/downloads) — browser opens a tab, desktop the system browser
document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-ext]');
    if (a) { e.preventDefault(); ck.openExternal(a.dataset.ext); }
});

function toast(msg) {
    document.getElementById('toast')?.remove();
    const t = document.createElement('div'); t.id = 'toast'; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2200);
}

// ---------- auth ----------
async function auth(mode) {
    $('auth-error').textContent = '';
    const email = $('auth-email').value.trim(), password = $('auth-pass').value;
    const r = await j(`${SERVICE}/tvapp/auth`, { method: 'POST', body: { email, password, mode, appVer: APPVER() } });
    if (!r?.ok) { $('auth-error').textContent = r?.error || 'Couldn’t sign in'; return; }
    S.email = email.toLowerCase(); S.token = r.token; S.guest = false;
    localStorage.setItem('ck', JSON.stringify({ email: S.email, token: S.token }));
    await bootstrap();
}
function guest() {
    S.guest = true; S.email = ''; S.token = ''; S.state = {}; S.addons = []; S.user = 'Guest'; S.useg = '';
    $('prof-name').textContent = 'Guest'; $('prof-avatar').textContent = '👤';
    show('main'); home();
}
// guest hits a wall on anything account-backed → friendly sign-in gate
function gate(msg) {
    document.getElementById('gate')?.remove();
    const ov = document.createElement('div'); ov.id = 'gate';
    ov.innerHTML = `<div class="gate-card"><h3>Sign in to continue</h3>
        <p class="muted">${msg}</p>
        <button class="primary" id="gate-go">Sign in / Create account</button>
        <button class="ghost" id="gate-no">Not now</button></div>`;
    ov.querySelector('#gate-go').onclick = () => { ov.remove(); localStorage.removeItem('ck'); location.reload(); };
    ov.querySelector('#gate-no').onclick = () => ov.remove();
    ov.onclick = (e) => { if (e.target === ov) ov.remove(); };
    document.body.appendChild(ov);
}

async function bootstrap() {
    // assigned addon auto-install (same as the store app) + full account state
    const acc = await j(`${SERVICE}/tvapp/access?e=${encodeURIComponent(S.email)}&t=${encodeURIComponent(S.token)}`);
    S.access = acc && acc.allowed !== undefined ? { expires: acc.expires || '', daysLeft: acc.daysLeft } : null;
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
    // the SAME identity segment the Android apps send: "Name #<last-4-of-profile-id>" so
    // two same-named profiles never blend, and web + Firestick share ONE ckpos resume key
    S.useg = prof ? `${prof.name} #${String(prof.id).slice(-4)}` : S.user;
    $('prof-name').textContent = S.user;
    $('prof-avatar').textContent = prof?.avatar || '👤';
    applyAccountPrefs();
    lastSyncSig = syncSig();
    show('main'); home();
}

// live sync like the phone/Firestick: re-pull account state every 60s so what you watch
// on other devices shows up here without a restart. QUIET: the server re-derives the
// Continue order on every GET (tvSortContinue), so a full re-render every minute made
// the page visibly rebuild — now ONLY the hero + Continue row repaint, in place.
let lastSyncSig = '';
function syncSig() {
    const p = pstate();
    return JSON.stringify([p.continue, p.cwlast, p.positions, p.watchlist, p.watchedIds, p.prefs, p.newEpsSeen]);
}
setInterval(async () => {
    if (S.guest || !S.token || playing) return;
    const st = await j(`${SERVICE}/tvapp/state?e=${encodeURIComponent(S.email)}&t=${encodeURIComponent(S.token)}`);
    if (!st) return;
    S.state = st; applyAccountPrefs();
    const sig = syncSig();
    if (sig === lastSyncSig) return;
    lastSyncSig = sig;
    if (page === 'home') { hero(pstate()); paintContinueRow(); }
}, 60000);

// rail navigation: pages live side by side, rail icon marks the active one
let page = 'home';
function nav(which) {
    page = which;
    document.querySelectorAll('.rail-item.nav').forEach(n => n.classList.toggle('on', n.dataset.nav === which));
    for (const v of ['home', 'search', 'discover', 'library', 'settings', 'detail', 'person', 'episode'])
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

// ---------- posters / rows ----------
const IMG = (p, w = 342) => p ? (p.startsWith('http') ? p : `https://image.tmdb.org/t/p/w${w}${p}`) : '';
// tile = EXACT Firestick card: white bar on a dark track flush at the poster's bottom
// (only 2–97%), purple ✓ top-right = My List, yellow eye top-left = watched, "+N" =
// new episodes aired since last watched, single-line ELLIPSIZED centered title below
function posterEl(t, opts = {}) {
    const d = document.createElement('div'); d.className = 'poster';
    const st = pstate();
    const hasBar = opts.pct >= 2 && opts.pct <= 97;
    const inList = (st.watchlist || []).some(x => x.id === t.id);
    const isDone = (st.watchedIds || []).includes(t.id);
    d.innerHTML = `<div class="pwrap"><img loading="lazy" src="${t.poster || ''}">`
        + (opts.chip ? `<div class="ep-chip">${opts.chip}</div>` : '')
        + (opts.removable ? `<div class="cw-x" title="Remove from Continue Watching">✕</div>` : '')
        + (inList && !opts.removable ? '<div class="badge-list">✓</div>' : '')
        + (isDone && !opts.removable ? '<div class="badge-done">👁</div>' : '')
        + (opts.newEps > 0 ? `<div class="badge-new">+${opts.newEps}</div>` : '')
        + (hasBar ? `<div class="bar"><div style="width:${opts.pct}%"></div></div>` : '')
        + `</div>`
        + (PREF('titles', true) ? `<div class="pt" title="${(t.name || '').replace(/"/g, '&quot;')}">${t.name || ''}</div>` : '');
    d.onclick = (e) => { if (!e.target.classList.contains('cw-x')) detail(t); };
    if (opts.removable) d.querySelector('.cw-x').onclick = () => removeContinue(t, d);
    return d;
}
function removeContinue(t, el) {
    if (S.guest) return;
    const st = pstate();
    st.continue = (st.continue || []).filter(x => x.id !== t.id);
    st.removedTs = stamp(st.removedTs, t.id);
    // clear-progress tombstones so the removal reaches every device (server merge rule)
    const pos = st.positions || {};
    for (const k of Object.keys(pos)) if (k === t.id || k.startsWith(t.id + ':')) {
        st.removedTs = stamp(st.removedTs, 'pos:' + k); delete pos[k];
    }
    el.remove(); pushAccount();
    j(`${SERVICE}/player/clear`, { method: 'POST', body: { k: S.subKey, u: S.useg, i: t.id } });
}
function addRow(label, items, opts, holder) {
    if (!items?.length) return;
    const rows = holder || document.querySelector('#view-home .rows');
    if (label) { const l = document.createElement('div'); l.className = 'row-label'; l.textContent = label; rows.appendChild(l); }
    const s = document.createElement('div'); s.className = 'strip';
    for (const t of items) s.appendChild(posterEl(t, typeof opts === 'function' ? opts(t) : (opts || {})));
    rows.appendChild(s);
}
async function tmdbRow(kind, path, pages = 3, cap = 0) {
    const reqs = [];
    for (let p = 1; p <= pages; p++)
        reqs.push(j(`https://api.themoviedb.org/3/${path}${path.includes('?') ? '&' : '?'}api_key=${TMDB}&page=${p}`));
    const seen = new Set(); const out = [];
    for (const d of await Promise.all(reqs))
        for (const r of (d?.results || [])) {
            if (seen.has(r.id)) continue; seen.add(r.id);
            out.push({ tmdb: r.id, type: kind === 'tv' ? 'series' : 'movie', name: r.title || r.name,
                       poster: IMG(r.poster_path), backdrop: IMG(r.backdrop_path, 1280),
                       genres: r.genre_ids || [] });
        }
    return out.slice(0, cap || (pages > 3 ? 400 : 60));
}
async function cineRow(type, id, genre, pages = 1) {
    const reqs = [];
    for (let p = 0; p < pages; p++) {
        const g = genre ? `/genre=${encodeURIComponent(genre)}` : '';
        reqs.push(j(`${CINE}/catalog/${type}/${id}${g}${p ? (genre ? '&skip=' + p * 100 : '/skip=' + p * 100) : ''}.json`));
    }
    const out = []; const seen = new Set();
    for (const d of await Promise.all(reqs))
        for (const m of (d?.metas || [])) {
            if (seen.has(m.id)) continue; seen.add(m.id);
            out.push({ id: m.id, type, name: m.name, poster: m.poster });
        }
    return out.slice(0, pages > 2 ? 400 : 60);
}
async function idsRow(type, ids) {
    const metas = await Promise.all(ids.map(id =>
        j(`${CINE}/meta/movie/${id}.json`).then(d => d?.meta || j(`${CINE}/meta/series/${id}.json`).then(x => x?.meta))));
    const out = [];
    for (const m of metas) if (m) out.push({ id: m.id, type: m.type || type, name: m.name, poster: m.poster });
    return out;
}
async function rowItems(r) {
    if (r.ids) return idsRow(r.type, r.ids);   // curated watch orders: EXACT order, never shuffled
    if (r.tmdb) return profileMix(await tmdbRow(r.type === 'series' ? 'tv' : 'movie', r.tmdb));
    return profileMix(await cineRow(r.type, r.cine, r.genre, 2));
}
// deterministic per-profile per-day shuffle — stable all day, fresh mix tomorrow,
// different per profile (same seed rule as the TV app's profileMix)
function profileMix(items) {
    if (!items || items.length < 4) return items || [];
    const pid = S.pid || 'guest';
    let h = 0;
    for (let i = 0; i < pid.length; i++) h = (Math.imul(31, h) + pid.charCodeAt(i)) | 0;
    const day = Math.floor(Date.now() / 86400000);
    let seed = (Math.imul(h, 1000003) ^ day) >>> 0;
    const rnd = () => {   // mulberry32
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const a = [...items];
    for (let i = a.length - 1; i > 0; i--) {
        const k = Math.floor(rnd() * (i + 1));
        [a[i], a[k]] = [a[k], a[i]];
    }
    return a;
}
// For You — SAME consensus ranking as the TV app (votes across your watched/library seeds)
async function forYouRow(kind) {
    const st = pstate();
    const lib = [...(st.continue || []), ...(st.watchlist || []), ...(st.watchedTitles || [])];
    const seeds = lib.filter(t => kind === 'tv' ? t.type === 'series' : t.type !== 'series')
        .map(t => t.id).filter(id => id?.startsWith('tt'));
    if (!seeds.length) return [];
    const lists = await Promise.all([...new Set(seeds)].slice(0, 8).map(async imdb => {
        const f = await j(`https://api.themoviedb.org/3/find/${imdb}?api_key=${TMDB}&external_source=imdb_id`);
        const id = f?.[kind === 'tv' ? 'tv_results' : 'movie_results']?.[0]?.id;
        if (!id) return [];
        const d = await j(`https://api.themoviedb.org/3/${kind}/${id}/recommendations?api_key=${TMDB}`);
        return d?.results || [];
    }));
    const votes = {}; const best = {};
    for (const lst of lists) { const once = new Set();
        for (const o of lst) { if (o.id && !once.has(o.id)) { once.add(o.id); votes[o.id] = (votes[o.id] || 0) + 1; best[o.id] = best[o.id] || o; } } }
    return Object.values(best)
        .sort((a, b) => (votes[b.id] - votes[a.id]) || (b.popularity - a.popularity))
        .slice(0, 40)
        .map(r => ({ tmdb: r.id, type: kind === 'tv' ? 'series' : 'movie', name: r.title || r.name, poster: IMG(r.poster_path) }));
}

// ---------- new-episode badges (synced through newEpsSeen, key = season*10000+episode) ----------
const newEpCache = {};
async function newEpisodeCount(titleId) {
    if (titleId in newEpCache) return newEpCache[titleId];
    const st = pstate();
    const meta = (await j(`${CINE}/meta/series/${titleId}.json`))?.meta;
    const eps = (meta?.videos || []).filter(v => v.season > 0)
        .sort((a, b) => a.season - b.season || a.episode - b.episode);
    if (!eps.length) return (newEpCache[titleId] = 0);
    const aired = (e) => !e.released || new Date(e.released) <= new Date();
    const key = (e) => e.season * 10000 + e.episode;
    const latestAiredKey = Math.max(0, ...eps.filter(aired).map(key));
    // opening the show dismissed the badge (on ANY device — merged by max) until
    // something genuinely newer airs
    if (latestAiredKey > 0 && ((st.newEpsSeen || {})[titleId] || 0) >= latestAiredKey)
        return (newEpCache[titleId] = 0);
    const pos = st.positions || {};
    const watchedIds = new Set(st.watchedIds || []);
    const watched = eps.filter(e => {
        const k = `${titleId}:${e.season}:${e.episode}`;
        return watchedIds.has(k) || (parseInt(String(pos[k] || '').split('|')[0]) || 0) > 60000;
    });
    if (!watched.length) return (newEpCache[titleId] = 0);
    const last = watched[watched.length - 1];
    // deep back-catalog binges: "+9" means nothing when nothing new actually aired
    const maxSeason = Math.max(0, ...eps.filter(aired).map(e => e.season));
    if (last.season < maxSeason - 1) return (newEpCache[titleId] = 0);
    const n = Math.min(9, eps.filter(e => aired(e) && key(e) > key(last)).length);
    return (newEpCache[titleId] = n);
}
// opening a show's page clears its badge — record the latest aired key as seen (merged
// by MAX across devices, exactly like the Firestick)
function dismissNewEpsBadge(titleId, meta) {
    if (S.guest || meta?.type !== 'series') return;
    const eps = (meta.videos || []).filter(v => v.season > 0 && (!v.released || new Date(v.released) <= new Date()));
    if (!eps.length) return;
    const key = Math.max(...eps.map(e => e.season * 10000 + e.episode));
    const st = pstate();
    if (key > ((st.newEpsSeen || {})[titleId] || 0)) {
        st.newEpsSeen = { ...(st.newEpsSeen || {}), [titleId]: key };
        newEpCache[titleId] = 0;
        pushAccount();
    }
}

// ---------- home ----------
// SAME rule as the Firestick's cwProgress: the bar shows ONLY the episode you're on
// (cwlast) — never the max across the whole show (a finished S1E1 made a 2-min-into-S2E4
// card read "fully watched", AJ Sep 10)
function pctOf(st, t) {
    const key = t.type === 'series' ? (st.cwlast || {})[t.id] : t.id;
    if (!key) return 0;
    const [p, d] = String((st.positions || {})[key] || '').split('|').map(Number);
    return d > 0 ? Math.min(100, Math.round(100 * p / d)) : 0;
}
function cwChip(st, t) {
    if (t.type !== 'series') return '';
    const last = (st.cwlast || {})[t.id] || '';
    const [, s, e] = last.split(':');
    return s && e ? `S${s} · E${e}` : '';
}
let lastHeroKey = '';
async function hero(st) {
    const h = $('hero');
    let t = (st.continue || [])[0];
    let sub = '', bg = '';
    if (t) sub = t.type === 'series' && cwChip(st, t) ? `Continue watching · ${cwChip(st, t)}` : 'Continue watching';
    const heroKey = t ? t.id + '|' + sub : 'trend';
    if (heroKey === lastHeroKey && h.childElementCount) return;   // quiet sync: no repaint when nothing changed
    if (t) {
        const meta = (await j(`${CINE}/meta/${t.type}/${t.id}.json`))?.meta;
        bg = meta?.background || '';
    } else {
        const tr = await tmdbRow('tv', 'trending/tv/week', 1);
        t = tr[0]; bg = t?.backdrop || ''; sub = 'Trending this week';
        if (t) { const f = await j(`https://api.themoviedb.org/3/tv/${t.tmdb}/external_ids?api_key=${TMDB}`); if (f?.imdb_id) t.id = f.imdb_id; }
    }
    if (!t || !bg) { h.classList.add('hidden'); return; }
    lastHeroKey = heroKey;
    // no service on the account → tracker shell: More info only, no play button
    h.innerHTML = `<div class="hero-bg" style="background-image:url('${bg}')"></div><div class="hero-fade"></div>
        <div class="hero-body"><h2>${t.name || ''}</h2><div class="hero-sub">${sub}</div>
        <div class="hero-btns">${hasService() ? `<button class="primary">▶ ${st.continue?.length ? 'Resume' : 'Watch'}</button>` : ''}
        <button class="ghost">More info</button></div></div>`;
    h.classList.remove('hidden');
    const btns = h.querySelectorAll('button');
    const info = btns[btns.length - 1];
    info.onclick = (e) => { e.stopPropagation(); detail(t); };
    h.onclick = () => detail(t);
    if (hasService()) btns[0].onclick = async (e) => {
        e.stopPropagation();
        resumeTitle(t);
    };
}
// hero Resume / CW: series jumps straight to the current episode's page (auto-plays the
// top stream), movies play directly — same as the Firestick's resumeFromCw
async function resumeTitle(t) {
    const st = pstate();
    const last = (st.cwlast || {})[t.id];
    if (t.type === 'series' && last?.includes(':')) {
        const meta = (await j(`${CINE}/meta/series/${t.id}.json`))?.meta;
        const [, s, e] = last.split(':');
        const ep = (meta?.videos || []).find(v => v.season == s && v.episode == e);
        if (meta && ep) { episodePage({ id: t.id, type: 'series' }, meta, ep, true); return; }
    }
    await detail(t);
    if (t.type !== 'series') pickStream(t.id, t.name, true);
}
let cwHolderEl = null;
function paintContinueRow() {
    if (!cwHolderEl || !cwHolderEl.isConnected) return;
    const st = pstate();
    cwHolderEl.innerHTML = '';
    const cont = st.continue || [];
    if (!cont.length || !hasService()) return;
    addRow('Continue Watching', cont.map(t => ({ ...t })),
        (t) => ({ pct: pctOf(st, t), chip: cwChip(st, t), removable: !S.guest, newEps: newEpCache[t.id] || 0 }),
        cwHolderEl);
    // "+N new episodes" pass — fills badges in place once the counts land
    (async () => {
        let any = false;
        for (const t of cont.filter(x => x.type === 'series'))
            if (await newEpisodeCount(t.id) > 0) any = true;
        if (any && cwHolderEl.isConnected) {
            cwHolderEl.innerHTML = '';
            addRow('Continue Watching', cont.map(t => ({ ...t })),
                (t) => ({ pct: pctOf(st, t), chip: cwChip(st, t), removable: !S.guest, newEps: newEpCache[t.id] || 0 }),
                cwHolderEl);
        }
    })();
}
// Netflix's Top 10 shelf — giant ghost rank numeral tucked behind each poster, same
// trending/day movie+show interleave as the TV app, never profile-shuffled
async function top10Row(holder) {
    const [mv, tv] = await Promise.all([
        tmdbRow('movie', 'trending/movie/day', 1),
        tmdbRow('tv', 'trending/tv/day', 1),
    ]);
    const mix = [];
    for (let i = 0; i < Math.max(mv.length, tv.length); i++) {
        if (mv[i]) mix.push(mv[i]);
        if (tv[i]) mix.push(tv[i]);
    }
    const ten = mix.slice(0, 10);
    if (!ten.length || !holder.isConnected) return;
    holder.innerHTML = '';
    const l = document.createElement('div'); l.className = 'row-label'; l.textContent = 'Top 10 Today';
    holder.appendChild(l);
    const strip = document.createElement('div'); strip.className = 'strip top10';
    ten.forEach((t, i) => {
        const cell = document.createElement('div'); cell.className = 'top10-cell' + (i === 9 ? ' wide' : '');
        const num = document.createElement('div'); num.className = 'top10-num'; num.textContent = i + 1;
        cell.appendChild(num);
        cell.appendChild(posterEl(t));
        strip.appendChild(cell);
    });
    holder.appendChild(strip);
}
async function home() {
    const rows = document.querySelector('#view-home .rows');
    rows.innerHTML = '';
    lastHeroKey = '';
    const st = pstate();
    hero(st);
    // Continue Watching lives in a STABLE holder so the 60s sync can repaint just it
    cwHolderEl = document.createElement('div'); rows.appendChild(cwHolderEl);
    paintContinueRow();
    // Top 10 rides right under Continue Watching (leads the page when there's no CW)
    const top10Holder = document.createElement('div'); rows.appendChild(top10Holder);
    top10Row(top10Holder);
    // rows land IN CATALOG ORDER via pre-placed slots (async fills used to append in
    // completion order — the board shuffled on every load and looked nothing like the TV)
    const slot = () => { const s = document.createElement('div'); rows.appendChild(s); return s; };
    const fill = (holder, label, items) => {
        if (!items?.length) { holder.remove(); return; }
        addRow(label, items, null, holder);
    };
    if (!S.guest) {
        const fm = slot(), fs = slot();
        forYouRow('movie').then(x => fill(fm, 'For You — Movies', x));
        forYouRow('tv').then(x => fill(fs, 'For You — Series', x));
    }
    // the profile's shelf line-up SYNCS from the account (same picks as the Firestick)
    const enabled = (st.shelves && st.shelves.length) ? st.shelves : CK_CAT.DEFAULT_SHELVES;
    for (const r of CK_CAT.SHELF_CATALOG.filter(x => enabled.includes(x.label))) {
        const s = slot();
        rowItems(r).then(items => fill(s, r.label, items));
    }
}

// ---------- search (movies + shows + PEOPLE, like the apps) ----------
let searchT = null;
$('search').addEventListener('input', () => {
    clearTimeout(searchT);
    searchT = setTimeout(async () => {
        const q = $('search').value.trim();
        const holder = $('search-rows');
        holder.innerHTML = '';
        if (q.length < 2) return;
        const [m, s, people] = await Promise.all([
            j(`${CINE}/catalog/movie/top/search=${encodeURIComponent(q)}.json`),
            j(`${CINE}/catalog/series/top/search=${encodeURIComponent(q)}.json`),
            searchPeople(q),
        ]);
        if ($('search').value.trim() !== q) return;
        const map = (d, ty) => (d?.metas || []).slice(0, 25).map(x => ({ id: x.id, type: ty, name: x.name, poster: x.poster }));
        if (people.length) {
            const l = document.createElement('div'); l.className = 'row-label'; l.textContent = 'People';
            holder.appendChild(l);
            const strip = document.createElement('div'); strip.className = 'strip';
            for (const p of people) strip.appendChild(personCard(p));
            holder.appendChild(strip);
        }
        addRow('Shows', map(s, 'series'), null, holder);
        addRow('Movies', map(m, 'movie'), null, holder);
        if (!holder.childElementCount) holder.innerHTML = `<p class="muted" style="padding-top:1rem">No results for “${q}”</p>`;
    }, 400);
});
// face + name matches for a typed query — real people search, not just text chips
async function searchPeople(q) {
    const d = await j(`https://api.themoviedb.org/3/search/person?api_key=${TMDB}&query=${encodeURIComponent(q)}`);
    const seen = new Set();
    return (d?.results || [])
        .sort((a, b) => (b.popularity || 0) - (a.popularity || 0))
        .filter(p => p.name && !seen.has(p.name) && seen.add(p.name))
        .slice(0, 8)
        .map(p => ({ id: p.id, name: p.name,
            photo: p.profile_path ? `https://image.tmdb.org/t/p/w185${p.profile_path}` : '',
            role: p.known_for_department === 'Directing' ? 'Director' : 'Actor' }));
}
function personCard(p) {
    const d = document.createElement('div'); d.className = 'person-card';
    d.innerHTML = `<div class="person-photo">${p.photo ? `<img src="${p.photo}">` : '👤'}</div>
        <div class="pt">${p.name}</div><div class="person-role">${p.role}</div>`;
    d.onclick = () => personPage(p);
    return d;
}
// Stremio-style person page: who they are + what they've been in (acting or directing)
async function personPage(p) {
    nav('person');
    const body = $('person-body');
    body.innerHTML = `<button class="ghost small" id="person-back">‹ Back</button>
        <div class="person-head">${p.photo ? `<img src="${p.photo}">` : ''}<div><h2>${p.name}</h2><div class="muted">${p.role}</div></div></div>
        <div id="person-rows"><p class="muted">Loading…</p></div>`;
    $('person-back').onclick = () => nav('search');
    const c = await j(`https://api.themoviedb.org/3/person/${p.id}/combined_credits?api_key=${TMDB}`);
    const credits = [...(c?.cast || []), ...((c?.crew || []).filter(x => x.job === 'Director'))];
    const seen = new Set();
    const uniq = credits.filter(x => {
        const k = x.media_type + x.id;
        return x.poster_path && !seen.has(k) && seen.add(k);
    }).sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
    const mk = (x) => ({ tmdb: x.id, type: x.media_type === 'tv' ? 'series' : 'movie',
        name: x.title || x.name, poster: IMG(x.poster_path) });
    const rows = $('person-rows'); rows.innerHTML = '';
    addRow('Shows', uniq.filter(x => x.media_type === 'tv').slice(0, 14).map(mk), null, rows);
    addRow('Movies', uniq.filter(x => x.media_type === 'movie').slice(0, 14).map(mk), null, rows);
    if (!rows.childElementCount) rows.innerHTML = '<p class="muted">Nothing found.</p>';
}

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
    cur = { imdb, type: t.type, meta, t: { ...t, id: imdb } };
    dismissNewEpsBadge(imdb, meta);   // opening the show clears its "+N" badge everywhere
    nav('detail');
    $('detail-backdrop').style.backgroundImage = meta.background ? `url('${meta.background}')` : '';
    const st = pstate();
    const moviePct = t.type === 'movie' ? pctOf(st, { id: imdb }) : 0;
    const b = $('detail-body');
    b.innerHTML = `<div class="d-head"><img class="d-poster" src="${meta.poster || t.poster || ''}">
        <div><h2>${meta.name}</h2>
        <div class="d-meta">${meta.year || ''}${meta.runtime ? ' · ' + meta.runtime : ''} · ⭐ ${meta.imdbRating || '—'}${(meta.genres || []).length ? ' · ' + meta.genres.slice(0, 3).join(', ') : ''}</div>
        <div class="d-desc">${meta.description || ''}</div>
        <div class="d-btns">
          ${t.type === 'movie' && hasService() ? `<button class="primary" id="d-play">▶ ${moviePct > 0 && moviePct < 92 ? `Resume · ${moviePct}%` : 'Play'}</button>` : ''}
          <button class="ghost hidden" id="d-trailer">🎬 Trailer</button>
          <button class="ghost" id="d-list"></button>
          <button class="ghost" id="d-watched"></button>
        </div>
        <div id="d-cast" class="cast-row"></div>
        <div id="d-wtw" class="wtw"></div>
        </div></div>
        <div id="d-eps"></div><div id="d-streams" class="streams"></div>`;
    // trailer (AJ Sep 13: web had no trailer option) — plays in an in-app overlay
    const ytId = meta.trailers?.[0]?.source || meta.trailerStreams?.[0]?.ytId || null;
    if (ytId) { $('d-trailer').classList.remove('hidden'); $('d-trailer').onclick = () => playTrailerWeb(ytId); }
    // clickable cast (AJ Sep 13) — name chips open the same person page search results use
    const castHolder = $('d-cast');
    for (const nm of (meta.cast || []).slice(0, 10)) {
        const c = document.createElement('span'); c.className = 'chip chip-cast'; c.textContent = nm;
        c.onclick = async () => {
            const r = await j(`https://api.themoviedb.org/3/search/person?query=${encodeURIComponent(nm)}&api_key=${TMDB}`);
            const hit = r?.results?.[0];
            if (hit) personPage({ id: hit.id, name: hit.name, role: 'Actor',
                photo: hit.profile_path ? `https://image.tmdb.org/t/p/w185${hit.profile_path}` : null });
        };
        castHolder.appendChild(c);
    }
    const tt = { id: imdb, type: t.type, name: meta.name, poster: meta.poster || t.poster || '' };
    const paintBtns = () => {
        const st = pstate();
        $('d-list').textContent = (st.watchlist || []).some(x => x.id === imdb) ? '✓ In My List' : '+ My List';
        $('d-watched').textContent = (st.watchedIds || []).includes(imdb) ? '✓ Watched' : 'Mark watched';
    };
    $('d-list').onclick = () => { if (S.guest) return gate('My List syncs across your devices with a free account.'); toggleList(tt); paintBtns(); };
    $('d-watched').onclick = () => { if (S.guest) return gate('Watch history syncs across your devices with a free account.'); toggleWatchedTitle(tt); paintBtns(); };
    paintBtns();
    if (!hasService()) whereToWatch(imdb, t.type);   // tracker shell: providers, not streams
    if (t.type === 'movie') { if (hasService()) $('d-play').onclick = () => pickStream(imdb, meta.name); }
    else seasons(meta);
}
// where-to-watch (guest / no-service accounts): TMDB providers, same idea as the TV app
async function whereToWatch(imdb, type) {
    const f = await j(`https://api.themoviedb.org/3/find/${imdb}?api_key=${TMDB}&external_source=imdb_id`);
    const id = f?.[type === 'series' ? 'tv_results' : 'movie_results']?.[0]?.id;
    if (!id) return;
    const d = await j(`https://api.themoviedb.org/3/${type === 'series' ? 'tv' : 'movie'}/${id}/watch/providers?api_key=${TMDB}`);
    const us = d?.results?.US;
    const holder = $('d-wtw'); if (!holder) return;
    if (!us) { holder.innerHTML = '<div class="wtw-kind">Where to watch</div><span class="muted">No streaming info for this title.</span>'; return; }
    let html = '';
    for (const [kind, label] of [['flatrate', 'Stream'], ['free', 'Free'], ['rent', 'Rent'], ['buy', 'Buy']]) {
        const list = us[kind];
        if (!list?.length) continue;
        // every chip LINKS OUT to the watch page (AJ: "buy rent and watch should all be links")
        html += `<div class="wtw-kind">${label}</div>` + list.slice(0, 8).map(p =>
            `<a class="prov" href="#" data-ext="${us.link || 'https://www.themoviedb.org'}"><img src="https://image.tmdb.org/t/p/w92${p.logo_path}">${p.provider_name} ↗</a>`).join('');
    }
    holder.innerHTML = html ? `<div class="wtw-kind" style="margin-top:0">Where to watch</div>` + html : '';
}
function seasons(meta) {
    const eps = (meta.videos || []).filter(v => v.season > 0);
    const ss = [...new Set(eps.map(e => e.season))].sort((a, b) => a - b);
    const holder = $('d-eps');
    const bar = document.createElement('div'); bar.className = 'season-row';
    const lbl = document.createElement('div'); lbl.className = 'row-label'; lbl.textContent = 'Episodes';
    const sel = document.createElement('select');
    for (const sn of ss) { const o = document.createElement('option'); o.value = sn; o.textContent = 'Season ' + sn; sel.appendChild(o); }
    bar.append(lbl, sel);
    const list = document.createElement('div');
    holder.replaceChildren(bar, list);
    const paint = (sn) => {
        const st = pstate();
        const pos = st.positions || {};
        const watched = new Set(st.watchedIds || []);
        const doBlur = PREF('blur', false);
        list.innerHTML = '';
        for (const e of eps.filter(x => x.season === sn).sort((a, b) => a.episode - b.episode)) {
            const key = `${cur.imdb}:${e.season}:${e.episode}`;
            const [p, d] = String(pos[key] || '').split('|').map(Number);
            const pct = d > 0 ? Math.round(100 * p / d) : 0;
            const seen = watched.has(key);
            const aired = !e.released || new Date(e.released) <= new Date();
            const el = document.createElement('div'); el.className = 'ep';
            el.style.opacity = aired ? 1 : .45;
            el.innerHTML = `<div class="ep-thumb">
                  <img loading="lazy" src="${e.thumbnail || ''}" class="${doBlur && !seen && aired ? 'blur' : ''}">
                  ${seen ? '<div class="seen">✓</div>' : ''}
                  ${pct > 0 ? `<div class="ebar"><div style="width:${pct}%"></div></div>` : ''}
                </div>
                <div class="et"><b>${e.episode}. ${e.name || ''}</b><span>${(e.released || '').slice(0, 10)}${aired ? '' : ' · not aired'}</span>
                ${e.overview && !(doBlur && !seen) ? `<div class="ep-desc">${e.overview}</div>` : ''}</div>
                <button class="ep-eye" title="${seen ? 'Watched — click to unmark' : 'Mark episode watched'}">${seen ? '✓' : '👁'}</button>`;
            // Stremio-style: the episode click opens its own PAGE (facts + streams filling
            // in) — never a toast-and-wait, never streams dumped at the page bottom
            el.onclick = () => aired && episodePage(cur.t, meta, e);
            el.querySelector('.ep-eye').onclick = (ev) => {
                ev.stopPropagation();
                if (S.guest) return gate('Track watched episodes with a free account.');
                toggleEpWatched(key); paint(sn);
            };
            list.appendChild(el);
        }
    };
    // open on the season you're currently in (cwlast — synced from every device)
    const last = (pstate().cwlast || {})[cur.imdb];
    const startSn = last ? +(last.split(':')[1] || ss[0]) : ss[0];
    sel.value = ss.includes(startSn) ? startSn : ss[0];
    sel.onchange = () => paint(+sel.value);
    paint(+sel.value);
    // metahub-404 fallback (Sep 13, Bleach TYBW): paint first, then swap in TMDB stills if
    // metahub has none for this show, and repaint the open season in place
    fixEpThumbs(meta).then(ch => { if (ch) paint(+sel.value); }).catch(() => {});
}

/** Probe one metahub episode still; on a miss swap ALL episode thumbnails to TMDB stills.
 *  TMDB may model the show under different season numbering (TYBW = "Bleach season 2",
 *  absolute), so episodes match by air date (exact, then ±1 day for JP-vs-US air dates),
 *  then by unique name, then ordinally when both lists are the same length.
 *  Mutates meta.videos in place; resolves true when anything changed. */
const _epThumbFixed = new Set();
function imgOk(url) {
    return new Promise(res => {
        const im = new Image();
        im.onload = () => res(true); im.onerror = () => res(false);
        setTimeout(() => res(false), 4000);
        im.src = url;
    });
}
async function fixEpThumbs(meta) {
    const id = meta.imdb_id || meta.id || '';
    if (!id || _epThumbFixed.has(id)) return false;
    const eps = (meta.videos || []).filter(v => v.season > 0);
    const probe = eps.find(v => (v.thumbnail || '').includes('episodes.metahub.space'))?.thumbnail;
    if (!probe || await imgOk(probe)) return false;
    _epThumbFixed.add(id);
    try {
        let tv = (await j(`https://api.themoviedb.org/3/find/${id}?api_key=${TMDB}&external_source=imdb_id`))?.tv_results?.[0]?.id;
        if (!tv && meta.name)
            tv = (await j(`https://api.themoviedb.org/3/search/tv?query=${encodeURIComponent(meta.name)}&api_key=${TMDB}`))?.results?.[0]?.id;
        if (!tv) return false;
        const show = await j(`https://api.themoviedb.org/3/tv/${tv}?api_key=${TMDB}`);
        const flat = [];
        for (const s of (show?.seasons || []).filter(s => s.season_number > 0)) {
            const sj = await j(`https://api.themoviedb.org/3/tv/${tv}/season/${s.season_number}?api_key=${TMDB}`);
            for (const e of (sj?.episodes || []))
                flat.push({ date: e.air_date || '', name: (e.name || '').trim().toLowerCase(),
                            still: e.still_path ? `https://image.tmdb.org/t/p/w500${e.still_path}` : '' });
        }
        const withStill = flat.filter(x => x.still);
        if (!withStill.length) return false;
        const byDate = {}; withStill.forEach(x => (byDate[x.date] = byDate[x.date] || []).push(x));
        const byName = {}; withStill.forEach(x => byName[x.name] = (x.name in byName) ? null : x);
        const shift = (d, by) => { const t = new Date(d + 'T00:00:00Z'); if (isNaN(t)) return null; t.setUTCDate(t.getUTCDate() + by); return t.toISOString().slice(0, 10); };
        const sameLen = eps.length === flat.length;
        let changed = false;
        eps.forEach((e, i) => {
            const iso = (e.released || '').slice(0, 10);
            let still = byDate[iso]?.[0]?.still || byDate[shift(iso, 1)]?.[0]?.still || byDate[shift(iso, -1)]?.[0]?.still;
            if (!still) still = byName[(e.name || '').trim().toLowerCase()]?.still || null;
            if (!still && sameLen) still = flat[i].still || null;
            if (still && still !== e.thumbnail) { e.thumbnail = still; changed = true; }
        });
        return changed;
    } catch (_) { return false; }
}

// per-episode watched toggle (eye button — same as the phone/Firestick)
function toggleEpWatched(key) {
    const st = pstate(); st.watchedIds = st.watchedIds || [];
    const i = st.watchedIds.indexOf(key);
    if (i >= 0) { st.watchedIds.splice(i, 1); st.removedTs = stamp(st.removedTs, key); }
    else { st.watchedIds.push(key); st.addedTs = stamp(st.addedTs, key); }
    pushAccount();
}

// ---------- episode page (Stremio-style, mirrors the TV app's showEpisodeDetail) ----------
let epPollToken = 0;
async function episodePage(t, meta, ep, autoplay = false) {
    cur = { imdb: meta.id, type: 'series', meta, t: { ...t, id: meta.id } };
    const sid = `${meta.id}:${ep.season}:${ep.episode}`;
    const label = `${meta.name} S${ep.season}E${ep.episode}`;
    nav('episode');
    $('episode-backdrop').style.backgroundImage =
        (meta.background || ep.thumbnail || meta.poster) ? `url('${meta.background || ep.thumbnail || meta.poster}')` : '';
    $('ep-back').onclick = () => detail(cur.t);
    const body = $('episode-body');
    const st = pstate();
    const [p, d] = String((st.positions || {})[sid] || '').split('|').map(Number);
    const resumePct = p > 60000 && d > 0 ? Math.round(100 * p / d) : 0;
    // logo (or name) big, then "year · SxxEyy · air date · name", resume %, description,
    // Mark watched, then the streams strip filling in
    body.innerHTML = `
        ${meta.logo ? `<img class="ep-logo" src="${meta.logo}">` : `<h2>${meta.name}</h2>`}
        <div class="ep-facts">${[meta.year, `S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}`,
            (ep.released || '').slice(0, 10), ep.name].filter(Boolean).join('  ·  ')}</div>
        ${resumePct > 0 ? `<div class="ep-resume">Resume from ${resumePct}%</div>` : ''}
        ${ep.overview || ep.description ? `<div class="d-desc" style="margin:.5rem 0">${ep.overview || ep.description || ''}</div>` : ''}
        <button class="ghost small" id="ep-watched"></button>
        <div class="row-label">Streams</div>
        <div class="muted" id="ep-note">Finding streams…</div>
        <div id="ep-streams" class="streams"></div>`;
    const paintWt = () => {
        $('ep-watched').textContent = (pstate().watchedIds || []).includes(sid) ? '✓ Watched' : 'Mark watched';
    };
    $('ep-watched').onclick = () => { if (S.guest) return gate('Track watched episodes with a free account.'); toggleEpWatched(sid); paintWt(); };
    paintWt();
    if (!hasService()) { $('ep-note').textContent = 'Streams need a connected account.'; return; }
    // a just-aired episode is usually still CACHING — poll every 15s (up to ~3 min) and
    // fill streams in the moment the download lands (same rule as the Firestick)
    const token = ++epPollToken;
    const base = S.addons[0].url.replace(/\/$/, '');
    let streams = [], tries = 0;
    const fetchStreams = async () =>
        (await j(`${base}/stream/series/${encodeURIComponent(sid)}.json`, { timeoutMs: 30000 }))?.streams || [];
    streams = await fetchStreams();
    const aired = !ep.released || new Date(ep.released) <= new Date();
    while (!streams.length && aired && tries < 12 && token === epPollToken && page === 'episode') {
        $('ep-note').textContent = 'Getting this episode ready — it’ll appear here in a minute or two…';
        await new Promise(r => setTimeout(r, 15000));
        if (token !== epPollToken || page !== 'episode') return;
        streams = await fetchStreams();
        tries++;
    }
    if (token !== epPollToken) return;
    if (!streams.length) {
        $('ep-note').textContent = !aired ? 'This episode hasn’t aired yet.' : 'Still getting this ready — check back in a minute.';
        return;
    }
    $('ep-note').classList.add('hidden');
    const holder = $('ep-streams');
    holder.innerHTML = '';
    for (const s of streams) {
        const el = streamEl(s);
        el.onclick = () => playEpisodeStream(s, meta, ep, sid, label);
        holder.appendChild(el);
    }
    if (autoplay && streams[0]) playEpisodeStream(streams[0], meta, ep, sid, label);
}
function playEpisodeStream(s, meta, ep, sid, label) {
    // Continue Watching means you PLAYED it — not that you looked at the page
    if (!S.guest) {
        pushContinueLocal({ id: meta.id, type: 'series', name: meta.name, poster: meta.poster || '' });
        const st = pstate();
        st.cwlast = { ...(st.cwlast || {}), [meta.id]: sid };
        pushAccount();
    }
    play(s.url, label, sid, s.subtitles || null);
}

// ---------- streams + play ----------
/** In-app trailer overlay (AJ Sep 13: "why not in our player, in our app") — a YouTube
 *  embed runs from the viewer's own IP, so no bot-wall; ESC or ✕ closes. */
function playTrailerWeb(ytId) {
    if (ck.platform !== 'web' && ck.openTrailer) { ck.openTrailer(ytId); return; }
    const cover = document.createElement('div');
    cover.id = 'trailer-cover';
    cover.style.cssText = 'position:fixed;inset:0;z-index:9998;background:rgba(5,4,12,.96);display:flex;align-items:center;justify-content:center';
    cover.innerHTML = `<iframe width="80%" style="aspect-ratio:16/9;border:0;border-radius:12px"
        src="https://www.youtube-nocookie.com/embed/${ytId}?autoplay=1&rel=0" allow="autoplay; fullscreen" allowfullscreen></iframe>
        <button style="position:absolute;top:18px;right:22px;background:#2a2545;color:#fff;border:none;border-radius:999px;padding:.5rem .9rem;cursor:pointer;font-size:1rem">✕ Close</button>`;
    const close = () => { cover.remove(); document.removeEventListener('keydown', esc); };
    const esc = (e) => { if (e.key === 'Escape') close(); };
    cover.querySelector('button').onclick = close;
    cover.onclick = (e) => { if (e.target === cover) close(); };
    document.addEventListener('keydown', esc);
    document.body.appendChild(cover);
}

/** One stream row, prettier (AJ Sep 13 "make the streams look better"): source name,
 *  quality/flavor as chips, episode line under it, ⏳ notes highlighted. */
function streamEl(st) {
    const el = document.createElement('div'); el.className = 'stream';
    const parts = String(st.name || '').split('|').map(x => x.trim()).filter(Boolean);
    const src = parts.shift() || 'Stream';
    const lines = String(st.description || st.title || '').split('\n');
    el.innerHTML = `<div class="stream-top"><b>${src}</b>${parts.map(c =>
            `<span class="chip chip-${c.toLowerCase().replace(/[^a-z0-9]/g, '')}">${c}</span>`).join('')}</div>
        <div class="stream-title">${lines[0] || ''}</div>
        ${lines[1] ? `<div class="stream-note">${lines[1]}</div>` : ''}`;
    return el;
}

async function pickStream(sid, label, autoFirst = false) {
    if (!hasService()) return;   // tracker shell: no stream fetches without a service
    const holder = $('d-streams');
    holder.innerHTML = '<div class="muted">Finding streams…</div>';
    const base = S.addons[0].url.replace(/\/$/, '');
    const type = sid.includes(':') ? 'series' : 'movie';
    const d = await j(`${base}/stream/${type}/${encodeURIComponent(sid)}.json`, { timeoutMs: 30000 });
    const streams = d?.streams || [];
    if (!streams.length) { holder.innerHTML = '<div class="muted">Getting this ready — try again in a minute.</div>'; return; }
    const start = (st) => {
        if (!S.guest && cur?.meta) {
            pushContinueLocal({ id: sid.split(':')[0], type, name: cur.meta.name, poster: cur.meta.poster || '' });
            pushAccount();
        }
        play(st.url, label, sid, st.subtitles || null);
    };
    if (autoFirst && streams[0]) { start(streams[0]); return; }
    holder.innerHTML = '<div class="row-label">Streams</div>';
    for (const st of streams) {
        const el = streamEl(st);
        el.onclick = () => start(st);
        holder.appendChild(el);
    }
}

function nextEpisodeOf(sid) {
    if (!cur?.meta?.videos || !sid.includes(':')) return null;
    const [, s, e] = sid.split(':');
    const eps = cur.meta.videos.filter(v => v.season > 0).sort((a, b) => a.season - b.season || a.episode - b.episode);
    const i = eps.findIndex(x => x.season == s && x.episode == e);
    if (i < 0) return null;
    return eps.slice(i + 1).find(x => !x.released || new Date(x.released) <= new Date()) || null;
}

let playing = null;
async function play(url, label, sid, subs = null) {
    const imdb = sid.split(':')[0];
    const [, s, e] = sid.split(':');
    // cross-device resume + learned intro window + learned credits point, one call
    let startSec = 0, introFromMs = -1, introToMs = -1, creditsMs = 0;
    try {
        const r = await j(`${SERVICE}/player/resume?k=${S.subKey}&u=${encodeURIComponent(S.useg)}&i=${imdb}&s=${s || ''}&e=${e || ''}`);
        if (r) {
            if (String(r.s || '') === String(s || '') && String(r.e || '') === String(e || '') && r.pos > 60000 && r.pct < 92)
                startSec = Math.floor(r.pos / 1000);
            if (r.introFrom != null && r.introTo > r.introFrom) { introFromMs = r.introFrom; introToMs = r.introTo; }
            if (r.credits > 0) creditsMs = r.credits;
        }
    } catch {}
    // whichever device is further in wins — but a local synced position can be fresher
    const [lp, ld] = String((pstate().positions || {})[sid] || '').split('|').map(Number);
    if (lp > 60000 && ld > 0 && lp / ld < 0.92 && lp / 1000 > startSec) startSec = Math.floor(lp / 1000);
    const next = nextEpisodeOf(sid);
    playing = { sid, imdb, s, e, label, pos: 0, dur: 0, startMs: startSec * 1000, credits: creditsMs, next };
    if (ck.platform !== 'web') {
        $('playing-title').textContent = label;
        $('playing').classList.remove('hidden');
    }
    await ck.play({ url, title: label, startSec, sid, subs: subs || [],
        subScale: PREF('subscale', 1.0), subLang: PREF('sublang', 'en'), audioLang: PREF('audlang', 'en'),
        subBg: PREF('subbg', false), subOutline: PREF('suboutline', true), subPos: PREF('subpos', 0),
        seekStep: PREF('seek', 10),
        introFromMs, introToMs, creditsMs,
        hasNext: !!(next && hasService()), autonext: PREF('autonext', true),
        nextLabel: next ? `${cur?.meta?.name || ''} S${next.season}E${next.episode}${next.name ? ' — ' + next.name : ''}` : '' });
}
ck.onMpvDead?.((d) => {
    // phone-home the real failure so it can be fixed without the user doing anything
    try {
        j(`${SERVICE}/tvapp/diag`, { method: 'POST', body: { email: S.email, token: S.token,
            text: `desktop mpv died: code=${d?.code} sig=${d?.signal} bin=${(d?.bin || '').split('/').slice(-4).join('/')} err=${(d?.err || '').slice(-600)}` } });
    } catch {}
    // mpv died instantly (macOS killed the binary / broken install) — say so and offer
    // the in-window fallback instead of silently doing nothing (AJ Sep 13, Mac)
    const n = document.createElement('div');
    n.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:9999;' +
        'background:#2a1e1e;color:#ffb3b3;border:1px solid #663;border-radius:10px;padding:.8rem 1.2rem;max-width:640px;text-align:center';
    n.innerHTML = 'The video engine was blocked by macOS. <b>Update to the latest version from couchking.app/downloads</b> — it fixes this. (Playback also works at couchking.app/app meanwhile.)';
    document.body.appendChild(n);
    setTimeout(() => n.remove(), 12000);
});

ck.onMpvPos(({ pos, dur }) => {
    if (!playing) return;
    playing.pos = pos; playing.dur = dur;
    if (dur > 0) $('playing-pos').textContent = `${fmt(pos)} / ${fmt(dur)}`;
    // instant start-stamp (AJ Sep 13, full-sync): the moment playback begins, position +
    // resume pointer push to the account — every other device knows within seconds,
    // half a second of watching counts (same rule as TV v2.0)
    if (dur > 0 && !playing.startStamped && !S.guest) {
        playing.startStamped = true;
        const st = pstate();
        st.positions = st.positions || {};
        st.positions[playing.sid] = `${Math.max(Math.round(pos * 1000), 500)}|${Math.round(dur * 1000)}|${Date.now()}`;
        if (playing.s) st.cwlast = { ...(st.cwlast || {}), [playing.imdb]: playing.sid };
        Promise.resolve(pushAccount()).catch(() => {});
    }
});
// position where the episode is "basically over" (credits rolling) — same rule as the
// TV player: credits lead (subs-last-cue → learned clicks → 90s), FLOORED at 80%
function finishPointSec(durSec, creditsMs, lastCueSec) {
    const subsLead = lastCueSec > 0 ? durSec - lastCueSec - 2 : -1;
    const lead = (subsLead >= 15 && subsLead <= 300) ? subsLead
        : (creditsMs > 0 ? Math.min(240, Math.max(20, (creditsMs + 5000) / 1000)) : 90);
    return Math.max(durSec - lead, durSec * 0.8);
}
ck.onMpvExit(async ({ pos, dur, next = false, credits = 0, lastCue = 0 }) => {
    $('playing').classList.add('hidden');
    const p = playing; playing = null;
    if (!p || !dur || pos < 0.5) { if (p && next) advanceNext(p); return; }   // 0.5s floor (AJ Sep 13, was 5s)
    const posMs = Math.floor(pos * 1000), durMs = Math.floor(dur * 1000);
    // one beacon per sit-down — powers For You + cross-device resume (same as TV app);
    // a human's next-click near the end also teaches the server where credits start
    await j(`${SERVICE}/player/progress`, { method: 'POST', body: {
        k: S.subKey, u: S.useg, i: p.imdb, s: p.s || '', e: p.e || '',
        pos: posMs, dur: durMs,
        ...(next && credits >= 5000 && credits <= 300000 ? { credits } : {}) } });
    // the exact same watched rule as the Firestick: only past the finish point (credits
    // lead, ≥80% floor) AND a real sitting (2+ min or true end) — a bogus near-end
    // landing + immediate back must NOT count as watched
    const finish = finishPointSec(dur, p.credits, lastCue);
    const realSit = posMs - p.startMs >= 120000 || posMs >= durMs - 5000;
    const watchedNow = pos >= finish && realSit;
    if (!S.guest) {
        const st = pstate();
        // STAMPED position + cwlast into the synced blob — exactly what the Android apps
        // write, so every device's Continue row and resume % agree with this one
        st.positions = st.positions || {};
        st.positions[p.sid] = `${posMs}|${durMs}|${Date.now()}`;
        if (p.s) st.cwlast = { ...(st.cwlast || {}), [p.imdb]: p.sid };
        if (watchedNow) {
            if (p.s) {   // episode → checkmark (blur-clear + eye sync to every device)
                st.watchedIds = st.watchedIds || [];
                if (!st.watchedIds.includes(p.sid)) { st.watchedIds.push(p.sid); st.addedTs = stamp(st.addedTs, p.sid); }
            } else {     // a FINISHED movie leaves Continue Watching (real finish only)
                st.watchedIds = st.watchedIds || [];
                if (!st.watchedIds.includes(p.imdb)) { st.watchedIds.push(p.imdb); st.addedTs = stamp(st.addedTs, p.imdb); }
                st.watchedTitles = [{ id: p.imdb, type: 'movie', name: cur?.meta?.name || p.label, poster: cur?.meta?.poster || '' },
                    ...(st.watchedTitles || []).filter(x => x.id !== p.imdb)].slice(0, 60);
                st.continue = (st.continue || []).filter(x => x.id !== p.imdb);
                st.removedTs = stamp(st.removedTs, 'pos:' + p.imdb);
                delete st.positions[p.imdb];
            }
        }
        await pushAccount();
        lastSyncSig = syncSig();
    }
    if (page === 'home') { hero(pstate()); paintContinueRow(); }
    if (page === 'detail' && cur?.meta && p.s) seasons(cur.meta);
    // AUTOPLAY NEXT: an explicit next-click always advances; a natural finish advances
    // when the setting is on and the episode really ended
    if (p.s && (next || (PREF('autonext', true) && watchedNow && pos >= dur - 5)))
        advanceNext(p);
});
function advanceNext(p) {
    const nxt = p.next || nextEpisodeOf(p.sid);
    if (!nxt || !cur?.meta) return;
    episodePage(cur.t || { id: p.imdb, type: 'series' }, cur.meta, nxt, true);
}
const fmt = (s) => { s = Math.floor(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return (h ? h + ':' : '') + String(m).padStart(h ? 2 : 1, '0') + ':' + String(s % 60).padStart(2, '0'); };
$('playing-stop').onclick = () => ck.stopPlay();

// ---------- wiring ----------
$('auth-signin').onclick = () => auth('signin');
$('auth-signup').onclick = () => auth('signup');
$('auth-guest').onclick = () => guest();
$('back').onclick = () => { nav('home'); };

(async () => {
    SERVICE = await ck.service();
    const saved = JSON.parse(localStorage.getItem('ck') || 'null');
    if (saved?.token) { S.email = saved.email; S.token = saved.token; await bootstrap(); }
    else show('auth');
    checkUpdate();
})();

// ---------- self-update pill (same yellow-button flow as the TV player app) ----------
// Polls couchking.app/desktop/version.json on open; a newer version shows a pill that
// opens the right installer (.exe / .dmg) in the browser — run it and you're updated.
async function checkUpdate() {
    if (ck.platform === 'web') return;   // browser version is always current
    try {
        const cur = await ck.version();
        const r = await j(`${SERVICE}/desktop/version.json`);
        if (!r?.version) return;
        const cmp = (a, b) => {
            const A = String(a).split('.').map(Number), B = String(b).split('.').map(Number);
            for (let i = 0; i < 3; i++) if ((A[i] || 0) !== (B[i] || 0)) return (A[i] || 0) - (B[i] || 0);
            return 0;
        };
        if (cmp(r.version, cur) <= 0) return;
        const url = ck.platform === 'darwin' ? r.mac : r.win;
        if (!url) return;
        // MANDATORY (AJ Sep 13, updates everywhere): below minVersion the whole app blocks
        // behind a full-screen update panel — version skew is what breaks cross-device sync
        const mandatory = r.minVersion && cmp(r.minVersion, cur) > 0;
        if (mandatory) {
            const cover = document.createElement('div');
            cover.id = 'update-block';
            cover.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(10,8,20,.97);' +
                'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;color:#fff;text-align:center';
            cover.innerHTML = `<div style="font-size:1.6rem;font-weight:800">Update required</div>
                <div style="color:#9aa">This version is out of date and can't sync correctly.<br>Update to v${r.version} to keep watching.</div>`;
            const ub = document.createElement('button');
            ub.textContent = `⬇ Update to v${r.version}`;
            ub.style.cssText = 'background:#f5c518;color:#1a1400;border:none;border-radius:999px;' +
                'padding:.6rem 1.4rem;font-weight:700;cursor:pointer;font-size:1.05rem';
            ub.onclick = () => { ck.openExternal(url); ub.textContent = '⬇ Downloading — run the installer, then reopen'; };
            cover.appendChild(ub);
            document.body.appendChild(cover);
            return;
        }
        const b = document.createElement('button');
        b.id = 'update-pill';
        b.textContent = `⬇ Update v${r.version}`;
        b.style.cssText = 'position:fixed;top:14px;right:16px;z-index:999;background:#f5c518;color:#1a1400;' +
            'border:none;border-radius:999px;padding:.45rem 1rem;font-weight:700;cursor:pointer;' +
            'box-shadow:0 2px 12px rgba(245,197,24,.4)';
        b.onclick = () => { ck.openExternal(url); b.textContent = '⬇ Downloading — run the installer'; };
        document.body.appendChild(b);
    } catch {}
}

// ---------- Discover (Stremio-style, EXACT app port): three DROPDOWNS — Type /
// Catalog (MOVIE_CATS · TV_CATS) / Genre — deep pools (12 TMDB pages, 5 Cinemeta),
// per-profile daily shuffle, rows of 15 ----------
let dType = 'movie', dCatIx = 0, dGenre = null, dLoadToken = 0;
const dCats = () => dType === 'movie' ? CK_CAT.MOVIE_CATS : CK_CAT.TV_CATS;
function discoverPickers() {
    const bar = $('discover-pickers');
    bar.innerHTML = '';
    const mk = (labelText, opts, curV, on) => {
        const l = document.createElement('label'); l.textContent = labelText;
        const s = document.createElement('select');
        for (const o of opts) { const e = document.createElement('option'); e.value = o; e.textContent = o; s.appendChild(e); }
        s.value = curV; s.onchange = () => on(s.value);
        bar.append(l, s);
    };
    mk('Type', ['Movies', 'TV Series'], dType === 'movie' ? 'Movies' : 'TV Series',
        v => { dType = v === 'TV Series' ? 'series' : 'movie'; dCatIx = 0; discover(); });
    mk('Catalog', dCats().map(c => c.label), dCats()[dCatIx].label,
        v => { dCatIx = Math.max(0, dCats().findIndex(c => c.label === v)); discover(); });
    mk('Genre', ['All genres', ...CK_CAT.GENRES.filter(g => g !== 'All')], dGenre || 'All genres',
        v => { dGenre = v === 'All genres' ? null : v; discover(); });
}
async function discover() {
    discoverPickers();
    const token = ++dLoadToken;
    const h = $('discover-rows'); h.innerHTML = '<div class="muted" style="padding:1rem 0">Loading…</div>';
    const cat = dCats()[Math.min(dCatIx, dCats().length - 1)];
    const kind = dType === 'series' ? 'tv' : 'movie';
    let items;
    if (cat.foryou) {
        items = await forYouRow(kind);
        if (!items.length) items = await tmdbRow(kind, `trending/${kind}/week`);
    } else if (cat.tmdb) {
        // deep pools + genre narrowing: discover queries filter server-side, the rest by
        // TMDB genre ids on the results
        let path = cat.tmdb;
        const gid = dGenre ? (dType === 'series' ? CK_CAT.TMDB_TV_GENRE_IDS : CK_CAT.TMDB_GENRE_IDS)[dGenre] : null;
        if (gid && path.startsWith('discover/')) path += `&with_genres=${gid}`;
        items = await tmdbRow(kind, path, 12, 400);
        if (gid && !path.includes('with_genres')) items = items.filter(t => (t.genres || []).includes(gid));
        items = profileMix(items);
    } else {
        items = profileMix(await cineRow(dType, cat.cine, dGenre, 5));
    }
    if (token !== dLoadToken) return;
    h.innerHTML = '';
    if (!items.length) { h.innerHTML = '<p class="muted" style="padding-top:1rem">Nothing here.</p>'; return; }
    // rows of 15, label on the first — same as the TV app's Discover
    for (let i = 0; i < items.length; i += 15)
        addRow(i === 0 ? `${cat.label}${dGenre ? ' · ' + dGenre : ''}` : '', items.slice(i, i + 15), null, h);
}

// ---------- Library (Stremio-style: search + type chips + sort cycle + rows) ----------
// Library = what you ADDED, nothing else. Continue Watching owns in-progress; the
// Watched/Unwatched sorts still work within your list.
let libFilter = 'All', libSort = 'Recent', libQuery = '';
const LIB_SORTS = ['Recent', 'New episodes', 'A–Z', 'Z–A', 'Watched', 'Unwatched'];
function library() {
    const body = $('library-body');
    body.innerHTML = '';
    if (S.guest) { body.innerHTML = '<p class="muted" style="padding-top:1rem">Your library lives on your account — sign in to see it.</p>'; return; }
    const input = document.createElement('input');
    input.type = 'search'; input.placeholder = 'Search your library…'; input.value = libQuery;
    body.appendChild(input);
    const controls = document.createElement('div'); controls.className = 'lib-controls';
    const gridHolder = document.createElement('div');
    body.append(controls, gridHolder);
    const render = async () => {
        const st = pstate();
        gridHolder.innerHTML = '';
        const seen = new Set();
        const all = (st.watchlist || []).filter(t => t.id && !seen.has(t.id) && seen.add(t.id));
        let list = libFilter === 'Movies' ? all.filter(t => t.type !== 'series')
            : libFilter === 'Shows' ? all.filter(t => t.type === 'series') : all;
        if (libQuery) list = list.filter(t => (t.name || '').toLowerCase().includes(libQuery.toLowerCase()));
        const watched = new Set(st.watchedIds || []);
        if (libSort === 'A–Z') list = [...list].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        else if (libSort === 'Z–A') list = [...list].sort((a, b) => (b.name || '').localeCompare(a.name || ''));
        else if (libSort === 'Watched') list = list.filter(t => watched.has(t.id));
        else if (libSort === 'Unwatched') list = list.filter(t => !watched.has(t.id));
        // Recent = natural order (most-recent adds first)
        const paint = (counts) => {
            gridHolder.innerHTML = '';
            let shown = list;
            if (libSort === 'New episodes' && counts) {
                // a real FILTER: only shows that actually have unwatched new episodes,
                // most new first — not the whole library re-sorted
                shown = list.filter(t => (counts[t.id] || 0) > 0).sort((a, b) => (counts[b.id] || 0) - (counts[a.id] || 0));
                if (!shown.length) {
                    gridHolder.innerHTML = '<p class="muted" style="padding-top:1rem">No new episodes right now — shows you track will appear here when new episodes air.</p>';
                    return;
                }
            }
            if (!shown.length) {
                gridHolder.innerHTML = `<p class="muted" style="padding-top:1rem">${!libQuery && !['Watched', 'Unwatched'].includes(libSort)
                    ? 'Your library is empty. Add titles with the + on any movie or show — they’ll live here.' : 'Nothing matches'}</p>`;
                return;
            }
            // "All" = Movies section first, Shows underneath; rows of 15 everywhere
            const rowsOf = (label, l) => {
                for (let i = 0; i < l.length; i += 15)
                    addRow(i === 0 ? label : '', l.slice(i, i + 15),
                        (t) => ({ newEps: counts ? (counts[t.id] || 0) : 0 }), gridHolder);
            };
            if (libFilter === 'All') {
                const movies = shown.filter(t => t.type !== 'series');
                const showsL = shown.filter(t => t.type === 'series');
                if (movies.length) rowsOf('Movies', movies);
                if (showsL.length) rowsOf('Shows', showsL);
            } else rowsOf(libFilter, shown);
        };
        paint(null);
        // new-episode counts land async and re-paint with badges (and power the filter)
        const counts = {};
        await Promise.all(list.filter(t => t.type === 'series').map(async t => { counts[t.id] = await newEpisodeCount(t.id); }));
        if ($('library-body') === body && (Object.values(counts).some(c => c > 0) || libSort === 'New episodes')) paint(counts);
    };
    // chips repaint IN PLACE — rebuilding stole the search cursor
    const paintControls = () => {
        controls.innerHTML = '';
        for (const f of ['All', 'Movies', 'Shows']) {
            const chip = document.createElement('button');
            chip.className = 'chip' + (f === libFilter ? ' on' : '');
            chip.textContent = f;
            chip.onclick = () => { libFilter = f; paintControls(); render(); };
            controls.appendChild(chip);
        }
        const sortChip = document.createElement('button');
        sortChip.className = 'chip sort';
        sortChip.textContent = `↕ ${libSort}`;
        sortChip.onclick = () => {
            libSort = LIB_SORTS[(LIB_SORTS.indexOf(libSort) + 1) % LIB_SORTS.length];
            sortChip.textContent = `↕ ${libSort}`; render();
        };
        controls.appendChild(sortChip);
    };
    let t = null;
    input.oninput = () => { clearTimeout(t); t = setTimeout(() => { libQuery = input.value.trim(); render(); }, 250); };
    paintControls(); render();
}

// ---------- rail ----------
document.querySelectorAll('.rail-item.nav').forEach(n => n.onclick = () => nav(n.dataset.nav));

// ---------- active profile ----------
function pstate() { return S.state.states?.[S.pid] || S.state; }
// full profile manager (switch / add / rename / avatar / delete) — same as the apps
const AVATARS = ['👤', '😀', '😎', '👑', '🐱', '🐶', '🦊', '🐼', '👻', '🤖', '🦄', '🍿'];
$('rail-profile').onclick = () => { if (!S.guest && S.token) profileManager(); };
function switchProfile(p) {
    S.pid = p.id; S.user = p.name; S.useg = `${p.name} #${String(p.id).slice(-4)}`;
    localStorage.setItem('ck-pid', p.id);
    $('prof-name').textContent = p.name; $('prof-avatar').textContent = p.avatar || '👤';
    applyAccountPrefs();
    for (const k of Object.keys(newEpCache)) delete newEpCache[k];
    home(); if (page === 'library') library();
}
function profileManager() {
    document.getElementById('prof-ov')?.remove();
    const ov = document.createElement('div'); ov.id = 'prof-ov';
    ov.style.cssText = 'position:fixed;inset:0;background:#000A;display:flex;align-items:center;justify-content:center;z-index:50';
    const card = document.createElement('div'); card.className = 'prof-card';
    ov.appendChild(card); ov.onclick = (e) => { if (e.target === ov) ov.remove(); };
    document.body.appendChild(ov);
    const listView = () => {
        const profs = S.state.profiles || [];
        card.innerHTML = '<h3>Profiles</h3>';
        for (const p of profs) {
            const row = document.createElement('div'); row.className = 'prof-row';
            const use = document.createElement('button'); use.className = (p.id === S.pid ? 'primary' : 'ghost') + ' pr-name';
            use.textContent = (p.avatar || '👤') + '  ' + p.name;
            use.onclick = () => { switchProfile(p); ov.remove(); };
            const ed = document.createElement('button'); ed.className = 'ghost small'; ed.textContent = '✎';
            ed.title = 'Edit'; ed.onclick = () => editView(p);
            row.append(use, ed);
            if (profs.length > 1) {
                const del = document.createElement('button'); del.className = 'ghost small'; del.textContent = '🗑';
                del.title = 'Delete profile';
                del.onclick = () => {
                    if (!confirm(`Delete profile "${p.name}"? Its watch history goes with it.`)) return;
                    S.state.profiles = profs.filter(x => x.id !== p.id);
                    if (S.state.states) delete S.state.states[p.id];
                    // tombstone so the delete sticks across devices (server honors it on merge)
                    S.state.profilesRemoved = { ...(S.state.profilesRemoved || {}), [p.id]: Date.now() };
                    if (S.pid === p.id) switchProfile(S.state.profiles[0]);
                    pushAccount(); listView();
                };
                row.appendChild(del);
            }
            card.appendChild(row);
        }
        if (profs.length < 3) {
            const add = document.createElement('button'); add.className = 'ghost'; add.textContent = '+ Add profile';
            add.onclick = () => editView(null);
            card.appendChild(add);
        }
    };
    const editView = (p) => {
        let avatar = p?.avatar || '👤';
        card.innerHTML = `<h3>${p ? 'Edit profile' : 'New profile'}</h3>`;
        const nameIn = document.createElement('input'); nameIn.placeholder = 'Name'; nameIn.value = p?.name || '';
        const picks = document.createElement('div'); picks.className = 'avatar-pick';
        for (const a of AVATARS) {
            const b = document.createElement('button'); b.textContent = a; b.className = a === avatar ? 'on' : '';
            b.onclick = () => { avatar = a; [...picks.children].forEach(c => c.classList.toggle('on', c.textContent === a)); };
            picks.appendChild(b);
        }
        const save = document.createElement('button'); save.className = 'primary'; save.textContent = 'Save';
        save.onclick = () => {
            const name = nameIn.value.trim(); if (!name) return;
            S.state.profiles = S.state.profiles || [];
            if (p) { p.name = name; p.avatar = avatar; if (p.id === S.pid) switchProfile(p); }
            else {
                const np = { id: 'p' + Date.now().toString(36), name, avatar };
                S.state.profiles.push(np);
                S.state.states = S.state.states || {};
                S.state.states[np.id] = {};
            }
            pushAccount(); listView();
        };
        const back = document.createElement('button'); back.className = 'ghost'; back.textContent = '‹ Back';
        back.onclick = listView;
        card.append(nameIn, picks, save, back);
    };
    listView();
}

// ---------- account write-back (server MERGES, so partial pushes are safe) ----------
async function pushAccount() {
    if (S.guest || !S.token) return;
    await j(`${SERVICE}/tvapp/state`, { method: 'POST', body: { email: S.email, token: S.token, appVer: APPVER(), state: S.state } });
}
function stamp(map, id) { const m = map || {}; m[id] = Date.now(); return m; }
// most-recent-first Continue list, cap 12 — same shape Store.pushContinue writes
function pushContinueLocal(t) {
    const st = pstate();
    st.continue = [{ id: t.id, type: t.type, name: t.name, poster: t.poster || '' },
        ...(st.continue || []).filter(x => x.id !== t.id)].slice(0, 12);
    st.addedTs = stamp(st.addedTs, t.id);
}
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

// ---------- settings — EXACT page parity with the phone/Firestick (MainActivity
// showSettings / showPlayerSettings / showShelfPicker / showAddons / showAbout) ----------
// local key ↔ account prefs key (the tvstate prefs blob every device shares)
const PREF_MAP = { autonext: 'autoplayNext', subscale: 'subScale', blur: 'blurUnwatched', titles: 'showTitles',
                   seek: 'seekStep', sublang: 'subLang', audlang: 'audioLang', subbg: 'subBg',
                   suboutline: 'subOutline', subpos: 'subPos' };
const PREF = (k, d) => JSON.parse(localStorage.getItem('ckp-' + k) ?? JSON.stringify(d));
const SETPREF = (k, v) => {
    localStorage.setItem('ckp-' + k, JSON.stringify(v));
    if (!S.guest && PREF_MAP[k]) {
        const st = pstate(); st.prefs = st.prefs || {};
        st.prefs[PREF_MAP[k]] = v;
        pushAccount();
    }
};
// account prefs win on pull (a setting flipped on the Firestick shows up here)
function applyAccountPrefs() {
    const pr = pstate().prefs || S.state.prefs;
    if (!pr) return;
    for (const [loc, acc] of Object.entries(PREF_MAP))
        if (pr[acc] !== undefined) localStorage.setItem('ckp-' + loc, JSON.stringify(pr[acc]));
}
// one settings row: label left, value right — the app's settingRow2
function settingRow(label, value, onClick) {
    const r = document.createElement('div'); r.className = 'srow';
    r.innerHTML = `<span class="srow-label">${label}</span><span class="srow-value">${value || ''}</span><span class="srow-chev">›</span>`;
    if (onClick) r.onclick = onClick; else r.classList.add('static');
    return r;
}
function sectionText(t) {
    const s = document.createElement('div'); s.className = 'ssection'; s.textContent = t;
    return s;
}
function renderSettings() {
    const body = $('settings-body');
    body.innerHTML = '';
    const h = document.createElement('h2'); h.textContent = 'Settings'; body.appendChild(h);
    // user card — avatar circle + who you are + access line (Stremio's account header)
    const card = document.createElement('div'); card.className = 'user-card';
    const statusLine = S.guest || !S.email ? 'Tap to sign in'
        : S.access?.daysLeft > 3650 ? 'Lifetime access'
        : (S.access?.expires && S.access?.daysLeft >= 0) ? `Access through ${S.access.expires} · ${S.access.daysLeft} days left`
        : 'Signed in';
    card.innerHTML = `<div class="uc-avatar">${(S.email || 'G')[0].toUpperCase()}</div>
        <div><div class="uc-email">${S.email || 'Guest'}</div><div class="uc-sub muted">${statusLine}</div></div>`;
    if (S.guest || !S.email) card.onclick = () => { localStorage.removeItem('ck'); location.reload(); };
    body.appendChild(card);
    if (!S.guest && S.email) {
        body.appendChild(settingRow('Sync library now', '', async () => {
            toast('Syncing…');
            const st = await j(`${SERVICE}/tvapp/state?e=${encodeURIComponent(S.email)}&t=${encodeURIComponent(S.token)}`);
            if (st) { S.state = st; applyAccountPrefs(); lastSyncSig = syncSig(); }
            toast('Library synced');
        }));
        body.appendChild(settingRow('Sign out', '', () => { localStorage.removeItem('ck'); location.reload(); }));
        body.appendChild(settingRow('Delete account', '', async () => {
            if (!confirm('Delete account?\n\nThis permanently deletes your account and synced library on the server.')) return;
            const r = await j(`${SERVICE}/tvapp/delete`, { method: 'POST', body: { email: S.email, token: S.token } });
            if (!r?.ok) { toast("Couldn't delete — check your connection"); return; }
            localStorage.removeItem('ck'); location.reload();
        }));
    }
    body.appendChild(sectionText('SETTINGS'));
    const st = pstate();
    const shelves = (st.shelves && st.shelves.length) ? st.shelves : CK_CAT.DEFAULT_SHELVES;
    body.appendChild(settingRow('Home screen', `${shelves.length} shelves`, () => shelfPicker()));
    body.appendChild(settingRow('Blur unwatched episode images', PREF('blur', false) ? 'On' : 'Off',
        () => { SETPREF('blur', !PREF('blur', false)); renderSettings(); }));
    body.appendChild(settingRow('Show titles under posters', PREF('titles', true) ? 'On' : 'Off',
        () => { SETPREF('titles', !PREF('titles', true)); renderSettings(); }));
    // Player settings only exist when there's something to PLAY
    if (hasService()) body.appendChild(settingRow('Player', '', () => playerSettings()));
    body.appendChild(settingRow('Addons',
        S.guest ? 'sign in to add' : `${S.addons.length} added`, () => addonsPage()));
    body.appendChild(settingRow('Legal & About', '', () => aboutPage()));
}
function settingsSub(title, build) {
    const body = $('settings-body');
    body.innerHTML = '';
    const back = document.createElement('button'); back.className = 'ghost small'; back.textContent = '‹ Back';
    back.onclick = () => renderSettings();
    body.appendChild(back);
    const h = document.createElement('h2'); h.textContent = title; body.appendChild(h);
    build(body);
}
/** Player page (subtitles / audio / playback) — same rows as the Firestick's. */
function playerSettings() {
    settingsSub('Player', (body) => {
        body.appendChild(sectionText('SUBTITLES'));
        // live sample: shows exactly what the options below produce
        const sample = document.createElement('div'); sample.className = 'sub-sample';
        const paintSample = () => {
            const scale = PREF('subscale', 1.0);
            sample.innerHTML = `<span style="font-size:${(15 * scale).toFixed(1)}px;
                ${PREF('suboutline', true) ? 'text-shadow:0 0 5px #000,1px 1px 2px #000;' : ''}
                ${PREF('subbg', false) ? 'background:#000000B3;padding:2px 8px;' : ''}
                margin-bottom:${({ 0: 10, 1: 26, 2: 46 })[PREF('subpos', 0)] || 10}px">This is what subtitles will look like</span>`;
        };
        paintSample();
        body.appendChild(sample);
        const sizes = [['Small', 0.8], ['Normal', 1.0], ['Large', 1.3], ['Huge', 1.6]];
        const rebuild = () => playerSettings();
        const curSize = sizes.find(x => Math.abs(x[1] - PREF('subscale', 1.0)) < .01) || sizes[1];
        body.appendChild(settingRow('Subtitle size', curSize[0], () => {
            const next = sizes[(sizes.indexOf(curSize) + 1) % sizes.length];
            SETPREF('subscale', next[1]); rebuild();
        }));
        // AJ Sep 11: English or Off, nothing else — bg/outline/position/audio ride good
        // defaults (outline on, no box, normal pos, English audio server-gated).
        body.appendChild(settingRow('Subtitles', PREF('sublang', 'en') === 'off' ? 'Off' : 'English', () => {
            SETPREF('sublang', PREF('sublang', 'en') === 'en' ? 'off' : 'en'); rebuild();
        }));
        body.appendChild(sectionText('PLAYBACK'));
        body.appendChild(settingRow('Autoplay next episode', PREF('autonext', true) ? 'On' : 'Off', () => {
            SETPREF('autonext', !PREF('autonext', true)); rebuild();
        }));
        body.appendChild(settingRow('Seek step', `${PREF('seek', 10)}s`, () => {
            const steps = [5, 10, 15, 30];
            SETPREF('seek', steps[(steps.indexOf(PREF('seek', 10)) + 1) % steps.length]); rebuild();
        }));
    });
}
/** Home-shelf picker: grouped sections of pill chips that flip IN PLACE. */
function shelfPicker() {
    settingsSub('Home shelves', (body) => {
        const note = document.createElement('p'); note.className = 'muted';
        note.textContent = 'Click to turn rows on or off — Home updates the moment you go back. For You is always on.';
        body.appendChild(note);
        const st = pstate();
        const enabled = new Set((st.shelves && st.shelves.length) ? st.shelves : CK_CAT.DEFAULT_SHELVES);
        const persist = () => {
            st.shelves = CK_CAT.SHELF_CATALOG.map(r => r.label).filter(l => enabled.has(l));
            pushAccount();
        };
        const G = CK_CAT.SHELF_GROUPS;
        const inG = (label, g) => G[g].includes(label);
        const section = (title, rows) => {
            if (!rows.length) return;
            body.appendChild(sectionText(title));
            const wrap = document.createElement('div'); wrap.className = 'chip-grid';
            for (const r of rows) {
                const chip = document.createElement('button');
                const paint = () => { chip.className = 'chip shelf' + (enabled.has(r.label) ? ' on' : ''); };
                chip.textContent = r.label;
                chip.onclick = () => { enabled.has(r.label) ? enabled.delete(r.label) : enabled.add(r.label); persist(); paint(); };
                paint();
                wrap.appendChild(chip);
            }
            body.appendChild(wrap);
        };
        const all = CK_CAT.SHELF_CATALOG;
        section('POPULAR & NEW', all.filter(r => !inG(r.label, 'providers') && !inG(r.label, 'channels') && !inG(r.label, 'genres') && !inG(r.label, 'moods')));
        section('MOODS & SEASONS', all.filter(r => inG(r.label, 'moods')));
        section('STREAMING SERVICES', all.filter(r => inG(r.label, 'providers')));
        section('CHANNELS & ANIME', all.filter(r => inG(r.label, 'channels')));
        section('GENRES', all.filter(r => inG(r.label, 'genres')));
    });
}
function addonsPage() {
    settingsSub('Addons', (body) => {
        if (S.guest) {
            const p = document.createElement('p'); p.className = 'muted';
            p.textContent = 'Sign in to add addons and start streaming.';
            body.appendChild(p);
            const b = document.createElement('button'); b.className = 'primary'; b.textContent = 'Sign in';
            b.onclick = () => { localStorage.removeItem('ck'); location.reload(); };
            body.appendChild(b);
            return;
        }
        // official built-ins (AJ Sep 13: "I don't see OpenSubtitles or Cinemeta under
        // official addons") — these power every install and can't be removed, same as
        // Stremio lists its preinstalled pair
        body.appendChild(sectionText('OFFICIAL — BUILT IN'));
        body.appendChild(settingRow('Cinemeta', 'Movie & show info · built in', null));
        body.appendChild(settingRow('OpenSubtitles v3', 'Subtitles · built in', null));
        body.appendChild(sectionText('YOUR ADDONS'));
        if (!S.addons.length) {
            const p = document.createElement('p'); p.className = 'muted';
            p.textContent = 'No addons yet — the addon assigned to your account installs automatically once you’re enabled, or add one below.';
            body.appendChild(p);
        }
        // add/remove parity with the Firestick/mobile app (AJ Sep 13: "can't add addons on
        // there — I want them the same"). The list lives in the synced account state, so an
        // addon added here appears on every signed-in device.
        S.addons.forEach((a, ix) => {
            const row = settingRow(a.name || 'Addon', ix === 0 ? 'Connected · primary' : 'Remove', ix === 0 ? null : () => {
                S.addons.splice(ix, 1);
                const st = pstate(); st.addons = S.addons; pushAccount();
                addonsPage();
            });
            body.appendChild(row);
        });
        body.appendChild(sectionText('ADD AN ADDON'));
        const wrap = document.createElement('div'); wrap.style.cssText = 'display:flex;gap:.5rem;max-width:560px';
        const inp = document.createElement('input'); inp.placeholder = 'Addon or manifest URL…';
        inp.style.cssText = 'flex:1';
        const btn = document.createElement('button'); btn.className = 'primary'; btn.textContent = 'Add';
        btn.onclick = async () => {
            let u = inp.value.trim(); if (!u) return;
            if (!/^https?:\/\//.test(u)) u = 'https://' + u;
            u = u.replace(/\/manifest\.json$/, '').replace(/\/$/, '');
            btn.textContent = 'Checking…';
            const man = await j(`${u}/manifest.json`, { timeoutMs: 10000 });
            btn.textContent = 'Add';
            if (!man?.id) { inp.value = ''; inp.placeholder = 'That URL has no addon manifest — check it'; return; }
            if (S.addons.some(x => x.url === u)) { inp.value = ''; inp.placeholder = 'Already added'; return; }
            S.addons.push({ url: u, name: man.name || 'Addon' });
            const st = pstate(); st.addons = S.addons; pushAccount();
            addonsPage();
        };
        wrap.append(inp, btn); body.appendChild(wrap);
    });
}
function aboutPage() {
    settingsSub('Legal & About', async (body) => {
        body.appendChild(settingRow('Terms & Conditions', '', () => ck.openExternal('https://couchking.app/terms')));
        body.appendChild(settingRow('Privacy Policy', '', () => ck.openExternal('https://couchking.app/privacy')));
        const vRow = settingRow('Version', ck.platform === 'web' ? 'web' : '…', null);
        body.appendChild(vRow);
        if (ck.platform !== 'web') vRow.querySelector('.srow-value').textContent = await ck.version();
    });
}
