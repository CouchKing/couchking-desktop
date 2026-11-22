// CouchKing GUIDE V2 for web — a port of the Android TV canvas guide (couchking-tv
// GuideCanvas.kt, Nov 7 "guidev2"). ONE <canvas> paints the whole EPG from two camera
// values (scrollY px, shift px) plus a cursor that is pure state — no DOM rows, no
// scroll containers, so panning 600+ channels is a single repaint. Mouse wheel/drag and
// touch drag pan both axes, click/tap = tune, right-click / long-press / F = ★ favorite,
// arrow keys walk the grid with the AOSP "travel axis" (↑/↓ keeps the TIME you were
// browsing). Standalone IIFE, zero deps, zero edits to app.js — mount it anywhere:
//
//   const g = CKGuide2.mount(el, {
//       guideUrl: '/live/CKG-…/guide.json?p=…',   // or data: <already-fetched guide.json>
//       gamesUrl: '/live/CKG-…/games.json',       // optional: 🔴 live-sports sections on top
//       epgDescUrl: id => '/live/CKG-…/epgdesc.json?ch=' + encodeURIComponent(id), // optional
//       accent: '#7B5BF5',
//       onTune: (cid, name, logo, nowTitle) => {},   // cid = 'cklive:<id>' like the apps
//       onFavorite: (cid, on) => {},                 // bare channel id, true = starred
//   });
//   g.refresh(newData) / g.setAccent(hex) / g.unmount()  (also CKGuide2.unmount(el))
(function () {
'use strict';

// ---- palette: verbatim from GuideCanvas.kt (Nov 7 restyle) ----
const BG = '#0C0B14', CELL = '#1C202B', CELL_PAST = '#15181F', CELL_LINE = '#2A2F3B';
const CHCOL_BG = '#13101F', FG = '#FFFFFF', DIM = '#A9A5C0', PAST_TXT = '#6F6A85';
const SEC = '#A08EF0', SEC_BG = '#1B1636', NOW_LINE = '#E94B6A', RED = '#E64545';
const TIME_TXT = '#8E88AA', STAR_ON = '#F5C542';
const FONTS = `-apple-system,'Segoe UI',Roboto,sans-serif`;

const hexRgb = (h) => {
    const s = String(h || '').replace('#', '');
    const v = s.length === 3 ? s.split('').map(c => c + c).join('') : s;
    const n = parseInt(v, 16);
    return isNaN(n) ? [123, 91, 245] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const blend = (a, b, f) => {   // ColorUtils.blendARGB equivalent
    const A = hexRgb(a), B = hexRgb(b);
    return `rgb(${Math.round(A[0] + (B[0] - A[0]) * f)},${Math.round(A[1] + (B[1] - A[1]) * f)},${Math.round(A[2] + (B[2] - A[2]) * f)})`;
};

// event-feed channel names carry provider junk — port of ckCleanChannelName (AJ Nov 7
// "name it properly please"): "UFC: UFC Fight Night : English 2026-11-07 22:00" → "UFC Fight Night"
function cleanName(n) {
    return String(n || '')
        .replace(/\s*[:\-–]?\s*\(?English\)?(?=\s|$)/gi, ' ')
        .replace(/\(?\d{4}-\d{2}-\d{2}[ T]?[\d:]*\)?/g, '')
        .replace(/^\(\d+\)\s*/, '')
        .replace(/^(UFC|NFL|NBA|MLB|NHL|NCAAF?B?\s*\d*|BOXING\s*\d*)\s*:\s*/i, '')
        .replace(/\s{2,}/g, ' ').trim().replace(/[:\-–]+$/, '').trim();
}

const fmtT = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const fmtD = (ms) => new Date(ms).toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });

function ellipsize(ctx, s, maxW) {
    if (maxW <= 0) return '';
    if (ctx.measureText(s).width <= maxW) return s;
    let lo = 0, hi = s.length;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (ctx.measureText(s.slice(0, mid) + '…').width <= maxW) lo = mid; else hi = mid - 1;
    }
    return lo < 1 ? '' : s.slice(0, lo) + '…';
}

// chrome styles injected once — the guide ships no .css file and touches none
const CSS = `
.ckg2{display:flex;flex-direction:column;background:${BG};color:${FG};font-family:${FONTS};
  border-radius:12px;overflow:hidden;outline:none;min-height:320px}
.ckg2-tabs{display:flex;gap:8px;align-items:center;padding:8px 10px 6px;flex:none}
.ckg2-tab{background:${CELL};color:${DIM};border:1px solid ${CELL_LINE};border-radius:16px;
  padding:5px 14px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit}
.ckg2-tab.on{background:var(--ckg2-accent,#7B5BF5);color:#fff;border-color:transparent}
.ckg2-now{margin-left:auto}
.ckg2-det{display:flex;align-items:center;gap:10px;padding:4px 12px 8px;min-height:58px;flex:none}
.ckg2-det img{width:26px;height:26px;object-fit:contain;flex:none}
.ckg2-det-mid{min-width:0;flex:1}
.ckg2-det-ch{color:${DIM};font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  display:flex;align-items:center;gap:10px}
.ckg2-det-bar{width:150px;height:3px;background:#241F3D;flex:none;border-radius:2px;overflow:hidden}
.ckg2-det-bar>div{height:100%;background:var(--ckg2-accent,#7B5BF5)}
.ckg2-det-t{font-size:17px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-top:2px}
.ckg2-det-d{color:${DIM};font-size:12px;max-height:2.6em;overflow:hidden;padding-top:2px}
.ckg2-cv{flex:1;min-height:0;display:block;width:100%;height:100%;cursor:default;touch-action:none}
.ckg2-cvwrap{flex:1;min-height:0;position:relative}
.ckg2-legend{color:#6F6895;font-size:11px;padding:5px 12px 8px;flex:none;white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis}
@media(max-width:700px){.ckg2-legend{display:none}.ckg2-det-bar{width:90px}.ckg2-det-t{font-size:15px}}
`;
function injectCss() {
    if (document.getElementById('ckg2-css')) return;
    const st = document.createElement('style');
    st.id = 'ckg2-css'; st.textContent = CSS;
    document.head.appendChild(st);
}

const HALF = 1800e3, DAY = 86400e3;

function Guide2(root, opts) {
    this.root = root;
    this.opts = opts || {};
    this.accent = this.opts.accent || '#7B5BF5';
    this.data = this.opts.data || null;
    this.games = null;
    this.day = 0;
    this.alive = true;

    // model
    this.rows = [];            // { header } | { ch:{id,name,logo,fav,progs:[{s,e,t}]} }
    this.redRow = [];
    this.rowY = [0];
    this.contentH = 0;
    this.dayStart = 0; this.winEnd = 0; this.timelinePx = 0;

    // cursor (pure state) + camera — the whole point of the port
    this.curRow = -1; this.curEntry = 0; this.inChannelCol = true;
    this.travelMs = -1;        // ↑/↓ keeps you at this time, not each entry's start (AOSP)
    this.shiftPx = 0; this.scrollY = 0;
    this.cursorChannel = null;
    this.hover = null;         // {row, entry, inCh} from the mouse — separate from the cursor
    this.favFlips = new Set(); // ★ toggled this session; data.favs is a snapshot
    this.logos = new Map();    // id → HTMLImageElement | null(failed/loading)
    this.descCache = new Map();
    this._descTimer = 0; this._detKey = '';
    this._raf = 0;

    this._buildDom();
    this._metrics();
    this._bind();
    this._load();

    // now-line / live-tint / detail progress ride the clock — one 30s tick (spec: "single 30s now tick")
    this._tick = setInterval(() => { if (this.alive) { this.invalidate(); this._notifyCursor(true); } }, 30e3);
}

Guide2.prototype = {

_buildDom() {
    injectCss();
    const r = this.root;
    r.classList.add('ckg2');
    r.tabIndex = 0;
    r.style.setProperty('--ckg2-accent', this.accent);
    r.innerHTML = '';
    const now = Date.now();
    const tabs = document.createElement('div'); tabs.className = 'ckg2-tabs';
    // 4 day tabs like the current web guide (server ships 96h)
    for (let o = 0; o < 4; o++) {
        const b = document.createElement('button');
        b.className = 'ckg2-tab' + (o === this.day ? ' on' : '');
        b.textContent = o === 0 ? 'Today' : o === 1 ? 'Tomorrow'
            : new Date(now + o * DAY).toLocaleDateString('en-US', { weekday: 'long' });
        b.onclick = () => this._setDay(o);
        tabs.appendChild(b);
    }
    const nb = document.createElement('button');
    nb.className = 'ckg2-tab ckg2-now'; nb.textContent = '⦿ Now';
    nb.onclick = () => { if (this.day !== 0) this._setDay(0); this.snapToNow(); };
    tabs.appendChild(nb);
    this.tabsEl = tabs;

    const det = document.createElement('div'); det.className = 'ckg2-det';
    det.innerHTML = `<img alt="" style="display:none"><div class="ckg2-det-mid">
        <div class="ckg2-det-ch"><span class="ckg2-det-nm"></span><div class="ckg2-det-bar" style="display:none"><div></div></div></div>
        <div class="ckg2-det-t"></div><div class="ckg2-det-d"></div></div>`;
    this.det = {
        logo: det.querySelector('img'), nm: det.querySelector('.ckg2-det-nm'),
        bar: det.querySelector('.ckg2-det-bar'), fill: det.querySelector('.ckg2-det-bar>div'),
        title: det.querySelector('.ckg2-det-t'), desc: det.querySelector('.ckg2-det-d'),
    };
    this.det.logo.onerror = () => { this.det.logo.style.display = 'none'; };   // never a broken-img hole

    const wrap = document.createElement('div'); wrap.className = 'ckg2-cvwrap';
    this.cv = document.createElement('canvas'); this.cv.className = 'ckg2-cv';
    wrap.appendChild(this.cv);
    this.ctx = this.cv.getContext('2d');

    const legend = document.createElement('div'); legend.className = 'ckg2-legend';
    legend.textContent = '▲ ▼  channels      ◀ ▶  programs      Enter  watch      F / right-click  ★ favorite      drag or scroll to pan';

    r.append(tabs, det, wrap, legend);
},

_metrics() {
    const w = this.root.clientWidth || 800;
    const mob = w < 700;
    this.pxPerMin = mob ? 3 : 4;
    this.rowH = mob ? 48 : 56;
    this.hdrRowH = 26;
    this.chColW = mob ? 118 : 168;   // +18px vs Android: the ★ hitzone lives in the cell
    this.rulerH = 28;
    this.rowGap = 2;
},

// ---------- data ----------
async _load() {
    const o = this.opts;
    try {
        if (!this.data && o.guideUrl) {
            const r = await fetch(o.guideUrl, { credentials: 'same-origin' });
            this.data = await r.json();
        }
    } catch {}
    if (!this.alive) return;
    if (!this.data || !(this.data.channels || []).length) {
        // addon mid-restart / first boot — retry, never dead-end (same rule as lvRenderGuide)
        this.invalidate();
        this._retry = setTimeout(() => { if (this.alive) { this.data = null; this._load(); } }, 4000);
        return;
    }
    this._build();
    this.snapToNow(true);
    // 🔴 live-sports sections merged on top when the fetch lands; submit keeps the cursor put
    if (o.gamesUrl && !this.games) {
        fetch(o.gamesUrl, { credentials: 'same-origin' }).then(r => r.json()).then(g => {
            if (!this.alive || !g || !Array.isArray(g.sports)) return;
            this.games = g; this._build();
        }).catch(() => {});
    }
},

refresh(data) { if (data) { this.data = data; this.favFlips.clear(); this._build(); } },
setAccent(hex) {
    this.accent = hex || '#7B5BF5';
    this.root.style.setProperty('--ckg2-accent', this.accent);
    this.invalidate();
},

_setDay(o) {
    this.day = o;
    this.tabsEl.querySelectorAll('.ckg2-tab').forEach((b, i) => b.classList.toggle('on', i === o));
    this.shiftPx = 0; this.travelMs = -1;
    this._build();
    if (o === 0) this.snapToNow(true);
},

// rows from guide.json: [🔴 live games (today only)] → ★ Favorites → sections —
// identical ordering to PlayerActivity.showFullGuide
_build(keepRowIndex) {
    const d = this.data; if (!d || !Array.isArray(d.channels)) return;
    const now = Date.now();
    if (this.day === 0) this.dayStart = now - (now % HALF);
    else { const dt = new Date(now + this.day * DAY); dt.setHours(6, 0, 0, 0); this.dayStart = dt.getTime(); }
    this.winEnd = this.dayStart + 24 * 3600e3;
    this.timelinePx = Math.round((this.winEnd - this.dayStart) / 60e3) * this.pxPerMin;

    const favs = new Set(d.favs || []);
    const chOf = (c) => ({
        id: String(c.id), name: cleanName(c.name) || String(c.id), logo: c.logo || '',
        fav: favs.has(c.id),
        progs: (c.progs || []).filter(p => p && +p.e > this.dayStart && +p.s < this.winEnd)
            .map(p => ({ s: +p.s, e: +p.e, t: p.t || '' })),
    });
    const rows = [];
    if (this.day === 0 && this.games) {
        const byId = new Map(d.channels.map(c => [String(c.id), c]));
        const seen = new Set();
        for (const sp of (this.games.sports || [])) {
            const sec = [];
            for (const g of (sp.live || [])) {
                const cid = String(g.chid || '').replace(/^cklive:/, '');
                const c = byId.get(cid);
                if (!c || seen.has(cid)) continue;
                seen.add(cid); sec.push({ ch: chOf(c) });
            }
            if (sec.length) {
                rows.push({ header: `🔴 ${sp.emoji || ''} ${(sp.sport || '').toUpperCase()} — LIVE` });
                rows.push(...sec);
            }
        }
    }
    const favCh = d.channels.filter(c => favs.has(c.id));
    if (favCh.length) {
        rows.push({ header: '★ Favorites' });
        for (const c of favCh) rows.push({ ch: chOf(c) });
    }
    let lastSec = null;
    for (const c of d.channels) {
        if (favs.has(c.id)) continue;
        const sec = c.section || 'More Channels';
        if (sec !== lastSec) { lastSec = sec; rows.push({ header: sec }); }
        rows.push({ ch: chOf(c) });
    }
    this._submit(rows, keepRowIndex);
},

_submit(rows, keepRowIndex) {
    // keepRowIndex (AJ Nov 15 "it brings my cursor all the way up there with it"): a ★
    // toggle moves the CHANNEL into Favorites but the PERSON stays on the row where they
    // were — id-tracking (default) is for refreshes, where following the channel is right.
    const keep = keepRowIndex ? null : this.cursorChannel;
    this.favFlips.clear();
    this.rows = rows;
    this.redRow = new Array(rows.length);
    let red = false;
    for (let i = 0; i < rows.length; i++) {
        if (rows[i].header != null) red = rows[i].header.startsWith('🔴');
        this.redRow[i] = red;
    }
    this.rowY = new Array(rows.length + 1); this.rowY[0] = 0;
    for (let i = 0; i < rows.length; i++)
        this.rowY[i + 1] = this.rowY[i] + (rows[i].ch ? this.rowH + this.rowGap : this.hdrRowH);
    this.contentH = this.rowY[rows.length];
    if (keep != null) {
        const idx = rows.findIndex(r => r.ch && r.ch.id === keep);
        if (idx >= 0) this.curRow = idx;
    }
    if (keepRowIndex) {
        // the re-sort can shift geometry (the first-ever ★ ADDS a header) — clamp, and if
        // the kept index landed on a header nudge to the nearest channel row instead of
        // letting the fallback below yank the cursor all the way to the top
        this.curRow = Math.min(this.curRow, rows.length - 1);
        if (!(rows[this.curRow] && rows[this.curRow].ch)) {
            const n = this.nextChannelRow(this.curRow, 1);
            this.curRow = n >= 0 ? n : this.nextChannelRow(this.curRow, -1);
        }
        const cr = rows[this.curRow];
        if (cr && cr.ch) this.cursorChannel = cr.ch.id;   // the row under the cursor, not the starred one
    }
    if (!(this.rows[this.curRow] && this.rows[this.curRow].ch)) {
        this.curRow = Math.max(0, rows.findIndex(r => r.ch));
        this.inChannelCol = true;
    }
    this.scrollY = Math.min(this.scrollY, Math.max(0, this.contentH - this._viewH()));
    this._ensureRowVisible(); this._notifyCursor(); this.invalidate();
},

favOf(c) { return c.fav !== this.favFlips.has(c.id); },

_toggleFav(c) {
    const on = !this.favOf(c);
    if (this.favFlips.has(c.id)) this.favFlips.delete(c.id); else this.favFlips.add(c.id);
    try { this.opts.onFavorite && this.opts.onFavorite(c.id, on); } catch {}
    // instant re-sort into/out of ★ Favorites like the TV (AJ Nov 15): patch the snapshot's
    // favs HERE so the rebuild is right even when the host's onFavorite doesn't share the
    // data object — then rebuild keeping the ROW INDEX, not the channel, so the person's
    // cursor/scroll stays where they were instead of riding the channel to the top
    if (this.data) {
        this.data.favs = (this.data.favs || []).filter(x => x !== c.id);
        if (on) this.data.favs.push(c.id);
    }
    this._build(true);
    return on;
},

_tune(c, p) {
    try { this.opts.onTune && this.opts.onTune('cklive:' + c.id, c.name, c.logo, (p && p.t) || ''); } catch {}
},

// ---------- geometry (straight port) ----------
_cvW() { return this.cv.clientWidth; },
_viewH() { return Math.max(1, this.cv.clientHeight - this.rulerH); },
maxShift() { return Math.max(0, this.timelinePx - (this._cvW() - this.chColW)); },
viewLeftMs() { return this.dayStart + Math.round(this.shiftPx / this.pxPerMin) * 60e3; },
xOfTime(t) { return this.chColW + ((t - this.dayStart) / 60e3) * this.pxPerMin - this.shiftPx; },

// gap-as-entry: a channel with no progs gets ONE full-span synthetic entry
entryCount(c) { return c.progs.length || 1; },
entryStart(c, i) {
    if (!c.progs.length) return this.dayStart;
    return Math.max(this.dayStart, c.progs[Math.max(0, Math.min(i, c.progs.length - 1))].s);
},
entryEnd(c, i) {
    if (!c.progs.length) return this.winEnd;
    return Math.min(this.winEnd, c.progs[Math.max(0, Math.min(i, c.progs.length - 1))].e);
},
entryAtTime(c, t) {
    if (!c.progs.length) return 0;
    for (let i = 0; i < c.progs.length; i++) if (c.progs[i].e > t) return i;
    return c.progs.length - 1;
},
nowProg(c) { const n = Date.now(); return c.progs.find(p => p.s <= n && p.e > n) || null; },

nextChannelRow(from, dir) {
    for (let i = from + dir; i >= 0 && i < this.rows.length; i += dir)
        if (this.rows[i].ch) return i;
    return -1;
},

moveRow(target) {
    this.curRow = target;
    const c = this.rows[target] && this.rows[target].ch;
    this.cursorChannel = c ? c.id : null;
    if (!this.inChannelCol && c)
        this.curEntry = this.entryAtTime(c, this.travelMs > 0 ? this.travelMs : this.viewLeftMs() + 60e3);
    this._ensureRowVisible(); this._notifyCursor(); this.invalidate();
},

_ensureRowVisible() {
    if (this.curRow < 0 || this.curRow >= this.rows.length) return;
    const viewH = this._viewH();
    const top = this.rowY[this.curRow], bot = this.rowY[this.curRow + 1];
    if (top - this.scrollY < this.rowH / 2)
        this.scrollY = Math.max(0, top - this.rowH - this.rowGap);     // one row of context above
    else if (bot - this.scrollY > viewH)
        this.scrollY = Math.min(bot - viewH, Math.max(0, this.contentH - viewH));
},

_ensureEntryVisible() {
    const c = this.rows[this.curRow] && this.rows[this.curRow].ch; if (!c) return;
    const laneW = Math.max(1, this._cvW() - this.chColW);
    const l = this.xOfTime(this.entryStart(c, this.curEntry)) + this.shiftPx - this.chColW;
    const rr = this.xOfTime(this.entryEnd(c, this.curEntry)) + this.shiftPx - this.chColW;
    let target = this.shiftPx;
    if (rr - this.shiftPx > laneW) target = (rr - l >= laneW) ? l : rr - laneW;
    if (l - target < 0) target = l;
    this.shiftPx = Math.max(0, Math.min(Math.round(target), this.maxShift()));
},

// jump time to now + cursor to the airing entry (the TV "BACK while scrolled away" snap)
snapToNow(force) {
    const nowX = this.xOfTime(Date.now()) + this.shiftPx - this.chColW;
    const target = Math.max(0, Math.min(Math.round(nowX - 30), this.maxShift()));
    const moved = Math.abs(target - this.shiftPx) > 8;
    if (moved || force) {
        this.shiftPx = target;
        if (!this.inChannelCol) {
            const c = this.rows[this.curRow] && this.rows[this.curRow].ch;
            if (c) { const i = c.progs.findIndex(p => p.s <= Date.now() && p.e > Date.now()); if (i >= 0) this.curEntry = i; }
        }
        this.travelMs = -1;
        this._notifyCursor(); this.invalidate();
    }
    return moved;
},

// ---------- input ----------
_bind() {
    const r = this.root, cv = this.cv;
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(cv);
    this._resize();

    this._onKey = (e) => this._key(e);
    r.addEventListener('keydown', this._onKey);

    // wheel pans both axes (trackpad deltaX = time travel; shift+wheel = time on a mouse)
    this._onWheel = (e) => {
        e.preventDefault();
        const k = e.deltaMode === 1 ? 24 : 1;   // line-mode wheels (Firefox)
        let dx = e.deltaX * k, dy = e.deltaY * k;
        if (e.shiftKey && !dx) { dx = dy; dy = 0; }
        this.shiftPx = Math.max(0, Math.min(this.shiftPx + Math.round(dx), this.maxShift()));
        this.scrollY = Math.max(0, Math.min(this.scrollY + Math.round(dy), Math.max(0, this.contentH - this._viewH())));
        this.invalidate();
    };
    cv.addEventListener('wheel', this._onWheel, { passive: false });

    // ONE pointer pipeline for mouse + touch: drag pans, tap/click tunes,
    // long-press ★ (the Android gesture), plain mouse move = hover details
    let down = null, dragged = false, lpT = 0;
    this._onPDown = (e) => {
        if (e.button != null && e.button !== 0) return;   // right-click handled by contextmenu
        r.focus({ preventScroll: true });
        cv.setPointerCapture && cv.setPointerCapture(e.pointerId);
        down = { x: e.clientX, y: e.clientY, sx: this.shiftPx, sy: this.scrollY };
        dragged = false;
        clearTimeout(lpT);
        if (e.pointerType === 'touch') lpT = setTimeout(() => {
            if (dragged || !down) return;
            down = null;
            const hit = this._hitAt(e);
            const row = hit && this.rows[hit.row];
            if (row && row.ch) { this._applyHit(hit); this._toggleFav(row.ch); }
        }, 550);
    };
    this._onPMove = (e) => {
        if (!down) { if (e.pointerType !== 'touch') this._hover(e); return; }
        const dx = down.x - e.clientX, dy = down.y - e.clientY;
        if (!dragged && Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        dragged = true; clearTimeout(lpT);
        this.shiftPx = Math.max(0, Math.min(down.sx + Math.round(dx), this.maxShift()));
        this.scrollY = Math.max(0, Math.min(down.sy + Math.round(dy), Math.max(0, this.contentH - this._viewH())));
        this.invalidate();
    };
    this._onPUp = (e) => {
        clearTimeout(lpT);
        if (!down) return;
        down = null;
        if (!dragged) this._tap(e);
    };
    this._onPCancel = () => { clearTimeout(lpT); down = null; };
    this._onLeave = () => { if (this.hover) { this.hover = null; this._notifyCursor(); this.invalidate(); } };
    this._onCtx = (e) => {   // right-click = ★ toggle (desktop twin of long-press)
        e.preventDefault();
        const hit = this._hitAt(e);
        const row = hit && this.rows[hit.row];
        if (row && row.ch) { this._applyHit(hit); this._toggleFav(row.ch); }
    };
    cv.addEventListener('pointerdown', this._onPDown);
    cv.addEventListener('pointermove', this._onPMove);
    cv.addEventListener('pointerup', this._onPUp);
    cv.addEventListener('pointercancel', this._onPCancel);
    cv.addEventListener('pointerleave', this._onLeave);
    cv.addEventListener('contextmenu', this._onCtx);
},

_resize() {
    const cv = this.cv, dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    this._metrics();
    this.timelinePx = Math.round((this.winEnd - this.dayStart) / 60e3) * this.pxPerMin;
    // crisp on hidpi: backing store = css px × dpr, drawn in css coordinates
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
        cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    }
    this._dpr = dpr;
    this.shiftPx = Math.max(0, Math.min(this.shiftPx, this.maxShift()));
    this.scrollY = Math.max(0, Math.min(this.scrollY, Math.max(0, this.contentH - this._viewH())));
    this.invalidate();
},

// canvas-local coords of a pointer event → {row, entry, inCh} | null (header/gap/ruler)
_hitAt(e) {
    const b = this.cv.getBoundingClientRect();
    const x = e.clientX - b.left, y = e.clientY - b.top;
    if (y < this.rulerH || !this.rows.length) return null;
    const cy = y - this.rulerH + this.scrollY;
    let found = -1;
    // rows are uniform enough to scan; binary search not worth it under ~2k rows
    for (let i = 0; i < this.rows.length; i++)
        if (cy >= this.rowY[i] && cy < this.rowY[i + 1]) { found = i; break; }
    const c = found >= 0 && this.rows[found].ch;
    if (!c) return null;
    const inCh = x < this.chColW;
    let entry = 0;
    if (!inCh) {
        const t = this.viewLeftMs() + ((x - this.chColW) / this.pxPerMin) * 60e3;
        entry = this.entryAtTime(c, t);
    }
    return { row: found, entry, inCh, x, y };
},

_applyHit(hit) {
    const c = this.rows[hit.row].ch;
    this.curRow = hit.row; this.cursorChannel = c.id;
    this.inChannelCol = hit.inCh;
    if (!hit.inCh) { this.curEntry = hit.entry; this.travelMs = this.entryStart(c, hit.entry); }
    this._notifyCursor(); this.invalidate();
},

_tap(e) {
    const hit = this._hitAt(e); if (!hit) return;
    const c = this.rows[hit.row].ch;
    // the ★ hitzone = leftmost strip of the channel cell (mouse affordance the TV lacks)
    if (hit.inCh && hit.x < 26) { this._applyHit(hit); this._toggleFav(c); return; }
    this._applyHit(hit);
    const p = hit.inCh ? this.nowProg(c) : (c.progs[this.curEntry] || null);
    this._tune(c, p);
},

_hover(e) {
    const hit = this._hitAt(e);
    const prev = this.hover;
    this.hover = hit && { row: hit.row, entry: hit.entry, inCh: hit.inCh };
    const same = (!prev && !this.hover) || (prev && this.hover &&
        prev.row === this.hover.row && prev.entry === this.hover.entry && prev.inCh === this.hover.inCh);
    if (!same) { this._notifyCursor(); this.invalidate(); }
    this.cv.style.cursor = hit ? 'pointer' : 'default';
},

_key(e) {
    if (e.altKey || e.metaKey || e.ctrlKey) return;
    const K = e.key;
    const handled = () => { e.preventDefault(); e.stopPropagation(); };
    if (K === 'ArrowUp' || K === 'ArrowDown') {
        handled();
        const nxt = this.nextChannelRow(this.curRow, K === 'ArrowUp' ? -1 : 1);
        if (nxt >= 0) this.moveRow(nxt);
        return;
    }
    if (K === 'PageUp' || K === 'PageDown') {
        handled();
        const dir = K === 'PageUp' ? -1 : 1;
        const perPage = Math.max(1, Math.floor(this._viewH() / (this.rowH + this.rowGap)));
        let t = this.curRow;
        for (let i = 0; i < perPage; i++) { const n = this.nextChannelRow(t, dir); if (n >= 0) t = n; }
        if (t !== this.curRow) this.moveRow(t);
        return;
    }
    const c = this.rows[this.curRow] && this.rows[this.curRow].ch;
    if (K === 'ArrowLeft') {
        handled();
        if (this.inChannelCol || !c) return;
        if (this.curEntry > 0) { this.curEntry--; this.travelMs = this.entryStart(c, this.curEntry); this._ensureEntryVisible(); }
        else this.inChannelCol = true;
        this._notifyCursor(); this.invalidate();
        return;
    }
    if (K === 'ArrowRight') {
        handled();
        if (!c) return;
        if (this.inChannelCol) {
            this.inChannelCol = false;
            this.curEntry = this.entryAtTime(c, this.viewLeftMs() + 60e3);
            this.travelMs = this.entryStart(c, this.curEntry);
        } else if (this.curEntry < this.entryCount(c) - 1) {
            this.curEntry++; this.travelMs = this.entryStart(c, this.curEntry);
        }
        this._ensureEntryVisible(); this._notifyCursor(); this.invalidate();
        return;
    }
    if (K === 'Enter' || K === ' ') {
        handled();
        if (!c) return;
        this._tune(c, this.inChannelCol ? this.nowProg(c) : (c.progs[this.curEntry] || null));
        return;
    }
    if (K === 'f' || K === 'F') { handled(); if (c) this._toggleFav(c); return; }
    if (K === 'Home') { handled(); if (this.day !== 0) this._setDay(0); this.snapToNow(true); return; }
},

// ---------- detail card (the TV's onCursor → dcTitle/dcDesc block) ----------
_notifyCursor(clockOnly) {
    const src = this.hover || { row: this.curRow, entry: this.curEntry, inCh: this.inChannelCol };
    const c = this.rows[src.row] && this.rows[src.row].ch;
    if (!c) return;
    const p = src.inCh ? this.nowProg(c) : (c.progs[src.entry] || null);
    const k = c.id + ':' + (p ? p.s : 0);
    const now = Date.now();
    if (p && p.s <= now && p.e > now) {
        this.det.bar.style.display = '';
        this.det.fill.style.width = Math.min(100, Math.max(0, 100 * (now - p.s) / Math.max(1, p.e - p.s))) + '%';
    } else this.det.bar.style.display = 'none';
    if (clockOnly && k === this._detKey) return;
    if (k === this._detKey) return;
    this._detKey = k;
    if (c.logo) { this.det.logo.src = c.logo; this.det.logo.style.display = ''; }
    else this.det.logo.style.display = 'none';
    this.det.nm.textContent = c.name + (p ? `   ${fmtT(p.s)} – ${fmtT(p.e)}` : '');
    this.det.title.textContent = p ? p.t : 'Live programming';
    this.det.desc.textContent = '';
    // description via epgdesc.json, debounced + per-channel cached like the TV
    clearTimeout(this._descTimer);
    if (p && this.opts.epgDescUrl) {
        const fill = (progs) => {
            if (this._detKey !== k) return;
            const q = (progs || []).find(q => +q.s === p.s);
            if (q && q.d) this.det.desc.textContent = q.d;
        };
        if (this.descCache.has(c.id)) fill(this.descCache.get(c.id));
        else this._descTimer = setTimeout(async () => {
            try {
                const r = await fetch(this.opts.epgDescUrl(c.id), { credentials: 'same-origin' });
                const d = await r.json();
                if (!this.alive || !d || !Array.isArray(d.progs)) return;
                this.descCache.set(c.id, d.progs);
                fill(d.progs);
            } catch {}
        }, 250);
    }
},

// ---------- logos (async decode → cache → invalidate) ----------
_logoFor(c) {
    if (this.logos.has(c.id)) { const im = this.logos.get(c.id); return (im && im._ok) ? im : null; }
    this.logos.set(c.id, null);
    if (!c.logo) return null;
    if (this.logos.size > 500) {   // same trim rule as the TV cache
        const it = this.logos.keys(); let n = 200;
        while (n-- > 0) { const k = it.next(); if (k.done) break; this.logos.delete(k.value); }
    }
    const im = new Image();
    im.onload = () => { im._ok = true; if (this.alive) this.invalidate(); };
    im.onerror = () => {};   // stays null-ish → titled cell, never a broken-logo hole
    im.src = c.logo;
    this.logos.set(c.id, im);
    return null;
},

// ---------- draw (visible-only, every frame — port of onDraw) ----------
invalidate() {
    if (this._raf || !this.alive) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._draw(); });
},

_draw() {
    if (!this.alive || !this.root.isConnected) return;
    const ctx = this.ctx, dpr = this._dpr || 1;
    const w = this.cv.clientWidth, h = this.cv.clientHeight;
    if (!w || !h) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = BG; ctx.fillRect(0, 0, w, h);
    ctx.textBaseline = 'alphabetic';
    if (!this.rows.length) {
        ctx.fillStyle = DIM; ctx.font = `700 14px ${FONTS}`;
        ctx.fillText(this.data ? 'No channels in the guide.' : 'Loading the guide…', 16, 40);
        return;
    }
    const now = Date.now();
    const accent = this.accent;
    const cellLive = blend(CELL, accent, 0.20);
    const cellLiveRed = blend(CELL, RED, 0.30);
    const cellFocus = blend(CELL, accent, 0.60);
    const focusStroke = blend(accent, '#FFFFFF', 0.45);

    // ── ruler: date cell + 30-min ticks ──
    ctx.fillStyle = SEC_BG; ctx.fillRect(0, 0, this.chColW, this.rulerH);
    ctx.fillStyle = FG; ctx.font = `700 11px ${FONTS}`;
    ctx.fillText(fmtD(this.viewLeftMs()), 8, this.rulerH - 9);
    ctx.save();
    ctx.beginPath(); ctx.rect(this.chColW, 0, w - this.chColW, this.rulerH); ctx.clip();
    ctx.fillStyle = DIM; ctx.font = `400 11px ${FONTS}`;
    let tick = this.dayStart - (this.dayStart % HALF);
    while (tick < this.winEnd) {
        const x = this.xOfTime(tick);
        if (x > w) break;
        if (x + 80 > this.chColW) ctx.fillText(fmtT(tick), x + 4, this.rulerH - 9);
        tick += HALF;
    }
    ctx.restore();

    // ── rows (visible window only) ──
    const viewTop = this.scrollY, viewBot = this.scrollY + (h - this.rulerH);
    let i = 0;
    while (i < this.rows.length && this.rowY[i + 1] <= viewTop) i++;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, this.rulerH, w, h - this.rulerH); ctx.clip();
    while (i < this.rows.length && this.rowY[i] < viewBot) {
        const y0 = this.rowY[i] - this.scrollY + this.rulerH;
        const row = this.rows[i];
        if (!row.ch) {   // section header band (🔴 live sections read RED)
            const hdr = row.header || '';
            ctx.fillStyle = SEC_BG;
            ctx.fillRect(0, y0, w, this.hdrRowH - 2);
            ctx.fillStyle = hdr.startsWith('🔴') ? RED : SEC;
            ctx.font = `700 10px ${FONTS}`;
            ctx.fillText(hdr.toUpperCase(), 8, y0 + this.hdrRowH - 9);
            i++; continue;
        }
        const c = row.ch;
        const focusRow = i === this.curRow;
        const hovRow = this.hover && this.hover.row === i;
        // channel cell
        const chFoc = focusRow && this.inChannelCol;
        this._rr(ctx, 1, y0, this.chColW - 2, this.rowH, 6);
        ctx.fillStyle = chFoc ? cellFocus : CHCOL_BG; ctx.fill();
        if (chFoc || (hovRow && this.hover.inCh)) {
            ctx.strokeStyle = chFoc ? focusStroke : CELL_LINE; ctx.lineWidth = chFoc ? 2 : 1; ctx.stroke();
        }
        // ★ (gold = faved; dim = clickable hitzone)
        const faved = this.favOf(c);
        ctx.fillStyle = faved ? STAR_ON : '#3A3550';
        ctx.font = `400 13px ${FONTS}`;
        ctx.fillText('★', 7, y0 + this.rowH / 2 + 5);
        let tx = 26;
        const bm = this._logoFor(c);
        if (bm) {
            const ls = 24;
            try { ctx.drawImage(bm, tx, y0 + (this.rowH - ls) / 2, ls, ls); } catch {}
        }
        if (c.logo) tx += 30;
        ctx.fillStyle = FG; ctx.font = `400 12px ${FONTS}`;
        ctx.fillText(ellipsize(ctx, c.name, this.chColW - tx - 6), tx, y0 + this.rowH / 2 + 4);
        // programme cells
        ctx.save();
        ctx.beginPath(); ctx.rect(this.chColW, this.rulerH, w - this.chColW, h - this.rulerH); ctx.clip();
        const red = !!this.redRow[i];
        const hovEntry = hovRow && !this.hover.inCh ? this.hover.entry : -1;
        if (!c.progs.length) {
            this._cell(ctx, this.xOfTime(this.dayStart), this.xOfTime(this.winEnd), y0,
                this.day ? 'No guide data for this day' : 'Live programming', this.dayStart,
                red, false, focusRow && !this.inChannelCol, hovEntry === 0, false, red,
                cellLive, cellLiveRed, cellFocus, focusStroke);
        } else {
            for (let pi = 0; pi < c.progs.length; pi++) {
                const p = c.progs[pi];
                const x0 = this.xOfTime(Math.max(p.s, this.dayStart));
                const x1 = this.xOfTime(Math.min(p.e, this.winEnd));
                if (x1 < this.chColW) continue;
                if (x0 > w) break;
                this._cell(ctx, x0, x1, y0, p.t, p.s,
                    p.s <= now && p.e > now, p.e <= now,
                    focusRow && !this.inChannelCol && pi === this.curEntry, hovEntry === pi,
                    true, red, cellLive, cellLiveRed, cellFocus, focusStroke);
            }
        }
        ctx.restore();
        i++;
    }
    ctx.restore();

    // ── now line across the grid (today only — other days have no "now") ──
    const nowX = this.xOfTime(now);
    if (nowX >= this.chColW && nowX <= w && now >= this.dayStart && now <= this.winEnd) {
        ctx.fillStyle = NOW_LINE;
        ctx.fillRect(nowX, this.rulerH, 2, h - this.rulerH);
    }
},

_rr(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);   // old Safari — square corners beat a crash
},

_cell(ctx, x0, x1, y0, title, startMs, live, past, focused, hovered, showTime, red,
      cellLive, cellLiveRed, cellFocus, focusStroke) {
    const l = x0 + 1, rt = x1 - 1;
    if (rt - l < 3) return;
    this._rr(ctx, l, y0, rt - l, this.rowH, 6);
    ctx.fillStyle = focused ? cellFocus : live ? (red ? cellLiveRed : cellLive) : past ? CELL_PAST : CELL;
    ctx.fill();
    ctx.strokeStyle = focused ? focusStroke : hovered ? blend(CELL_LINE, '#FFFFFF', 0.4) : CELL_LINE;
    ctx.lineWidth = focused ? 2 : 1;
    ctx.stroke();
    if (rt - l < 52) return;
    // LABEL PINNING (Kodi): text starts at the viewport edge while the cell hangs off-left
    const textL = Math.max(l, this.chColW) + 6;
    const avail = rt - textL - 6;
    if (avail < 30) return;
    ctx.fillStyle = (focused || live) ? FG : past ? PAST_TXT : DIM;
    ctx.font = `700 12px ${FONTS}`;
    ctx.fillText(ellipsize(ctx, title, avail), textL, y0 + 21);
    if (showTime) {
        ctx.fillStyle = past ? PAST_TXT : TIME_TXT;
        ctx.font = `400 10px ${FONTS}`;
        ctx.fillText(fmtT(startMs), textL, y0 + 38);
    }
},

unmount() {
    if (!this.alive) return;
    this.alive = false;
    clearInterval(this._tick); clearTimeout(this._retry); clearTimeout(this._descTimer);
    if (this._raf) cancelAnimationFrame(this._raf);
    try { this._ro && this._ro.disconnect(); } catch {}
    const cv = this.cv, r = this.root;
    cv.removeEventListener('wheel', this._onWheel);
    cv.removeEventListener('pointerdown', this._onPDown);
    cv.removeEventListener('pointermove', this._onPMove);
    cv.removeEventListener('pointerup', this._onPUp);
    cv.removeEventListener('pointercancel', this._onPCancel);
    cv.removeEventListener('pointerleave', this._onLeave);
    cv.removeEventListener('contextmenu', this._onCtx);
    r.removeEventListener('keydown', this._onKey);
    this.logos.clear();
    r.classList.remove('ckg2');
    r.innerHTML = '';
    if (r.__ckg2 === this) delete r.__ckg2;
},
};

window.CKGuide2 = {
    mount(el, opts) {
        if (el.__ckg2) el.__ckg2.unmount();
        const g = new Guide2(el, opts || {});
        el.__ckg2 = g;
        return g;
    },
    unmount(el) { if (el && el.__ckg2) el.__ckg2.unmount(); },
};
})();
