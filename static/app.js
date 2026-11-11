import { h, render } from "preact";
import { useState, useEffect, useMemo, useRef, useCallback } from "preact/hooks";
import htm from "./vendor/htm.module.js";

const html = htm.bind(h);

/* ------------------------------------------------------------------ utils */

const $fetch = (url, opts) =>
  fetch(url, opts ? { headers: { "Content-Type": "application/json" }, ...opts } : undefined).then((r) => {
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  });

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3000);
}

/** Compress a photo client-side before upload: max 1280px, JPEG ~82%. */
async function compressImage(file, maxDim = 1280, quality = 0.82) {
  let bitmap;
  if (window.createImageBitmap) {
    bitmap = await createImageBitmap(file);
  } else {
    bitmap = await new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = rej;
      img.src = URL.createObjectURL(file);
    });
  }
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
  if (bitmap.close) bitmap.close();
  return new Promise((res) => canvas.toBlob(res, "image/jpeg", quality));
}

/* -------------------------------------------------------- lucide icons */

const ICONS = {
  heart: '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  chart: '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
  package: '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  sparkles: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .962 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.962 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  lightbulb: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
  maximize: '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" x2="14" y1="3" y2="10"/><line x1="3" x2="10" y1="21" y2="14"/>',
  alert: '<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>',
};

function Icon({ name, size = 16, class: cls = "" }) {
  return html`<svg class="icon ${cls}" width=${size} height=${size} viewBox="0 0 24 24"
    fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"
    dangerouslySetInnerHTML=${{ __html: ICONS[name] }} />`;
}

/* ----------------------------------------------------- weights privacy */

/** Weight value, hidden until tapped. Only used inside the detail view. */
function W({ v, label }) {
  const [revealed, setRevealed] = useState(false);
  if (v == null) return null;
  return html`<button class="weight ${revealed ? "" : "w-hidden"}"
    title=${revealed ? "" : "tap to reveal"}
    onClick=${(e) => { e.stopPropagation(); setRevealed(!revealed); }}>
    <span class="w-label">${label}</span>
    ${revealed ? `${v.toFixed(1)} g` : "•••• g"}
    ${revealed ? null : html`<${Icon} name="eye" size=${13} />`}
  </button>`;
}

function SyncBanner({ meta }) {
  const orphans = meta?.orphan_logs || [];
  if (!orphans.length) return null;
  return html`<div class="banner warn">
    <${Icon} name="alert" size=${15} />
    <span>
      ${orphans.length} logged ${orphans.length === 1 ? "copy is" : "copies are"} no longer
      matched to a figure in the sheet (the sheet may have renamed it). Your log data is
      safe in the database.
    </span>
  </div>`;
}

function Footer({ meta }) {
  if (!meta) return null;
  return html`<footer class="footer">
    Smiski Landia v${meta.version || "?"} ·
    sheet updated ${meta.sheet_updated || "unknown"} ·
    ${meta.figure_count || 0} figures in ${meta.series_count || 0} series
  </footer>`;
}

/* ------------------------------------------------------------- catalog */

function useCatalog() {
  const [state, setState] = useState(null);
  useEffect(() => {
    Promise.all([$fetch("/api/catalog"), $fetch("/api/collection")])
      .then(([cat, col]) => {
        setState({ ...cat, logs: col.logs, wishlist: new Set(col.wishlist) });
      })
      .catch((e) => setState({ error: e.message }));
  }, []);
  return [state, setState];
}

/** derived: key -> { count, logs[] } */
function useOwned(state) {
  return useMemo(() => {
    const m = new Map();
    if (state) {
      for (const l of state.logs) {
        if (!m.has(l.key)) m.set(l.key, []);
        m.get(l.key).push(l);
      }
    }
    return m;
  }, [state?.logs]);
}

/* ------------------------------------------------------------- header */

function Header({ route }) {
  const [busy, setBusy] = useState(false);
  const go = (r) => (e) => { e.preventDefault(); location.hash = r; };
  const doSync = async () => {
    setBusy(true);
    try {
      const r = await $fetch("/api/sync", { method: "POST" });
      const warn = r.orphan_logs?.length ? ` (${r.orphan_logs.length} orphaned logs)` : "";
      toast(`Sheet re-synced — ${r.figures} figures${warn}`);
      setTimeout(() => location.reload(), 1200);
      return;
    } catch (e) { toast("Sync failed — " + e.message); }
    setBusy(false);
  };
  return html`<header class="topbar">
    <div class="logo">Smiski Landia</div>
    <nav class="tabs">
      <a href="#/" onClick=${go("#/")} class=${route === "catalog" ? "active" : ""}
        title="Collection" aria-label="Collection">
        <${Icon} name="package" size=${15} /><span class="tab-label">Collection</span></a>
      <a href="#/stats" onClick=${go("#/stats")} class=${route === "stats" ? "active" : ""}
        title="Stats" aria-label="Stats">
        <${Icon} name="chart" size=${15} /><span class="tab-label">Stats</span></a>
      <a href="#/finder" onClick=${go("#/finder")} class=${route === "finder" ? "active" : ""}
        title="Finder" aria-label="Finder">
        <${Icon} name="search" size=${15} /><span class="tab-label">Finder</span></a>
    </nav>
    <button class="iconbtn sync" onClick=${doSync} disabled=${busy} title="Re-sync the community sheet"
      aria-label="Re-sync the community sheet">
      <${Icon} name="refresh" size=${15} class=${busy ? "spin" : ""} />
      <span class="sync-label">Sync sheet</span>
    </button>
  </header>`;
}

/* --------------------------------------------------------------- card */

function Card({ fig, logs, wishlisted, onOpen, onLog, onWish }) {
  const count = logs?.length || 0;
  return html`<div class="card ${count ? "owned" : wishlisted ? "wish" : ""}">
    <div class="imgwrap" onClick=${() => onOpen(fig)}>
      ${fig.image
        ? html`<img src="/images/${fig.image}" alt=${fig.name} loading="lazy" />`
        : html`<span class="placeholder"><${Icon} name="package" size=${40} /></span>`}
    </div>
    <h4 onClick=${() => onOpen(fig)}>
      ${fig.is_secret ? html`<span class="secret-star"><${Icon} name="sparkles" size=${12} /></span> ` : ""}
      ${fig.name}
    </h4>
    <div class="meta">
      <span class="badge">${fig.series}</span>
      ${count > 1 ? html`<span class="badge count">×${count}</span>` : null}
      ${count ? html`<span class="badge ok"><${Icon} name="check" size=${11} /></span>` : null}
      ${logs?.some((l) => l.has_photo) ? html`<span class="badge photo"><${Icon} name="camera" size=${11} /></span>` : null}
    </div>
    <div class="actions">
      <button class="act heart ${wishlisted ? "active" : ""}" title="Wishlist"
        onClick=${() => onWish(fig.key)}>
        <${Icon} name="heart" size=${17} />
      </button>
      <button class="act plus" title="Log one" onClick=${() => onLog(fig.key)}>
        <${Icon} name="plus" size=${17} />
      </button>
    </div>
  </div>`;
}

/* ------------------------------------------------------- photo control */

function PhotoLightbox({ log, onClose, onDeleted }) {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);

  const del = async () => {
    setBusy(true);
    await fetch(`/api/photo/${log.id}`, { method: "DELETE" });
    setBusy(false);
    onDeleted();
    onClose();
  };

  return html`<div class="lightbox" onClick=${onClose}>
    <div class="lb-inner" onClick=${(e) => e.stopPropagation()}>
      <img src="/photos/${log.key}-${log.id}.jpg" alt="photo of this smiski" />
      <div class="lb-actions">
        <button class="btn danger big" onClick=${del} disabled=${busy}>
          <${Icon} name="trash" size=${17} /> Delete photo
        </button>
        <button class="btn secondary big" onClick=${onClose}>
          <${Icon} name="x" size=${17} /> Close
        </button>
      </div>
    </div>
  </div>`;
}

function PhotoControl({ log, onOpen, onChanged }) {
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  const upload = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const blob = await compressImage(file);
      const body = new FormData();
      body.append("file", blob, "photo.jpg");
      const r = await fetch(`/api/photo/${log.id}`, { method: "POST", body });
      if (!r.ok) throw new Error(await r.text());
      onChanged();
    } catch (e) {
      toast("Photo upload failed");
    }
    setBusy(false);
    if (inputRef.current) inputRef.current.value = "";
  };

  return html`<div class="photocell">
    ${log.has_photo
      ? html`<img class="photothumb" src="/photos/${log.key}-${log.id}.jpg"
          alt="photo" title="View photo" onClick=${() => onOpen(log)} />`
      : html`<button class="mini photo-add" title="Take photo"
          onClick=${() => inputRef.current?.click()} disabled=${busy}>
          <${Icon} name="camera" size=${15} />
        </button>`}
    <input ref=${inputRef} type="file" accept="image/*" capture="environment" hidden
      onChange=${(e) => upload(e.target.files?.[0])} />
  </div>`;
}

/* --------------------------------------------------------------- modal */

function Detail({ fig, logs, wishlisted, onClose, onLog, onDelLog, onEditLog, onWish, onPhotoChanged }) {
  const figLogs = logs || [];
  const [lightbox, setLightbox] = useState(null);
  return html`<div class="overlay" onClick=${onClose}>
    <div class="modal" onClick=${(e) => e.stopPropagation()}>
      <button class="closex" onClick=${onClose}><${Icon} name="x" size=${18} /></button>
      <div class="mhead">
        <div class="mimg">
          ${fig.image
            ? html`<img src="/images/${fig.image}" alt=${fig.name} />`
            : html`<div class="placeholder"><${Icon} name="package" size=${48} /></div>`}
        </div>
        <div class="mtitle">
          <h2>${fig.name}</h2>
          <div class="meta">
            <span class="badge">${fig.series}</span>
            ${fig.is_secret ? html`<span class="badge secret"><${Icon} name="sparkles" size=${11} /> Secret</span>` : null}
          </div>
          <button class="heart-toggle ${wishlisted ? "active" : ""}" onClick=${() => onWish(fig.key)}>
            <${Icon} name="heart" size=${15} /> ${wishlisted ? "Wishlisted" : "Add to wishlist"}
          </button>
        </div>
      </div>

      <div class="mweights">
        <${W} v=${fig.avg_boxed} label="boxed" />
        <${W} v=${fig.avg_unboxed} label="unboxed" />
        <span class="datapts">${fig.n_boxed || 0} / ${fig.n_unboxed || 0} data points</span>
      </div>

      ${fig.tip ? html`<div class="tipbox">
        <${Icon} name="lightbulb" size=${14} /> <b>Tips & tricks</b>
${fig.tip}</div>` : null}

      <div class="logshead">
        <span>Log <em>(${figLogs.length})</em></span>
        <button class="btn small" onClick=${() => onLog(fig.key)}>
          <${Icon} name="plus" size=${14} /> Log one
        </button>
      </div>
      ${figLogs.length === 0
        ? html`<div class="logs-empty">No copies logged yet</div>`
        : figLogs.map((log) => html`<div class="logrow" key=${log.id}>
            <${PhotoControl} log=${log} onOpen=${setLightbox} onChanged=${onPhotoChanged} />
            <input type="date" class="logdate" value=${log.acquired_date || ""}
              onChange=${(e) => onEditLog(log.id, { acquired_date: e.target.value })} />
            <input type="text" class="lognote" placeholder="Note"
              value=${log.note || ""}
              onChange=${(e) => onEditLog(log.id, { note: e.target.value })} />
            <button class="mini danger" title="Delete log" onClick=${() => onDelLog(log.id)}>
              <${Icon} name="trash" size=${14} />
            </button>
          </div>`)}
    </div>
    ${lightbox && html`<${PhotoLightbox} log=${lightbox}
      onClose=${() => setLightbox(null)} onDeleted=${onPhotoChanged} />`}
  </div>`;
}

/* --------------------------------------------------------- catalog page */

function CatalogPage({ state, refresh }) {
  const [q, setQ] = useState("");
  const [series, setSeries] = useState("All");
  const [tab, setTab] = useState("all");
  const [open, setOpen] = useState(null);
  const owned = useOwned(state);

  const seriesList = useMemo(() => {
    const seen = new Set();
    for (const f of state.figures) seen.add(f.series);
    return [...seen];
  }, [state.figures]);

  const figs = useMemo(() => {
    let list = state.figures;
    if (series !== "All") list = list.filter((f) => f.series === series);
    if (tab === "owned") list = list.filter((f) => owned.has(f.key));
    if (tab === "wishlist") list = list.filter((f) => state.wishlist.has(f.key) && !owned.has(f.key));
    if (tab === "missing") list = list.filter((f) => !owned.has(f.key));
    if (q.trim()) {
      const n = q.trim().toLowerCase();
      list = list.filter((f) => f.name.toLowerCase().includes(n) || f.series.toLowerCase().includes(n));
    }
    return list;
  }, [state, owned, q, series, tab]);

  const onLog = async (key) => {
    const fig = state.figures.find((f) => f.key === key);
    const inSeries = state.figures.filter((f) => f.series === fig.series);
    const othersOwned = inSeries.filter((f) => f.key !== key && owned.has(f.key)).length;
    const newCount = (owned.get(key)?.length || 0) + 1;
    await $fetch("/api/logs", {
      method: "POST",
      body: JSON.stringify({ key, acquired_date: new Date().toISOString().slice(0, 10) }),
    });
    if (!owned.has(key) && inSeries.length > 1 && othersOwned === inSeries.length - 1) {
      toast(`${fig.series} complete!`);
    } else {
      toast(`${fig.name} logged ×${newCount}`);
    }
    refresh();
  };

  const onWish = async (key) => {
    const on = !state.wishlist.has(key);
    await $fetch(`/api/wishlist/${key}`, {
      method: "PUT",
      body: JSON.stringify({ wishlist: on }),
    });
    refresh();
  };

  const onDelLog = async (id) => {
    await $fetch(`/api/logs/${id}`, { method: "DELETE" });
    refresh();
  };

  const onEditLog = async (id, body) => {
    await $fetch(`/api/logs/${id}`, { method: "PATCH", body: JSON.stringify(body) });
    refresh();
  };

  return html`<div>
    <${SyncBanner} meta=${state.meta} />
    <div class="controls">
      <input type="search" placeholder="Search smiskis" value=${q} onInput=${(e) => setQ(e.target.value)} />
      <div class="mode-toggle">
        ${[["all", "All"], ["owned", "Owned"], ["wishlist", "Wishlist"], ["missing", "Missing"]].map(([k, l]) => html`
          <button class=${tab === k ? "active" : ""} onClick=${() => setTab(k)}>${l}</button>`)}
      </div>
    </div>
    <div class="chips">
      <button class="chip ${series === "All" ? "active" : ""}" onClick=${() => setSeries("All")}>All series</button>
      ${seriesList.map((s) => html`
        <button class="chip ${series === s ? "active" : ""}" onClick=${() => setSeries(s)}>${s}</button>`)}
    </div>
    ${figs.length === 0
      ? html`<div class="empty">Nothing here yet</div>`
      : html`<div class="grid">
          ${figs.map((f) => html`<${Card} key=${f.key} fig=${f}
            logs=${owned.get(f.key)} wishlisted=${state.wishlist.has(f.key)}
            onOpen=${setOpen} onLog=${onLog} onWish=${onWish} />`)}
        </div>`}
    ${open && html`<${Detail} fig=${open}
      logs=${owned.get(open.key)} wishlisted=${state.wishlist.has(open.key)}
      onClose=${() => setOpen(null)} onLog=${onLog} onDelLog=${onDelLog}
      onEditLog=${onEditLog} onWish=${onWish} onPhotoChanged=${refresh} />`}
  </div>`;
}

/* ----------------------------------------------------------- stats page */

function StatsPage({ state }) {
  const owned = useOwned(state);
  const bySeries = useMemo(() => {
    const m = new Map();
    for (const f of state.figures) {
      if (!m.has(f.series)) m.set(f.series, { total: 0, owned: 0, copies: 0, secretsTotal: 0, secretsOwned: 0, photos: 0 });
      const s = m.get(f.series);
      s.total++;
      if (f.is_secret) s.secretsTotal++;
      const logs = owned.get(f.key) || [];
      if (logs.length) {
        s.owned++;
        s.copies += logs.length;
        if (f.is_secret) s.secretsOwned++;
        s.photos += logs.filter((l) => l.has_photo).length;
      }
    }
    return [...m.entries()].sort((a, b) => b[1].owned / b[1].total - a[1].owned / a[1].total);
  }, [state, owned]);

  const total = state.figures.length;
  const ownedFigs = owned.size;
  const totalCopies = state.logs.length;
  const dupes = totalCopies - ownedFigs;
  const wish = [...state.wishlist].filter((k) => !owned.has(k)).length;
  const secretsOwned = bySeries.reduce((a, [, s]) => a + s.secretsOwned, 0);
  const photos = state.logs.filter((l) => l.has_photo).length;
  const pct = total ? Math.round((ownedFigs / total) * 100) : 0;

  return html`<div>
    <div class="statgrid">
      <div class="stat"><div class="v">${ownedFigs}<span class="v-sub">/${total}</span></div><div class="k">Figures collected</div></div>
      <div class="stat"><div class="v">${pct}%</div><div class="k">Overall completion</div></div>
      <div class="stat"><div class="v">${totalCopies}</div><div class="k">Total copies logged</div></div>
      <div class="stat"><div class="v">${dupes}</div><div class="k">Duplicates</div></div>
      <div class="stat"><div class="v">${secretsOwned}</div><div class="k">Secrets found</div></div>
      <div class="stat"><div class="v">${wish}</div><div class="k">On the wishlist</div></div>
      <div class="stat"><div class="v">${photos}</div><div class="k">Photos logged</div></div>
    </div>
    ${bySeries.map(([name, s]) => html`
      <div class="srow" key=${name}>
        <div class="top">
          <span>${name}</span>
          <span class="cnt">${s.owned}/${s.total}${s.copies > s.owned ? ` · ${s.copies} copies` : ""}${s.secretsTotal ? ` · secret ${s.secretsOwned}/${s.secretsTotal}` : ""}${s.photos ? ` · ${s.photos} photos` : ""}</span>
        </div>
        <div class="bar"><div style="width:${(s.owned / s.total) * 100}%"></div></div>
      </div>`)}
  </div>`;
}

/* --------------------------------------------------------- finder page */

function TipPop({ fig, pos }) {
  if (!fig || !pos) return null;
  const style = {
    left: Math.min(pos.x + 14, window.innerWidth - 320) + "px",
    top: Math.min(pos.y + 14, window.innerHeight - 130) + "px",
  };
  return html`<div class="tip-pop" style=${style}>
    <div class="ttp-head">
      <${Icon} name="lightbulb" size=${12} /> ${fig.name}${fig.is_secret ? " (secret)" : ""}
    </div>
    ${fig.tip || "No tips & tricks recorded for this one yet."}
  </div>`;
}

function FinderPage() {
  const [catalog, setCatalog] = useState(null);
  const [collection, setCollection] = useState({ logs: [], wishlist: [] });
  const [series, setSeries] = useState("");
  const [weight, setWeight] = useState("");
  const [mode, setMode] = useState("boxed");
  const [results, setResults] = useState(null);
  const [hover, setHover] = useState(null); // { fig, pos }
  const timer = useRef(null);

  useEffect(() => {
    $fetch("/api/catalog").then(setCatalog);
    $fetch("/api/collection").then(setCollection);
  }, []);

  const seriesList = useMemo(() => {
    if (!catalog) return [];
    return [...new Set(catalog.figures.map((f) => f.series))];
  }, [catalog]);

  const figByKey = useMemo(() => {
    const m = new Map();
    if (catalog) for (const f of catalog.figures) m.set(f.key, f);
    return m;
  }, [catalog]);

  const ownedKeys = useMemo(() => new Set(collection.logs.map((l) => l.key)), [collection]);
  const wishKeys = useMemo(() => new Set(collection.wishlist), [collection]);

  const run = async () => {
    if (!series || !weight) return;
    const r = await $fetch(`/api/finder?series=${encodeURIComponent(series)}&weight=${weight}&mode=${mode}`);
    setResults(r);
  };

  const onHover = (fig) => (e) => {
    clearTimeout(timer.current);
    setHover({ fig, pos: { x: e.clientX, y: e.clientY } });
  };
  const onMove = (e) => {
    if (hover) setHover({ ...hover, pos: { x: e.clientX, y: e.clientY } });
  };
  const onLeave = () => {
    timer.current = setTimeout(() => setHover(null), 80);
  };

  const pack = catalog?.meta?.packaging || {};
  const figs = catalog?.figures.filter((f) => f.series === series) || [];

  return html`<div>
    <div class="finder-form">
      <div class="field">
        <label>Series</label>
        <select value=${series} onChange=${(e) => { setSeries(e.target.value); setResults(null); }}>
          <option value="">Pick a series</option>
          ${seriesList.map((s) => html`<option value=${s} key=${s}>${s}</option>`)}
        </select>
      </div>
      <div class="field">
        <label>Measured weight (g)</label>
        <input type="number" step="0.01" min="0" placeholder="41.20"
          value=${weight} onInput=${(e) => setWeight(e.target.value)} />
      </div>
      <div class="field">
        <label>How did you weigh it?</label>
        <div class="mode-toggle">
          <button class=${mode === "boxed" ? "active" : ""} onClick=${() => setMode("boxed")}>In box</button>
          <button class=${mode === "unboxed" ? "active" : ""} onClick=${() => setMode("unboxed")}>Unboxed</button>
        </div>
      </div>
      <button class="btn" onClick=${run} disabled=${!(series && weight)}>What is it?</button>
    </div>
    ${pack.box ? html`<div class="packnote">
      Packaging reference: box ≈ ${pack.box} g · yellow bag ≈ ${pack.yellow_bag} g ·
      single-series book ≈ ${pack.book_single} g · multi-series book ≈ ${pack.book_multi} g.
      Community data — weigh responsibly and follow store policies.
    </div>` : null}

    ${results ? html`<div class="results" onMouseMove=${onMove} onMouseLeave=${onLeave}>
      ${results.results.map((r, i) => {
        const fig = figByKey.get(r.key);
        return html`<div class="result ${i === 0 ? "top" : ""}" key=${r.key}
          onMouseEnter=${onHover({ ...r, tip: fig?.tip })}>
          <div class="thumb">
            ${r.image ? html`<img src="/images/${r.image}" loading="lazy" />` : html`<${Icon} name="package" size=${24} />`}
          </div>
          <div class="rbody">
            <div class="rname">
              ${r.is_secret ? html`<span class="secret-star"><${Icon} name="sparkles" size=${12} /></span> ` : ""}${r.name}
              ${ownedKeys.has(r.key) ? html`<span class="badge ok"><${Icon} name="check" size=${11} /> owned</span>` : null}
              ${wishKeys.has(r.key) ? html`<span class="badge wishb"><${Icon} name="heart" size=${11} /></span>` : null}
            </div>
            <div class="rstats">
              avg ${r.mean} g · ±${r.sd} g · ${r.n} data point${r.n === 1 ? "" : "s"}
              · ${r.delta > 0 ? "+" : ""}${r.delta} g off
            </div>
          </div>
          <div class="prob">
            <div class="pct">${r.likelihood}%</div>
            <div class="pbar"><div style="width:${Math.min(100, r.likelihood)}%"></div></div>
          </div>
        </div>`;
      })}
      ${results.no_data.length ? html`<div class="packnote">
        No weight data yet for: ${results.no_data.map((f) => f.name).join(", ")}
      </div>` : null}
      <div class="packnote">
        Likelihoods use Student-t predictive distributions from community measurements
        (${results.results.reduce((a, r) => a + r.n, 0)} data points in ${series}, ${mode}).
        Hover a row for tips & tricks.
      </div>
    </div>` : null}

    ${series && !results ? html`<div class="packnote">
      ${figs.length} figures in ${series} — enter a weight and hit the button
    </div>` : null}

    <${TipPop} fig=${hover?.fig} pos=${hover?.pos} />
  </div>`;
}

/* ------------------------------------------------------------------ app */

function App() {
  const [state, setState] = useCatalog();
  const [route, setRoute] = useState(location.hash.replace("#", "") || "/");
  useEffect(() => {
    const fn = () => setRoute(location.hash.replace("#", "") || "/");
    addEventListener("hashchange", fn);
    return () => removeEventListener("hashchange", fn);
  }, []);

  const refresh = useCallback(() => {
    $fetch("/api/collection").then((col) => {
      setState((s) => (s ? { ...s, logs: col.logs, wishlist: new Set(col.wishlist) } : s));
    });
  }, []);

  if (!state) return html`<div class="loading">Loading Smiski Landia…</div>`;
  if (state.error) return html`<div class="empty">${state.error}</div>`;

  return html`<div>
    <${Header} route=${route === "/stats" ? "stats" : route === "/finder" ? "finder" : "catalog"} />
    <main>
      ${route === "/stats"
        ? html`<${StatsPage} state=${state} />`
        : route === "/finder"
        ? html`<${FinderPage} />`
        : html`<${CatalogPage} state=${state} refresh=${refresh} />`}
    </main>
    <${Footer} meta=${state.meta} />
  </div>`;
}

render(html`<${App} />`, document.getElementById("app"));
