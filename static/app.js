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
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
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
  const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", quality));
  return { blob, w, h };
}

/* ----------------------------------------------------- weights privacy */

function useShowWeights() {
  const [show, setShow] = useState(localStorage.getItem("sl-weights") === "1");
  const toggle = useCallback(() => {
    setShow((s) => {
      localStorage.setItem("sl-weights", s ? "0" : "1");
      return !s;
    });
  }, []);
  return [show, toggle];
}

/** Weight value that respects privacy: hidden by default, tap to reveal one. */
function W({ v, boxed = true }) {
  const [revealed, setRevealed] = useState(false);
  const [show] = useShowWeights();
  if (v == null) return null;
  const icon = boxed ? "📦" : "🧽";
  if (show || revealed) {
    return html`<span class="weight" onClick=${(e) => { e.stopPropagation(); setRevealed(false); }}>
      ${icon} ${v.toFixed(1)} g
    </span>`;
  }
  return html`<span class="weight w-hidden" title="tap to reveal"
    onClick=${(e) => { e.stopPropagation(); setRevealed(true); }}>
    ${icon} •••• g
  </span>`;
}

/* ------------------------------------------------------------- catalog */

function useCatalog() {
  const [state, setState] = useState(null);
  useEffect(() => {
    Promise.all([$fetch("/api/catalog"), $fetch("/api/collection"), $fetch("/api/photos")])
      .then(([cat, col, ph]) => {
        const collection = {};
        for (const row of col) collection[row.key] = row;
        setState({ ...cat, collection, photos: new Set(ph.keys) });
      })
      .catch((e) => setState({ error: e.message }));
  }, []);
  return [state, setState];
}

/* ------------------------------------------------------------- header */

function Header({ route, showWeights, toggleWeights }) {
  const [busy, setBusy] = useState(false);
  const go = (r) => (e) => { e.preventDefault(); location.hash = r; };
  const doSync = async () => {
    setBusy(true);
    try {
      await $fetch("/api/sync", { method: "POST" });
      toast("Sheet re-synced ✨");
      location.reload();
    } catch (e) { toast("Sync failed: " + e.message); }
    setBusy(false);
  };
  return html`<header class="topbar">
    <div class="logo">🧏 Smiski Landia</div>
    <nav class="tabs">
      <a href="#/" onClick=${go("#/")} class=${route === "catalog" ? "active" : ""}>Collection</a>
      <a href="#/stats" onClick=${go("#/stats")} class=${route === "stats" ? "active" : ""}>Stats</a>
      <a href="#/finder" onClick=${go("#/finder")} class=${route === "finder" ? "active" : ""}>🔍 Finder</a>
    </nav>
    <button class="iconbtn" onClick=${toggleWeights} title="Toggle weight visibility">
      ${showWeights ? "👁️ Weights shown" : "🙈 Weights hidden"}
    </button>
    <button class="iconbtn" onClick=${doSync} disabled=${busy}>${busy ? "⏳" : "🔄"} Sync sheet</button>
  </header>`;
}

/* --------------------------------------------------------------- card */

function Card({ fig, col, hasPhoto, onOpen, onSet, onClear }) {
  const status = col?.status;
  const cls = status === "owned" ? "owned" : status === "wishlist" ? "wish" : "";
  return html`<div class="card ${cls}">
    <div class="imgwrap" onClick=${() => onOpen(fig)}>
      ${fig.image
        ? html`<img src="/images/${fig.image}" alt=${fig.name} loading="lazy" />`
        : html`<span class="placeholder">🫥</span>`}
    </div>
    <h4 onClick=${() => onOpen(fig)}>${fig.is_secret ? "✨ " : ""}${fig.name}</h4>
    <div class="meta">
      <span class="badge">${fig.series}</span>
      ${col?.count > 1 ? html`<span class="badge">×${col.count}</span>` : null}
      ${hasPhoto ? html`<span class="badge photo" title="You have a photo of this one">📷</span>` : null}
    </div>
    <div class="meta">
      <${W} v=${fig.avg_boxed} boxed=${true} />
      <${W} v=${fig.avg_unboxed} boxed=${false} />
    </div>
    <div class="actions">
      <button class="act ${status === "owned" ? "on-owned" : ""}" title="Owned"
        onClick=${() => (status === "owned" ? onClear(fig.key) : onSet(fig.key, "owned"))}>
        ${status === "owned" ? "✅" : "☑️"}
      </button>
      <button class="act ${status === "wishlist" ? "on-wish" : ""}" title="Wishlist"
        onClick=${() => (status === "wishlist" ? onClear(fig.key) : onSet(fig.key, "wishlist"))}>
        ${status === "wishlist" ? "💖" : "🤍"}
      </button>
    </div>
  </div>`;
}

/* ------------------------------------------------------- photo section */

function PhotoSection({ fig, hasPhoto, onUploaded, onDeleted }) {
  const [preview, setPreview] = useState(null); // object URL while uploading
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const inputRef = useRef(null);

  const upload = async (file) => {
    if (!file) return;
    setBusy(true); setErr(null);
    try {
      const { blob, w, h } = await compressImage(file);
      const body = new FormData();
      body.append("file", blob, "photo.jpg");
      const r = await fetch(`/api/photo/${fig.key}`, { method: "POST", body });
      if (!r.ok) throw new Error(await r.text());
      toast(`📷 Photo saved (${w}×${h}, ${(blob.size / 1024).toFixed(0)} KB)`);
      onUploaded();
    } catch (e) {
      setErr("Upload failed: " + e.message);
    }
    setPreview(null);
    setBusy(false);
    if (inputRef.current) inputRef.current.value = "";
  };

  const del = async () => {
    setBusy(true);
    await fetch(`/api/photo/${fig.key}`, { method: "DELETE" });
    setBusy(false);
    onDeleted();
  };

  if (hasPhoto) {
    return html`<div>
      <label>Your photo</label>
      <div class="photobox">
        <img class="photothumb" src="/photos/${fig.key}.jpg" alt="your photo of ${fig.name}"
          onClick=${() => window.open(`/photos/${fig.key}.jpg`, "_blank")} />
        <div class="row">
          <button class="btn secondary" onClick=${() => inputRef.current?.click()} disabled=${busy}>
            ${busy ? "⏳" : "🔄"} Replace
          </button>
          <button class="btn danger" onClick=${del} disabled=${busy}>🗑️ Delete</button>
        </div>
      </div>
      <input ref=${inputRef} type="file" accept="image/*" capture="environment" hidden
        onChange=${(e) => upload(e.target.files?.[0])} />
    </div>`;
  }

  return html`<div>
    <label>Your photo</label>
    <div class="photobox empty-photo">
      ${preview ? html`<img class="photothumb" src=${preview} />` : null}
      ${err ? html`<div style="color:#e5484d;font-size:12px;margin-bottom:6px">${err}</div>` : null}
      <button class="btn secondary" onClick=${() => inputRef.current?.click()} disabled=${busy}>
        ${busy ? "⏳ Uploading…" : "📷 Take / add photo"}
      </button>
      <input ref=${inputRef} type="file" accept="image/*" capture="environment" hidden
        onChange=${(e) => {
          const f = e.target.files?.[0];
          if (f) { setPreview(URL.createObjectURL(f)); upload(f); }
        }} />
      <div class="hint">Compressed to ~1280px JPEG before saving (~100–300 KB)</div>
    </div>
  </div>`;
}

/* --------------------------------------------------------------- modal */

function Detail({ fig, col, hasPhoto, onPhotoChange, onClose, onSave, onClear }) {
  const [status, setStatus] = useState(col?.status || "");
  const [count, setCount] = useState(col?.count ?? 1);
  const [date, setDate] = useState(
    col?.acquired_date || (col?.status === "owned" ? "" : new Date().toISOString().slice(0, 10))
  );
  const [note, setNote] = useState(col?.note || "");
  return html`<div class="overlay" onClick=${onClose}>
    <div class="modal" onClick=${(e) => e.stopPropagation()}>
      <button class="closex" onClick=${onClose}>✕</button>
      <div class="mimg">
        ${fig.image
          ? html`<img src="/images/${fig.image}" alt=${fig.name} />`
          : html`<div style="font-size:64px;text-align:center">🫥</div>`}
        <div style="margin-top:10px">
          <${PhotoSection} fig=${fig} hasPhoto=${hasPhoto}
            onUploaded=${onPhotoChange} onDeleted=${onPhotoChange} />
        </div>
      </div>
      <div class="mbody">
        <h2>${fig.is_secret ? "✨ " : ""}${fig.name}</h2>
        <div class="meta">
          <span class="badge">${fig.series}</span>
          ${fig.is_secret ? html`<span class="badge secret">SECRET</span>` : null}
        </div>
        <div class="meta" style="gap:10px">
          <${W} v=${fig.avg_boxed} />
          <${W} v=${fig.avg_unboxed} boxed=${false} />
          <span style="font-size:11.5px;color:var(--muted)">
            (${fig.n_boxed || 0} boxed / ${fig.n_unboxed || 0} unboxed data points)
          </span>
        </div>
        ${fig.tip ? html`<div class="tipbox">💡 <b>Tips & tricks:</b>\n${fig.tip}</div>` : null}
        <div>
          <label>Status</label>
          <div class="mode-toggle">
            ${["owned", "wishlist", ""].map((s) => html`<button
              class=${status === s ? "active" : ""}
              onClick=${() => setStatus(s)}>
              ${s === "owned" ? "✅ Owned" : s === "wishlist" ? "🤍 Wishlist" : "— None —"}
            </button>`)}
          </div>
        </div>
        <div class="row">
          <div style="flex:1">
            <label>Duplicates (incl. first)</label>
            <div class="row">
              <button class="iconbtn" onClick=${() => setCount(Math.max(1, count - 1))}>−</button>
              <b style="font-size:17px">${count}</b>
              <button class="iconbtn" onClick=${() => setCount(count + 1)}>+</button>
            </div>
          </div>
          <div style="flex:1">
            <label>Date acquired</label>
            <input type="date" value=${date} onInput=${(e) => setDate(e.target.value)} />
          </div>
        </div>
        <div>
          <label>Note</label>
          <textarea value=${note} onInput=${(e) => setNote(e.target.value)}
            placeholder="Where you found it, who picked it, condition…"></textarea>
        </div>
        <div class="row" style="justify-content:flex-end">
          <button class="btn danger" onClick=${() => { onClear(fig.key); onClose(); }}>Remove</button>
          <button class="btn" onClick=${() => { onSave(fig.key, { status: status || null, count, acquired_date: date || null, note: note || null }); onClose(); }}>
            Save
          </button>
        </div>
      </div>
    </div>
  </div>`;
}

/* --------------------------------------------------------- catalog page */

function CatalogPage({ state, setState, refresh }) {
  const [q, setQ] = useState("");
  const [series, setSeries] = useState("All");
  const [tab, setTab] = useState("all");
  const [open, setOpen] = useState(null);

  const seriesList = useMemo(() => {
    const seen = new Map();
    for (const f of state.figures) if (!seen.has(f.series)) seen.set(f.series, 0);
    for (const f of state.figures)
      if (state.collection[f.key]?.status === "owned") seen.set(f.series, seen.get(f.series) + 1);
    return [...seen.keys()];
  }, [state]);

  const figs = useMemo(() => {
    let list = state.figures;
    if (series !== "All") list = list.filter((f) => f.series === series);
    if (tab === "owned") list = list.filter((f) => state.collection[f.key]?.status === "owned");
    if (tab === "wishlist") list = list.filter((f) => state.collection[f.key]?.status === "wishlist");
    if (tab === "missing") list = list.filter((f) => state.collection[f.key]?.status !== "owned");
    if (q.trim()) {
      const n = q.trim().toLowerCase();
      list = list.filter((f) => f.name.toLowerCase().includes(n) || f.series.toLowerCase().includes(n));
    }
    return list;
  }, [state, q, series, tab]);

  const onSet = async (key, status) => {
    const fig = state.figures.find((f) => f.key === key);
    if (status === "owned") {
      const inSeries = state.figures.filter((f) => f.series === fig.series);
      const othersOwned = inSeries.filter(
        (f) => f.key !== key && state.collection[f.key]?.status === "owned"
      ).length;
      if (inSeries.length > 1 && othersOwned === inSeries.length - 1) {
        toast(`🎉 ${fig.series} complete!`);
      }
    }
    await $fetch(`/api/collection/${key}`, {
      method: "PUT",
      body: JSON.stringify({
        status,
        count: 1,
        acquired_date: status === "owned" ? new Date().toISOString().slice(0, 10) : null,
      }),
    });
    refresh();
  };

  const onClear = async (key) => {
    await $fetch(`/api/collection/${key}`, { method: "DELETE" });
    refresh();
  };

  const onSave = async (key, body) => {
    await $fetch(`/api/collection/${key}`, { method: "PUT", body: JSON.stringify(body) });
    refresh();
  };

  const onPhotoChange = async () => {
    const ph = await $fetch("/api/photos");
    setState((s) => ({ ...s, photos: new Set(ph.keys) }));
  };

  return html`<div>
    <div class="controls">
      <input type="search" placeholder="Search smiskis…" value=${q} onInput=${(e) => setQ(e.target.value)} />
      <div class="mode-toggle">
        ${[["all", "All"], ["owned", "✅ Owned"], ["wishlist", "🤍 Wishlist"], ["missing", "🕳️ Missing"]].map(([k, l]) => html`
          <button class=${tab === k ? "active" : ""} onClick=${() => setTab(k)}>${l}</button>`)}
      </div>
    </div>
    <div class="chips">
      <button class="chip ${series === "All" ? "active" : ""}" onClick=${() => setSeries("All")}>All series</button>
      ${seriesList.map((s) => html`
        <button class="chip ${series === s ? "active" : ""}" onClick=${() => setSeries(s)}>${s}</button>`)}
    </div>
    ${figs.length === 0
      ? html`<div class="empty">Nothing here ${tab === "wishlist" ? "— go hunting! 🧭" : "😶‍🌫️"}</div>`
      : html`<div class="grid">
          ${figs.map((f) => html`<${Card} key=${f.key} fig=${f} col=${state.collection[f.key]}
            hasPhoto=${state.photos.has(f.key)}
            onOpen=${setOpen} onSet=${onSet} onClear=${onClear} />`)}
        </div>`}
    ${open && html`<${Detail} fig=${open} col=${state.collection[open.key]}
      hasPhoto=${state.photos.has(open.key)} onPhotoChange=${onPhotoChange}
      onClose=${() => setOpen(null)} onSave=${onSave} onClear=${onClear} />`}
  </div>`;
}

/* ----------------------------------------------------------- stats page */

function StatsPage({ state }) {
  const bySeries = useMemo(() => {
    const m = new Map();
    for (const f of state.figures) {
      if (!m.has(f.series)) m.set(f.series, { total: 0, owned: 0, wish: 0, secretsTotal: 0, secretsOwned: 0, dupes: 0, photos: 0 });
      const s = m.get(f.series);
      s.total++;
      if (f.is_secret) s.secretsTotal++;
      const c = state.collection[f.key];
      if (c?.status === "owned") {
        s.owned++;
        s.dupes += (c.count || 1) - 1;
        if (f.is_secret) s.secretsOwned++;
      }
      if (c?.status === "wishlist") s.wish++;
      if (state.photos.has(f.key)) s.photos++;
    }
    return [...m.entries()].sort((a, b) => b[1].owned / b[1].total - a[1].owned / a[1].total);
  }, [state]);

  const total = state.figures.length;
  const owned = state.figures.filter((f) => state.collection[f.key]?.status === "owned").length;
  const ownedDupes = bySeries.reduce((a, [, s]) => a + s.dupes, 0);
  const wish = state.figures.filter((f) => state.collection[f.key]?.status === "wishlist").length;
  const secretsOwned = bySeries.reduce((a, [, s]) => a + s.secretsOwned, 0);
  const photos = bySeries.reduce((a, [, s]) => a + s.photos, 0);
  const pct = total ? Math.round((owned / total) * 100) : 0;

  return html`<div>
    <div class="statgrid">
      <div class="stat"><div class="v">${owned}<span style="font-size:14px;color:var(--muted)">/${total}</span></div><div class="k">Smiskis collected</div></div>
      <div class="stat"><div class="v">${pct}%</div><div class="k">Overall completion</div></div>
      <div class="stat"><div class="v">${ownedDupes}</div><div class="k">Duplicates</div></div>
      <div class="stat"><div class="v">${secretsOwned} ✨</div><div class="k">Secrets found</div></div>
      <div class="stat"><div class="v">${wish} 🤍</div><div class="k">On the wishlist</div></div>
      <div class="stat"><div class="v">${photos} 📷</div><div class="k">Photos logged</div></div>
    </div>
    ${bySeries.map(([name, s]) => html`
      <div class="srow" key=${name}>
        <div class="top">
          <span>${name}</span>
          <span class="cnt">${s.owned}/${s.total}${s.secretsTotal ? ` · ✨ ${s.secretsOwned}/${s.secretsTotal}` : ""}${s.wish ? ` · 🤍 ${s.wish}` : ""}${s.photos ? ` · 📷 ${s.photos}` : ""}</span>
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
    <div class="ttp-head">💡 ${fig.name}${fig.is_secret ? " ✨" : ""}</div>
    ${fig.tip || "No tips & tricks recorded for this one yet."}
  </div>`;
}

function FinderPage() {
  const [catalog, setCatalog] = useState(null);
  const [collection, setCollection] = useState({});
  const [series, setSeries] = useState("");
  const [weight, setWeight] = useState("");
  const [mode, setMode] = useState("boxed");
  const [results, setResults] = useState(null);
  const [hover, setHover] = useState(null); // { fig, pos }
  const timer = useRef(null);

  useEffect(() => {
    $fetch("/api/catalog").then(setCatalog);
    $fetch("/api/collection").then((col) => {
      const m = {};
      for (const r of col) m[r.key] = r;
      setCollection(m);
    });
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
          <option value="">Pick a series…</option>
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
          <button class=${mode === "boxed" ? "active" : ""} onClick=${() => setMode("boxed")}>📦 In box</button>
          <button class=${mode === "unboxed" ? "active" : ""} onClick=${() => setMode("unboxed")}>🧽 Unboxed</button>
        </div>
      </div>
      <button class="btn" onClick=${run} disabled=${!(series && weight)}>What is it? 🔮</button>
    </div>
    ${pack.box ? html`<div class="packnote">
      Packaging reference from the sheet: box ≈ ${pack.box} g · yellow bag ≈ ${pack.yellow_bag} g ·
      single-series book ≈ ${pack.book_single} g · multi-series book ≈ ${pack.book_multi} g.
      Community data — weigh responsibly and follow store policies 🫶
    </div>` : null}

    ${results ? html`<div class="results" onMouseMove=${onMove} onMouseLeave=${onLeave}>
      ${results.results.map((r, i) => {
        const fig = figByKey.get(r.key);
        const col = collection[r.key];
        return html`<div class="result ${i === 0 ? "top" : ""}" key=${r.key}
          onMouseEnter=${onHover({ ...r, tip: fig?.tip })}>
          <div class="thumb">
            ${r.image ? html`<img src="/images/${r.image}" loading="lazy" />` : "🫥"}
          </div>
          <div class="rbody">
            <div class="rname">
              ${r.is_secret ? "✨ " : ""}${r.name}
              ${col?.status === "owned" ? html`<span class="badge">✅ owned</span>` : null}
              ${col?.status === "wishlist" ? html`<span class="badge">🤍 wishlist</span>` : null}
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
        Hover a row for tips & tricks 💡
      </div>
    </div>` : null}

    ${series && !results ? html`<div class="packnote">
      ${figs.length} figures in ${series} — enter a weight and hit the button 🔮
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
  const [showWeights, toggleWeights] = useShowWeights();

  const refresh = useCallback(() => {
    $fetch("/api/collection").then((col) => {
      const collection = {};
      for (const row of col) collection[row.key] = row;
      setState((s) => (s ? { ...s, collection } : s));
    });
  }, []);

  if (!state) return html`<div class="loading">🧏 Loading Smiski Landia…</div>`;
  if (state.error) return html`<div class="empty">⚠️ ${state.error}</div>`;

  return html`<div>
    <${Header} route=${route === "/stats" ? "stats" : route === "/finder" ? "finder" : "catalog"}
      showWeights=${showWeights} toggleWeights=${toggleWeights} />
    <main>
      ${route === "/stats"
        ? html`<${StatsPage} state=${state} />`
        : route === "/finder"
        ? html`<${FinderPage} />`
        : html`<${CatalogPage} state=${state} setState=${setState} refresh=${refresh} />`}
    </main>
  </div>`;
}

render(html`<${App} />`, document.getElementById("app"));
