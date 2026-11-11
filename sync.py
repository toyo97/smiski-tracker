#!/usr/bin/env python3
"""Smiski Landia — ETL sync script.

Downloads the community Smiski weights Google Sheet (.xlsx export), parses the
catalog (series, figures, average weights, raw samples, images, tips), and
upserts it into data/app.db while preserving your collection state.

Robustness rules (learned the hard way — see CHANGELOG 1.1.0):
  * block/series positions are discovered from the sheet headers, never
    hard-coded, so inserted rows/columns and new series are handled;
  * a sync that would produce zero figures, suspiciously few figures, or
    mostly missing images is rejected and the existing catalog is kept;
  * the catalog is replaced in a single transaction, after a db backup.

Usage:
    python3 sync.py            # download fresh sheet + sync
    python3 sync.py --offline  # reuse data/sheet.xlsx
"""

import argparse
import difflib
import json
import os
import re
import shutil
import sqlite3
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import openpyxl

SHEET_ID = "1U4l4ugaL8UG7wzEfQqQ1h_oYYX0s0tGpqw9XV_cxnms"
# override to sync from your own copy of the spreadsheet
XLSX_URL = os.environ.get(
    "SMISKI_XLSX_URL",
    f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/export?format=xlsx",
)

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
DB_PATH = DATA / "app.db"
DB_BACKUP = DATA / "app.db.bak"
XLSX_PATH = DATA / "sheet.xlsx"
IMG_DIR = DATA / "images"

WEIGHTS_TAB = "2. Weights"
DATA_TAB = "6. Data"
TIPS_TAB = "3. Tips + Tricks"
WELCOME_TAB = "1. Welcome Page"

SKIP_SERIES = {"template"}
MAX_SCAN_COL = 60

# Safety gates: a sync producing less than this share of the current catalog,
# or images for less than this share of parsed figures, is rejected.
MIN_FIGURE_RATIO = 0.5
MIN_IMAGE_RATIO = 0.5

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


class SyncError(Exception):
    """Raised when a sync cannot be completed safely."""


def norm(s: str) -> str:
    """Lowercase, collapse whitespace/punctuation — for fuzzy matching."""
    return re.sub(r"[^a-z0-9]+", " ", str(s).lower()).strip()


def canon_series(name: str) -> str:
    n = norm(name)
    if n in SERIES_CANON:
        return SERIES_CANON[n]
    return re.sub(r"\s+", " ", str(name).strip()) if n else name


def clean_name(raw: str) -> tuple[str, bool]:
    """Strip SECRET markers / quotes / newlines. Returns (name, is_secret)."""
    s = str(raw)
    is_secret = bool(re.search(r"secret|sercret", s, re.I))
    s = re.sub(r"secret|sercret", "", s, flags=re.I)
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


def cell(rows, ri, ci):
    if ri < 0 or ri >= len(rows):
        return None
    r = rows[ri]
    return r[ci] if ci < len(r) else None


def to_float(x):
    if isinstance(x, (int, float)):
        return float(x)
    if isinstance(x, str):
        m = re.search(r"([\d.]+)", x)
        if m:
            try:
                return float(m.group(1))
            except ValueError:
                return None
    return None


# ---------------------------------------------------------------- sheet load

def download_sheet(dest: Path):
    """Download the xlsx export to `dest`, validating that it is a workbook."""
    DATA.mkdir(exist_ok=True)
    dest.unlink(missing_ok=True)
    print("Downloading sheet from Google…")
    req = urllib.request.Request(XLSX_URL, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp, open(dest, "wb") as f:
            shutil.copyfileobj(resp, f)
    except Exception as e:
        dest.unlink(missing_ok=True)
        raise SyncError(f"download failed: {e}") from e
    if not zipfile.is_zipfile(dest):
        dest.unlink(missing_ok=True)
        raise SyncError("download is not a valid .xlsx (sheet not shared? rate limited?)")
    with zipfile.ZipFile(dest) as z:
        if "xl/worksheets/sheet1.xml" not in z.namelist():
            dest.unlink(missing_ok=True)
            raise SyncError("downloaded workbook looks malformed")
    print(f"Downloaded {dest.stat().st_size / 1e6:.1f} MB")


def open_sheet(path: Path):
    if not path.exists():
        raise SyncError("no cached sheet and offline mode requested")
    if not zipfile.is_zipfile(path):
        raise SyncError("cached sheet is corrupt — run without --offline to re-download")
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    missing = [t for t in (WEIGHTS_TAB, DATA_TAB) if t not in wb.sheetnames]
    if missing:
        raise SyncError(
            f"expected sheet tab(s) missing: {', '.join(missing)} — "
            f"found: {', '.join(wb.sheetnames)}"
        )
    return wb


# ---------------------------------------------------------------- parsing

def find_blocks(rows):
    """Locate series blocks anywhere in the grid.

    A block header is a non-empty cell whose right neighbour is a "Picture"
    header and which is followed by "Avg w/ box" within a few columns. Column
    offsets are derived from that header row, so the layout may shift.
    """
    blocks = []
    for ri, r in enumerate(rows):
        for ci in range(min(len(r), MAX_SCAN_COL)):
            head = cell(rows, ri, ci)
            if head is None or not str(head).strip():
                continue
            nxt = cell(rows, ri, ci + 1)
            if nxt is None or "picture" not in str(nxt).lower():
                continue
            hdr = [str(cell(rows, ri, ci + i) or "") for i in range(8)]
            off_box = next((i for i, h in enumerate(hdr) if "w/ box" in h), None)
            off_unbox = next((i for i, h in enumerate(hdr) if "w/o box" in h), None)
            if off_box is None or off_unbox is None:
                continue
            # figure rows run downwards until the name column goes blank
            figs = []
            rr = ri + 1
            while rr < len(rows):
                name = cell(rows, rr, ci)
                if name is None or not str(name).strip():
                    break
                figs.append((rr, str(name)))
                rr += 1
            blocks.append(
                {
                    "row": ri,
                    "col": ci,
                    "series": canon_series(str(head).strip()),
                    "off_box": off_box,
                    "off_unbox": off_unbox,
                    "off_nbox": off_box + 1 if "data point" in hdr[off_box + 1].lower() else None,
                    "off_nunbox": off_unbox + 1 if "data point" in hdr[off_unbox + 1].lower() else None,
                    "figs": figs,
                }
            )
    return blocks


def parse_weights_tab(wb):
    ws = wb[WEIGHTS_TAB]
    rows = list(ws.iter_rows(max_col=MAX_SCAN_COL, values_only=True))
    figures = []
    for b in find_blocks(rows):
        series = b["series"]
        if norm(series) in SKIP_SERIES or not b["figs"]:
            continue
        for rr, raw_name in b["figs"]:
            name, is_secret = clean_name(raw_name)
            if not name:
                continue
            figures.append(
                {
                    "series": series,
                    "name": name,
                    "is_secret": is_secret,
                    "row": rr,  # 0-based row, for image anchoring
                    "pic_col": b["col"] + 1,
                    "avg_boxed": to_float(cell(rows, rr, b["col"] + b["off_box"])),
                    "n_boxed": int(to_float(cell(rows, rr, b["col"] + b["off_nbox"])) or 0)
                    if b["off_nbox"] is not None
                    else None,
                    "avg_unboxed": to_float(cell(rows, rr, b["col"] + b["off_unbox"])),
                    "n_unboxed": int(to_float(cell(rows, rr, b["col"] + b["off_nunbox"])) or 0)
                    if b["off_nunbox"] is not None
                    else None,
                }
            )
    return figures


def parse_data_tab(wb):
    """Tidy tab: raw samples per (series, figure, mode)."""
    if DATA_TAB not in wb.sheetnames:
        return {}
    ws = wb[DATA_TAB]
    rows = list(ws.iter_rows(max_col=100, values_only=True))
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
        vals = [round(v, 4) for v in (to_float(x) for x in r[5:]) if v is not None]
        key = (current_series, norm(current_fig), mode)
        samples.setdefault(key, [])
        if vals:
            samples[key].extend(vals)
    return samples


def parse_tips_tab(wb):
    """Tips + Tricks: rows of (series, figure, tip)."""
    if TIPS_TAB not in wb.sheetnames:
        return []
    ws = wb[TIPS_TAB]
    tips = []
    for r in ws.iter_rows(max_col=4, values_only=True):
        series, fig, tip = r[0], r[1], r[3]
        if not (series and fig and tip):
            continue
        s = canon_series(str(series))
        if norm(s) in ("series", "series secrets", "series name"):
            continue
        f, _ = clean_name(fig)
        tips.append({"series": s, "name": f, "tip": str(tip).strip()})
    return tips


def parse_packaging(wb):
    """Find the packaging reference weights wherever they sit in the sheet."""
    if WEIGHTS_TAB not in wb.sheetnames:
        return {}
    ws = wb[WEIGHTS_TAB]
    rows = list(ws.iter_rows(max_row=12, max_col=MAX_SCAN_COL, values_only=True))
    wanted = {
        "box": ("average box",),
        "yellow_bag": ("yellow bag",),
        "book_single": ("single series",),
        "book_multi": ("multi series",),
    }
    out = {}
    for r in rows:
        for c in r:
            if not c:
                continue
            text = str(c).lower()
            for field, needles in wanted.items():
                if field in out:
                    continue
                if any(n in text for n in needles):
                    out[field] = to_float(text)
    return out


def parse_sheet_updated(wb):
    if WELCOME_TAB not in wb.sheetnames:
        return None
    ws = wb[WELCOME_TAB]
    for row in ws.iter_rows(max_row=15, max_col=6, values_only=True):
        for c in row:
            if c and re.search(r"last updated", str(c), re.I):
                m = re.search(r"(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})", str(c))
                if m:
                    d, mo, y = m.groups()
                    y = y if len(y) == 4 else "20" + y
                    return f"{y}-{mo.zfill(2)}-{d.zfill(2)}"
    return None


# ---------------------------------------------------------------- images

def extract_images(xlsx_path: Path, figures):
    """Map anchored pictures from the Weights tab drawing to figures."""
    z = zipfile.ZipFile(xlsx_path)
    try:
        rels = z.read("xl/_rels/workbook.xml.rels").decode()
        relmap = dict(re.findall(r'Id="(rId\d+)"[^>]*Target="([^"]+)"', rels))
        wbxml = z.read("xl/workbook.xml").decode()
        sheet_rid = dict(re.findall(r'<sheet[^>]*name="([^"]+)"[^>]*r:id="(rId\d+)"', wbxml))[WEIGHTS_TAB]
        sheet_target = relmap[sheet_rid]  # worksheets/sheetN.xml
        srels = z.read(f"xl/worksheets/_rels/{Path(sheet_target).name}.rels").decode()
        m = re.search(r'Target="\.\./(drawings/drawing\d+\.xml)"', srels)
        if not m:
            raise KeyError("no drawing relationship")
        drawing = "xl/" + m.group(1)
        dxml = z.read(drawing).decode("utf-8", "ignore")
        drels = z.read(f"xl/drawings/_rels/{Path(drawing).name}.rels").decode()
    except KeyError as e:
        raise SyncError(f"cannot locate figure images in the workbook ({e})") from e
    media = dict(re.findall(r'Id="(rId\d+)"[^>]*Target="\.\./media/([^"]+)"', drels))

    anchors = []
    for mm in re.finditer(
        r"<xdr:from><xdr:col>(\d+)</xdr:col>.*?<xdr:row>(\d+)</xdr:row>.*?r:embed=\"(rId\d+)\"",
        dxml, re.S,
    ):
        anchors.append((int(mm.group(1)), int(mm.group(2)), mm.group(3)))

    IMG_DIR.mkdir(parents=True, exist_ok=True)
    by_cell = {(f["pic_col"], f["row"]): f for f in figures}
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
    return hit


# ---------------------------------------------------------------- merge

def merge(figures, samples, tips):
    """Attach raw samples + tips to figures via fuzzy matching."""
    fig_index = {}
    for f in figures:
        fig_index.setdefault(norm(f["series"]), {})[norm(f["name"])] = f
    tip_index = {}
    for t in tips:
        tip_index.setdefault(norm(t["series"]), {})[norm(t["name"])] = t

    stats = {"samples_matched": 0, "tips_matched": 0, "samples_unmatched": 0, "tips_unmatched": 0}
    for (series, name, mode), vals in samples.items():
        f = fuzzy_find(fig_index.get(series, {}), name)
        if f:
            f[f"samples_{mode}"] = sorted(set(vals))
            stats["samples_matched"] += 1
        else:
            stats["samples_unmatched"] += 1
    for series, name_map in tip_index.items():
        for name, t in name_map.items():
            f = fuzzy_find(fig_index.get(series, {}), name)
            if f and not f.get("tip"):
                f["tip"] = t["tip"]
                stats["tips_matched"] += 1
            else:
                stats["tips_unmatched"] += 1
    return stats


# ---------------------------------------------------------------- db

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


def figure_keys(figures):
    return [f"{slugify(f['series'])}-{slugify(f['name'])}" for f in figures]


def validate_figures(figures, existing_count):
    """Structural checks on the parse, before anything is written."""
    keys = figure_keys(figures)
    dupes = {k for k in keys if keys.count(k) > 1}
    if dupes:
        raise SyncError(f"duplicate figure keys in parse: {', '.join(sorted(dupes))}")
    if not figures:
        raise SyncError("parse produced 0 figures — sheet layout probably changed")
    if existing_count and len(figures) < existing_count * MIN_FIGURE_RATIO:
        raise SyncError(
            f"parse produced only {len(figures)} figures vs {existing_count} in the "
            f"current catalog — refusing to replace"
        )
    return keys


def validate_images(image_count, figures):
    if image_count < len(figures) * MIN_IMAGE_RATIO:
        raise SyncError(
            f"only {image_count}/{len(figures)} figures got images — refusing to replace"
        )


def replace_catalog(conn, figures, keys, sheet_updated, packaging, stats, version):
    """Replace the catalog in one transaction. Logs/wishlist are untouched."""
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    try:
        conn.execute("BEGIN")
        conn.execute("DELETE FROM catalog")
        for i, (f, key) in enumerate(zip(figures, keys)):
            sb = f.get("samples_boxed") or []
            su = f.get("samples_unboxed") or []
            conn.execute(
                "INSERT INTO catalog VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    i + 1, key, f["series"], i, f["name"], int(f["is_secret"]),
                    f.get("avg_boxed"), f.get("n_boxed") or (len(sb) or None),
                    f.get("avg_unboxed"), f.get("n_unboxed") or (len(su) or None),
                    json.dumps(sb), json.dumps(su),
                    f.get("image"), f.get("tip"),
                ),
            )
        known = set(keys)
        orphan_logs = [
            r[0] for r in conn.execute("SELECT DISTINCT key FROM logs")
            if r[0] not in known
        ]
        meta = {
            "sheet_updated": sheet_updated or "",
            "synced_at": now,
            "figure_count": str(len(figures)),
            "image_count": str(sum(1 for f in figures if f.get("image"))),
            "series_count": str(len({f["series"] for f in figures})),
            "sync_stats": json.dumps(stats),
            "orphan_logs": json.dumps(orphan_logs),
            "packaging": json.dumps(packaging),
            "version": version,
        }
        for k, v in meta.items():
            conn.execute("INSERT OR REPLACE INTO meta VALUES (?,?)", (k, v))
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return orphan_logs


def read_version():
    vfile = ROOT / "VERSION"
    if vfile.exists():
        return vfile.read_text().strip()
    return "0.0.0"


# ---------------------------------------------------------------- main

def run(offline: bool = False):
    """Fetch (unless offline) + parse the sheet into the database.

    A freshly downloaded workbook only replaces the cached copy once it has
    parsed and passed validation, so a bad sheet can never poison the cache.
    """
    source = XLSX_PATH
    pending = None
    if not offline:
        # .xlsx suffix matters: openpyxl validates the extension
        pending = DATA / f"{XLSX_PATH.stem}.download.xlsx"
        download_sheet(pending)
        source = pending
    wb = open_sheet(source)

    figures = parse_weights_tab(wb)
    samples = parse_data_tab(wb)
    tips = parse_tips_tab(wb)
    packaging = parse_packaging(wb)
    sheet_updated = parse_sheet_updated(wb)
    print(f"Parsed {len(figures)} figures, {len(samples)} sample rows, {len(tips)} tips")

    stats = merge(figures, samples, tips)
    print(f"Matched: {stats}")

    DATA.mkdir(exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    try:
        init_db(conn)
        existing = conn.execute("SELECT COUNT(*) FROM catalog").fetchone()[0]
        # structural checks first: fail fast, before touching images or the db
        keys = validate_figures(figures, existing)

        image_count = extract_images(source, figures)
        print(f"Extracted {image_count} images for {len(figures)} figures")
        validate_images(image_count, figures)

        if pending:  # parsed + validated: it is safe to cache now
            pending.replace(XLSX_PATH)

        if DB_PATH.exists() and existing:
            shutil.copy2(DB_PATH, DB_BACKUP)
        orphan_logs = replace_catalog(
            conn, figures, keys, sheet_updated, packaging, stats, read_version()
        )
    finally:
        conn.close()
        if pending and pending.exists():
            pending.unlink(missing_ok=True)

    conn = sqlite3.connect(DB_PATH)
    try:
        logged = conn.execute("SELECT COUNT(*) FROM logs").fetchone()[0]
    finally:
        conn.close()
    print(
        f"DB ready: {len(figures)} figures ({image_count} images) in catalog, "
        f"{logged} logged. Sheet updated: {sheet_updated}"
    )
    if orphan_logs:
        print(f"WARNING: {len(orphan_logs)} logged figure key(s) no longer in the sheet: "
              f"{', '.join(orphan_logs[:10])}")
    return {
        "figures": len(figures),
        "images": image_count,
        "series": len({f["series"] for f in figures}),
        "sheet_updated": sheet_updated,
        "orphan_logs": orphan_logs,
        "stats": stats,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--offline", action="store_true", help="reuse data/sheet.xlsx")
    args = ap.parse_args()
    try:
        run(offline=args.offline)
    except SyncError as e:
        raise SystemExit(f"sync aborted: {e}")


if __name__ == "__main__":
    main()
