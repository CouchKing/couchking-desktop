// CouchKing renderer — one codebase for the desktop app (Electron + mpv) AND the
// web version at couchking.app/app (ck-web.js shim + HTML5 player). Same account
// endpoints as the TV app; everything syncs through /tvapp/state + /player/progress.
const TMDB = 'b05e998c589bf1393c1059bd1d4c5895';
const CINE = 'https://v3-cinemeta.strem.io';
let SERVICE = 'https://couchking.app';
let S = { email: '', token: '', user: '', subKey: '', addons: [], state: {}, guest: false };
const APPVER = () => (ck.platform === 'web' ? 'web' : 'desktop') + '-0.7';
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
    S.guest = true; S.email = ''; S.token = ''; S.state = {}; S.addons = []; S.user = 'Guest';
    $('prof-name').textContent = 'Guest'; $('prof-avatar').textContent = '👤';
    $('set-email').textContent = 'Guest — sign out to create an account';
    $('set-service').textContent = 'None (guest)';
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
    $('prof-avatar').textContent = prof?.avatar || '👤';
    $('set-email').textContent = S.email;
    $('set-service').textContent = S.subKey ? 'Connected (' + S.subKey.slice(0, 8) + '…)' : 'None on this account';
    applyAccountPrefs();
    lastSyncSig = syncSig();
    show('main'); home();
}

// live sync like the phone/Firestick: re-pull account state every 60s so what you watch
// on other devices shows up here without a restart. QUIET: only re-render when the data
// actually changed AND you're parked at the top of Home — never yank the page around.
let lastSyncSig = '';
function syncSig() {
    const p = pstate();
    return JSON.stringify([p.continue, p.cwlast, p.positions, p.watchlist, p.watchedIds, p.prefs]);
}
setInterval(async () => {
    if (S.guest || !S.token || playing) return;
    const st = await j(`${SERVICE}/tvapp/state?e=${encodeURIComponent(S.email)}&t=${encodeURIComponent(S.token)}`);
    if (!st) return;
    S.state = st; applyAccountPrefs();
    const sig = syncSig();
    if (sig === lastSyncSig) return;
    lastSyncSig = sig;
    if (page === 'home' && $('content').scrollTop < 60) home();
}, 60000);

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

// ---------- posters / rows ----------
const IMG = (p, w = 342) => p ? (p.startsWith('http') ? p : `https://image.tmdb.org/t/p/w${w}${p}`) : '';
// tile = EXACT Firestick card: white bar on a dark track flush at the poster's bottom
// (only 2–97%), purple ✓ top-right = My List, yellow eye top-left = watched, single-line
// centered title below
function posterEl(t, opts = {}) {
    const d = document.createElement('div'); d.className = 'poster';
    const st = pstate();
    const hasBar = opts.pct >= 2 && opts.pct <= 97;
    const inList = (st.watchlist || []).some(x => x.id === t.id);
    const isDone = (st.watchedIds || []).includes(t.id);
    d.innerHTML = `<div class="pwrap"><img loading="lazy" src="${t.poster || ''}">`
        + (opts.chip ? `<div class="ep-chip">${opts.chip}</div>` : '')
        + (opts.removable ? `<div class="cw-x" title="Remove from Continue Watching">✕</div>` : '')
        + (inList ? '<div class="badge-list">✓</div>' : '')
        + (isDone && !opts.removable ? '<div class="badge-done">👁</div>' : '')
        + (hasBar ? `<div class="bar"><div style="width:${opts.pct}%"></div></div>` : '')
        + `</div>`
        + (PREF('titles', true) ? `<div class="pt">${t.name || ''}</div>` : '');
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
}
function addRow(label, items, opts, holder) {
    if (!items?.length) return;
    const rows = holder || document.querySelector('#view-home .rows');
    if (label) { const l = document.createElement('div'); l.className = 'row-label'; l.textContent = label; rows.appendChild(l); }
    const s = document.createElement('div'); s.className = 'strip';
    for (const t of items) s.appendChild(posterEl(t, typeof opts === 'function' ? opts(t) : (opts || {})));
    rows.appendChild(s);
}
async function tmdbRow(kind, path, pages = 3) {
    const reqs = [];
    for (let p = 1; p <= pages; p++)
        reqs.push(j(`https://api.themoviedb.org/3/${path}${path.includes('?') ? '&' : '?'}api_key=${TMDB}&page=${p}`));
    const seen = new Set(); const out = [];
    for (const d of await Promise.all(reqs))
        for (const r of (d?.results || [])) {
            if (seen.has(r.id)) continue; seen.add(r.id);
            out.push({ tmdb: r.id, type: kind === 'tv' ? 'series' : 'movie', name: r.title || r.name,
                       poster: IMG(r.poster_path), backdrop: IMG(r.backdrop_path, 1280) });
        }
    return out.slice(0, 60);
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
    return out.slice(0, 60);
}
async function idsRow(type, ids) {
    const metas = await Promise.all(ids.map(id =>
        j(`${CINE}/meta/movie/${id}.json`).then(d => d?.meta || j(`${CINE}/meta/series/${id}.json`).then(x => x?.meta))));
    const out = [];
    for (const m of metas) if (m) out.push({ id: m.id, type: m.type || type, name: m.name, poster: m.poster });
    return out;
}
async function rowItems(r) {
    if (r.ids) return idsRow(r.type, r.ids);
    if (r.tmdb) return tmdbRow(r.type === 'series' ? 'tv' : 'movie', r.tmdb);
    return cineRow(r.type, r.cine, r.genre, 2);
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
async function hero(st) {
    const h = $('hero'); h.classList.add('hidden'); h.innerHTML = '';
    let t = (st.continue || [])[0];
    let sub = '', bg = '';
    if (t) {
        const meta = (await j(`${CINE}/meta/${t.type}/${t.id}.json`))?.meta;
        bg = meta?.background || '';
        sub = t.type === 'series' && cwChip(st, t) ? `Continue watching · ${cwChip(st, t)}` : 'Continue watching';
    } else {
        const tr = await tmdbRow('tv', 'trending/tv/week', 1);
        t = tr[0]; bg = t?.backdrop || ''; sub = 'Trending this week';
        if (t) { const f = await j(`https://api.themoviedb.org/3/tv/${t.tmdb}/external_ids?api_key=${TMDB}`); if (f?.imdb_id) t.id = f.imdb_id; }
    }
    if (!t || !bg) return;
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
        const last = (pstate().cwlast || {})[t.id];
        if (t.type === 'series' && last?.includes(':')) {
            const [, s, ep] = last.split(':');
            detail(t).then(() => pickStream(last, `${t.name} S${s}E${ep}`, true));
        } else detail(t).then(() => t.type === 'movie' && pickStream(t.id, t.name, true));
    };
}
async function home() {
    const rows = document.querySelector('#view-home .rows');
    rows.innerHTML = '';
    const st = pstate();
    hero(st);
    addRow('Continue Watching', (st.continue || []).map(t => ({ ...t })),
        (t) => ({ pct: pctOf(st, t), chip: cwChip(st, t), removable: !S.guest }));
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
          <button class="ghost" id="d-list"></button>
          <button class="ghost" id="d-watched"></button>
        </div>
        <div id="d-wtw" class="wtw"></div>
        </div></div>
        <div id="d-eps"></div><div id="d-streams" class="streams"></div>`;
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
            el.onclick = () => aired && hasService() && pickStream(key, `${meta.name} S${e.season}E${e.episode}`);
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
}

// per-episode watched toggle (eye button — same as the phone/Firestick)
function toggleEpWatched(key) {
    const st = pstate(); st.watchedIds = st.watchedIds || [];
    const i = st.watchedIds.indexOf(key);
    if (i >= 0) { st.watchedIds.splice(i, 1); st.removedTs = stamp(st.removedTs, key); }
    else { st.watchedIds.push(key); st.addedTs = stamp(st.addedTs, key); }
    pushAccount();
}

// ---------- streams + play ----------
async function pickStream(sid, label, autoFirst = false) {
    if (!hasService()) return;   // tracker shell: no stream fetches without a service
    const holder = $('d-streams');
    holder.innerHTML = '<div class="muted">Finding streams…</div>';
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
    if (ck.platform !== 'web') {
        $('playing-title').textContent = label;
        $('playing').classList.remove('hidden');
    }
    await ck.play({ url, title: label, startSec, sid,
        subScale: PREF('subscale', 1.0), subLang: PREF('sublang', 'en'), audioLang: PREF('audlang', 'en'),
        subBg: PREF('subbg', false), subOutline: PREF('suboutline', true), subPos: PREF('subpos', 0),
        seekStep: PREF('seek', 10) });
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
    // finished an episode → mark it watched (checkmark + blur-clear sync to every device)
    if (p.s && pos / dur >= 0.92 && !S.guest) {
        const st = pstate(); st.watchedIds = st.watchedIds || [];
        const key = `${p.imdb}:${p.s}:${p.e}`;
        if (!st.watchedIds.includes(key)) { st.watchedIds.push(key); pushAccount(); }
    }
    S.state = await j(`${SERVICE}/tvapp/state?e=${encodeURIComponent(S.email)}&t=${encodeURIComponent(S.token)}`) || S.state;
    if (page === 'home') home();
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
$('auth-guest').onclick = () => guest();
$('back').onclick = () => { nav('home'); };
$('signout').onclick = () => { localStorage.removeItem('ck'); location.reload(); };

(async () => {
    SERVICE = await ck.service();
    const saved = JSON.parse(localStorage.getItem('ck') || 'null');
    if (saved?.token) { S.email = saved.email; S.token = saved.token; await bootstrap(); }
    else show('auth');
    $('set-version').textContent = ck.platform === 'web' ? 'CouchKing Web' : 'CouchKing Desktop ' + await ck.version();
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

// ---------- discover (Type / Category / Genre as real dropdown menus, like the apps) ----------
let dType = 'movie', dCat = 'Popular', dGenre = 'All';
function discoverPickers() {
    const bar = $('discover-pickers');
    if (bar.childElementCount) return;
    const mk = (labelText, opts, cur, on) => {
        const l = document.createElement('label'); l.textContent = labelText;
        const s = document.createElement('select');
        for (const o of opts) { const e = document.createElement('option'); e.value = o; e.textContent = o; s.appendChild(e); }
        s.value = cur; s.onchange = () => on(s.value);
        bar.append(l, s);
    };
    mk('Type', ['Movies', 'Series'], 'Movies', v => { dType = v === 'Series' ? 'series' : 'movie'; discover(); });
    mk('Category', CK_CAT.DISCOVER_CATS.map(c => c.label), dCat, v => { dCat = v; discover(); });
    mk('Genre', CK_CAT.GENRES, dGenre, v => { dGenre = v; discover(); });
}
async function discover() {
    discoverPickers();
    const h = $('discover-rows'); h.innerHTML = '<div class="muted" style="padding:1rem 0">Loading…</div>';
    const cat = CK_CAT.DISCOVER_CATS.find(c => c.label === dCat)[dType];
    let items;
    if (dGenre !== 'All') {
        const ids = dType === 'series' ? CK_CAT.TMDB_TV_GENRE_IDS : CK_CAT.TMDB_GENRE_IDS;
        const gid = ids[dGenre];
        items = gid ? await tmdbRow(dType === 'series' ? 'tv' : 'movie',
            `discover/${dType === 'series' ? 'tv' : 'movie'}?sort_by=popularity.desc&vote_count.gte=40&with_genres=${gid}`, 6)
            : await cineRow(dType, 'top', dGenre, 3);
    } else if (cat.tmdb) items = await tmdbRow(dType === 'series' ? 'tv' : 'movie', cat.tmdb, 6);
    else items = await cineRow(dType, cat.cine, null, 3);
    h.innerHTML = '';
    // grid rows of 15 like the TV app's Discover
    for (let i = 0; i < items.length; i += 15)
        addRow(i === 0 ? `${dCat}${dGenre !== 'All' ? ' · ' + dGenre : ''}` : '', items.slice(i, i + 15), null, h);
}

// ---------- library ----------
let libType = 'All', libSort = 'Recent';
function library() {
    const h = $('library-rows'); h.innerHTML = '';
    if (S.guest) { h.innerHTML = '<p class="muted" style="padding-top:1rem">Your library lives on your account — sign in to see it.</p>'; return; }
    const st = pstate();
    const bar = document.createElement('div'); bar.className = 'pickers';
    const mk = (labelText, opts, cur, on) => {
        const l = document.createElement('label'); l.textContent = labelText;
        const s = document.createElement('select');
        for (const o of opts) { const e = document.createElement('option'); e.value = o; e.textContent = o; s.appendChild(e); }
        s.value = cur; s.onchange = () => on(s.value);
        bar.append(l, s);
    };
    mk('Show', ['All', 'Movies', 'Shows'], libType, v => { libType = v; library(); });
    mk('Sort', ['Recent', 'A-Z'], libSort, v => { libSort = v; library(); });
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
// full profile manager (switch / add / rename / avatar / delete) — same as the apps
const AVATARS = ['👤', '😀', '😎', '👑', '🐱', '🐶', '🦊', '🐼', '👻', '🤖', '🦄', '🍿'];
$('rail-profile').onclick = () => { if (!S.guest && S.token) profileManager(); };
function switchProfile(p) {
    S.pid = p.id; S.user = p.name; localStorage.setItem('ck-pid', p.id);
    $('prof-name').textContent = p.name; $('prof-avatar').textContent = p.avatar || '👤';
    applyAccountPrefs();
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

// ---------- settings — SAME set as the phone/Firestick, synced through the account ----------
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
function renderSettings() {
    const holder = $('settings-extra'); if (!holder) return;
    holder.innerHTML = '';
    const rows = [
        ['Autoplay next episode', 'autonext', true],
        ['Show titles under posters', 'titles', true],
        ['Blur unwatched episode thumbnails', 'blur', false],
        ['Subtitle size', 'subscale', 1.0, [['Small', .8], ['Normal', 1.0], ['Large', 1.3], ['Giant', 1.7]]],
        ['Subtitle language', 'sublang', 'en', [['English', 'en'], ['Spanish', 'es'], ['French', 'fr'], ['German', 'de'], ['Portuguese', 'pt']]],
        ['Audio language', 'audlang', 'en', [['English', 'en'], ['Spanish', 'es'], ['French', 'fr'], ['German', 'de'], ['Japanese', 'ja']]],
        ['Subtitle background', 'subbg', false],
        ['Subtitle outline', 'suboutline', true],
        ['Subtitle position', 'subpos', 0, [['Normal', 0], ['Raised', 1], ['High', 2]]],
        ['Skip step', 'seek', 10, [['5s', 5], ['10s', 10], ['30s', 30]]],
    ];
    for (const [label, key, dflt, opts] of rows) {
        const card = document.createElement('div'); card.className = 'set-card';
        const cur = PREF(key, dflt);
        card.innerHTML = `<b>${label}</b>`;
        if (!opts) {
            const b = document.createElement('button'); b.className = cur ? 'primary small' : 'ghost small';
            b.textContent = cur ? 'On' : 'Off';
            b.onclick = () => { SETPREF(key, !PREF(key, dflt)); renderSettings(); };
            card.appendChild(b);
        } else {
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
