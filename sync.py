#!/usr/bin/env python3
"""Smiski Landia — ETL sync script.

Downloads the community Smiski weights Google Sheet (.xlsx export), parses the
catalog (series, figures, average weights, raw samples, images, tips), and
upserts it into data/app.db while preserving your collection state.

Usage:
    python3 sync.py            # download fresh sheet + sync
    python3 sync.py --offline  # reuse data/sheet.xlsx
"""

import argparse
import difflib
import json
import re
import shutil
import sqlite3
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import openpyxl

SHEET_ID = "1U4l4ugaL8UG7wzEfQqQ1h_oYYX0s0tGpqw9XV_cxnms"
XLSX_URL = f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/export?format=xlsx"

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
DB_PATH = DATA / "app.db"
XLSX_PATH = DATA / "sheet.xlsx"
IMG_DIR = DATA / "images"

# Column groups in the "2. Weights" tab (0-based start columns).
WEIGHT_GROUPS = [0, 7, 14, 21]
SKIP_SERIES = {"template"}

# Canonical spellings for series names that vary between tabs.
SERIES_CANON = {
    "toilet series": "Toilet Series",
    "toliet series": "Toilet Series",
    "work series": "Work Series",
    "@ work series": "Work Series",
    "exercising series": "Exercising Series",
    "exercise series": "Exercising Series",
    "excercise series": "Exercising Series",
    "excersice series": "Exercising Series",
    "hipper series": "Hippers",
    "hippers": "Hippers",
    "smiski strap s1": "Smiski Strap - S1",
    "smiski strap s2": "Smiski Strap - S2",
    "smiski strap s3": "Smiski Strap - S3",
}


def norm(s: str) -> str:
    """Lowercase, collapse whitespace/punctuation — for fuzzy matching."""
    return re.sub(r"[^a-z0-9]+", " ", str(s).lower()).strip()


def canon_series(name: str) -> str:
    n = norm(name)
    if n in SERIES_CANON:
        return SERIES_CANON[n]
    return re.sub(r"\s+", " ", str(name).strip()).title() if n else name


def clean_name(raw: str) -> tuple[str, bool]:
    """Strip SECRET markers / quotes / newlines. Returns (name, is_secret)."""
    s = str(raw)
    is_secret = bool(re.search(r"secret", s, re.I))
    s = re.sub(r"secret", "", s, flags=re.I)
    s = s.replace("\n", " ").replace('"', "").replace("'", "")
    s = re.sub(r"\s+", " ", s).strip(" -*.")
    return s.strip(), is_secret


def slugify(s: str) -> str:
    return re.sub(r"-{2,}", "-", re.sub(r"[^a-z0-9]+", "-", s.lower())).strip("-")


def fuzzy_find(haystack: dict, needle: str, floor=0.72):
    """Find best match for `needle` (normalized) among keys of `haystack`."""
    n = norm(needle)
    if n in haystack:
        return haystack[n]
    best, best_score = None, 0.0
    for k, v in haystack.items():
        score = difflib.SequenceMatcher(None, n, k).ratio()
        if score > best_score:
            best, best_score = v, score
    return best if best_score >= floor else None


# ---------------------------------------------------------------- sheet load

def download_sheet():
    DATA.mkdir(exist_ok=True)
    print(f"Downloading sheet from Google…")
    req = urllib.request.Request(XLSX_URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as resp, open(XLSX_PATH, "wb") as f:
        shutil.copyfileobj(resp, f)
    print(f"Saved {XLSX_PATH} ({XLSX_PATH.stat().st_size / 1e6:.1f} MB)")


# ---------------------------------------------------------------- parsing

def parse_weights_tab(wb):
    """Grid of series blocks -> list of figure dicts (no samples yet)."""
    ws = wb["2. Weights"]
    rows = list(ws.iter_rows(max_col=27, values_only=True))
    figures = []
    for ci in WEIGHT_GROUPS:
        r = 3
        while r < len(rows):
            v = rows[r][ci] if ci < len(rows[r]) else None
            nxt = rows[r][ci + 1] if ci + 1 < len(rows[r]) else None
            is_block = (
                v is not None
                and str(v).strip()
                and (nxt is None or "Picture" in str(nxt))
            )
            if not is_block:
                r += 1
                continue
            series = canon_series(str(v).strip())
            # header row tells us the column offsets
            hdr = [str(x) if x is not None else "" for x in rows[r][ci : ci + 7]]
            try:
                off_box = next(i for i, h in enumerate(hdr) if "w/ box" in h)
                off_unbox = next(i for i, h in enumerate(hdr) if "w/o box" in h)
            except StopIteration:
                r += 1
                continue
            off_nbox = off_box + 1 if "Data Points" in hdr[off_box + 1 : off_box + 2] else None
            off_nunbox = off_unbox + 1 if "Data Points" in hdr[off_unbox + 1 : off_unbox + 2] else None
            rr = r + 1
            while rr < len(rows):
                nv = rows[rr][ci] if ci < len(rows[rr]) else None
                if nv is None or not str(nv).strip():
                    break
                name, is_secret = clean_name(nv)
                if name and series not in SKIP_SERIES:
                    def cell(rw, off):
                        try:
                            x = rows[rw][ci + off]
                        except IndexError:
                            x = None
                        return float(x) if isinstance(x, (int, float)) else None

                    figures.append(
                        {
                            "series": series,
                            "name": name,
                            "is_secret": is_secret,
                            "row": rr,  # 0-based row for image anchoring
                            "pic_col": ci + 1,
                            "avg_boxed": cell(rr, off_box),
                            "n_boxed": int(cell(rr, off_nbox) or 0) if off_nbox else None,
                            "avg_unboxed": cell(rr, off_unbox),
                            "n_unboxed": int(cell(rr, off_nunbox) or 0) if off_nunbox else None,
                        }
                    )
                rr += 1
            r = rr
    return figures


def parse_data_tab(wb):
    """Tidy tab: raw samples per (series, figure, mode)."""
    ws = wb["6. Data"]
    rows = list(ws.iter_rows(values_only=True))
    samples = {}  # (series, name, 'boxed'|'unboxed') -> [floats]
    current_series = None
    current_fig = None
    for r in rows[1:]:
        a, b, c = r[0], r[1], r[2]
        if a is not None and str(a).strip():
            current_series = norm(canon_series(str(a)))
        if b is not None and str(b).strip():
            current_fig = clean_name(str(b))[0]
        if c is None:
            continue
        mode = "boxed" if "w/ box" in str(c) else ("unboxed" if "w/o box" in str(c) else None)
        if not mode or current_series is None or current_fig is None:
            continue
        vals = []
        for x in r[5:]:  # samples start after Average + Data Points cols
            if isinstance(x, (int, float)):
                vals.append(round(float(x), 4))
        key = (current_series, norm(current_fig), mode)
        samples.setdefault(key, [])
        if vals:
            samples[key].extend(vals)
    return samples


def parse_tips_tab(wb):
    """Tips + Tricks: rows of (series, figure, tip)."""
    ws = wb["3. Tips + Tricks"]
    tips = []
    for r in ws.iter_rows(max_col=4, values_only=True):
        series, fig, tip = r[0], r[1], r[3]
        if not (series and fig and tip):
            continue
        s = canon_series(str(series))
        if s.lower() in ("series", "series (secrets)", "series name"):
            continue
        f, _ = clean_name(fig)
        tips.append({"series": s, "name": f, "tip": str(tip).strip()})
    return tips


def parse_packaging(wb):
    ws = wb["2. Weights"]
    rows = list(ws.iter_rows(max_row=2, max_col=27, values_only=True))
    def grab(rx):
        m = re.search(r"([\d.]+)\s*g", str(rx))
        return float(m.group(1)) if m else None
    return {
        "box": grab(rows[0][7]),
        "yellow_bag": grab(rows[0][8]),
        "book_single": grab(rows[1][7]),
        "book_multi": grab(rows[1][8]),
    }


def parse_sheet_updated(wb):
    ws = wb["1. Welcome Page"]
    for row in ws.iter_rows(max_row=12, max_col=3, values_only=True):
        for c in row:
            if c and "Last Updated" in str(c):
                m = re.search(r"(\d{2})\.(\d{2})\.(\d{4})", str(c))
                if m:
                    return f"{m.group(3)}-{m.group(2)}-{m.group(1)}"
    return None


# ---------------------------------------------------------------- images

def extract_images(xlsx_path: Path, figures):
    """Map anchored pictures from the Weights tab drawing to figures."""
    z = zipfile.ZipFile(xlsx_path)
    # drawing2.xml belongs to sheet2 ("2. Weights"); resolve via workbook rels
    rels = z.read("xl/_rels/workbook.xml.rels").decode()
    relmap = dict(re.findall(r'Id="(rId\d+)"[^>]*Target="([^"]+)"', rels))
    wbxml = z.read("xl/workbook.xml").decode()
    sheet_rid = dict(re.findall(r'<sheet[^>]*name="([^"]+)"[^>]*r:id="(rId\d+)"', wbxml))["2. Weights"]
    sheet_target = relmap[sheet_rid]  # worksheets/sheet2.xml
    sheet_rels_path = f"xl/worksheets/_rels/{Path(sheet_target).name}.rels"
    srels = z.read(sheet_rels_path).decode()
    m = re.search(r'Target="\.\./(drawings/drawing\d+\.xml)"', srels)
    if not m:
        print("No drawing found for Weights tab"); return
    drawing = "xl/" + m.group(1)
    dxml = z.read(drawing).decode("utf-8", "ignore")
    drels = z.read(f"xl/drawings/_rels/{Path(drawing).name}.rels").decode()
    media = dict(re.findall(r'Id="(rId\d+)"[^>]*Target="\.\./media/([^"]+)"', drels))

    anchors = []
    for mm in re.finditer(
        r"<xdr:from><xdr:col>(\d+)</xdr:col>.*?<xdr:row>(\d+)</xdr:row>.*?r:embed=\"(rId\d+)\"",
        dxml, re.S,
    ):
        anchors.append((int(mm.group(1)), int(mm.group(2)), mm.group(3)))

    IMG_DIR.mkdir(parents=True, exist_ok=True)
    by_cell = {}
    for f in figures:
        by_cell[(f["pic_col"], f["row"])] = f
    hit = 0
    for col, row, rid in anchors:
        f = by_cell.get((col, row))
        if not f or f.get("image"):
            continue
        fname = media.get(rid)
        if not fname:
            continue
        slug = f"{slugify(f['series'])}-{slugify(f['name'])}.png"
        try:
            with z.open(f"xl/media/{fname}") as src, open(IMG_DIR / slug, "wb") as dst:
                shutil.copyfileobj(src, dst)
            f["image"] = slug
            hit += 1
        except KeyError:
            pass
    print(f"Extracted {hit} images for {len(figures)} figures")


# ---------------------------------------------------------------- merge + db

def merge(figures, samples, tips):
    """Attach raw samples + tips to figures via fuzzy matching."""
    fig_index = {}
    for f in figures:
        fig_index.setdefault(norm(f["series"]), {})[norm(f["name"])] = f
    tip_index = {}
    for t in tips:
        tip_index.setdefault(norm(t["series"]), {})[norm(t["name"])] = t

    stats = {"samples_matched": 0, "tips_matched": 0}
    for (series, name, mode), vals in samples.items():
        f = fuzzy_find(fig_index.get(series, {}), name)
        if f:
            f[f"samples_{mode}"] = sorted(set(vals))
            stats["samples_matched"] += 1
    for series, name_map in tip_index.items():
        for name, t in name_map.items():
            f = fuzzy_find(fig_index.get(series, {}), name)
            if f and not f.get("tip"):
                f["tip"] = t["tip"]
                stats["tips_matched"] += 1
    return stats


def init_db(conn):
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS catalog (
            id INTEGER PRIMARY KEY,
            key TEXT UNIQUE NOT NULL,
            series TEXT NOT NULL,
            series_order INTEGER,
            name TEXT NOT NULL,
            is_secret INTEGER DEFAULT 0,
            avg_boxed REAL, n_boxed INTEGER,
            avg_unboxed REAL, n_unboxed INTEGER,
            samples_boxed TEXT, samples_unboxed TEXT,
            image TEXT, tip TEXT
        );
        CREATE TABLE IF NOT EXISTS logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            key TEXT NOT NULL,
            acquired_date TEXT,
            note TEXT,
            has_photo INTEGER DEFAULT 0,
            created_at TEXT
        );
        CREATE TABLE IF NOT EXISTS wishlist (
            key TEXT PRIMARY KEY
        );
        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY, value TEXT
        );
        """
    )


def upsert(conn, figures, sheet_updated):
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    conn.execute("DELETE FROM catalog")
    for i, f in enumerate(figures):
        key = f"{slugify(f['series'])}-{slugify(f['name'])}"
        sb, su = f.get("samples_boxed") or [], f.get("samples_unboxed") or []
        conn.execute(
            "INSERT OR REPLACE INTO catalog VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                i + 1, key, f["series"], i, f["name"], int(f["is_secret"]),
                f.get("avg_boxed"), f.get("n_boxed") or (len(sb) or None),
                f.get("avg_unboxed"), f.get("n_unboxed") or (len(su) or None),
                json.dumps(sb), json.dumps(su),
                f.get("image"), f.get("tip"),
            ),
        )
    conn.execute("INSERT OR REPLACE INTO meta VALUES ('sheet_updated', ?)", (sheet_updated or "",))
    conn.execute("INSERT OR REPLACE INTO meta VALUES ('synced_at', ?)", (now,))
    conn.execute("INSERT OR REPLACE INTO meta VALUES ('figure_count', ?)", (str(len(figures)),))
    conn.commit()


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--offline", action="store_true", help="reuse data/sheet.xlsx")
    args = ap.parse_args()

    if not args.offline or not XLSX_PATH.exists():
        download_sheet()

    wb = openpyxl.load_workbook(XLSX_PATH, read_only=True, data_only=True)
    figures = parse_weights_tab(wb)
    samples = parse_data_tab(wb)
    tips = parse_tips_tab(wb)
    packaging = parse_packaging(wb)
    sheet_updated = parse_sheet_updated(wb)
    print(f"Parsed {len(figures)} figures, {len(samples)} sample rows, {len(tips)} tips")

    stats = merge(figures, samples, tips)
    print(f"Matched: {stats}")

    extract_images(XLSX_PATH, figures)

    DATA.mkdir(exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    init_db(conn)
    upsert(conn, figures, sheet_updated)
    conn.execute(
        "INSERT OR REPLACE INTO meta VALUES ('packaging', ?)",
        (json.dumps(packaging),),
    )
    conn.commit()
    total = conn.execute("SELECT COUNT(*) FROM catalog").fetchone()[0]
    owned = conn.execute("SELECT COUNT(*) FROM logs").fetchone()[0]
    print(f"DB ready: {total} figures in catalog, {owned} logged. Sheet updated: {sheet_updated}")
    conn.close()


if __name__ == "__main__":
    main()
