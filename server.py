#!/usr/bin/env python3
"""Smiski Landia — tiny FastAPI server.

Serves the frontend, the catalog (from the community Google Sheet, via sync.py),
your shared collection state (SQLite), and the Finder API which scores a
measured weight against every figure in a series using Student-t predictive
distributions built from the sheet's raw community measurements.

Data model:
    catalog   — one row per figure (synced from the sheet)
    logs      — one row per logged physical copy (count = # of log rows)
    wishlist  — one row per wishlisted figure
    meta      — sync metadata
"""

import json
import math
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException, Body, UploadFile, File
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
DB_PATH = DATA / "app.db"
IMG_DIR = DATA / "images"
PHOTO_DIR = DATA / "photos"
PHOTO_MAX_BYTES = 3 * 1024 * 1024  # client compresses; server-side safety cap

app = FastAPI(title="Smiski Landia")


# ------------------------------------------------------------------ schema

def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init():
    """Create tables if missing."""
    DATA.mkdir(exist_ok=True)
    conn = db()
    conn.executescript(
        """
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
        """
    )
    conn.commit()
    conn.close()


init()


def catalog_rows(conn):
    return [
        {
            "key": r["key"],
            "series": r["series"],
            "name": r["name"],
            "is_secret": bool(r["is_secret"]),
            "avg_boxed": r["avg_boxed"],
            "n_boxed": r["n_boxed"],
            "avg_unboxed": r["avg_unboxed"],
            "n_unboxed": r["n_unboxed"],
            "image": r["image"],
            "tip": r["tip"],
            # samples only exposed via finder (smaller payload)
        }
        for r in conn.execute("SELECT * FROM catalog ORDER BY series_order")
    ]


def meta_dict(conn):
    meta = {r["key"]: r["value"] for r in conn.execute("SELECT * FROM meta")}
    meta["packaging"] = json.loads(meta.get("packaging") or "{}")
    return meta


# ------------------------------------------------------------- statistics

def t_logpdf(t: float, df: int) -> float:
    """Log density of the Student-t distribution at t with df degrees of freedom."""
    if df < 1:
        return -math.inf
    return (
        math.lgamma((df + 1) / 2)
        - math.lgamma(df / 2)
        - 0.5 * math.log(df * math.pi)
        - ((df + 1) / 2) * math.log(1 + t * t / df)
    )


def stats_from_samples(samples):
    n = len(samples)
    if n == 0:
        return None
    mean = sum(samples) / n
    var = sum((x - mean) ** 2 for x in samples) / (n - 1) if n > 1 else None
    return n, mean, (math.sqrt(var) if var is not None else None)


def finder(series: str, weight: float, mode: str):
    conn = db()
    rows = conn.execute(
        "SELECT * FROM catalog WHERE series = ? ORDER BY series_order", (series,)
    ).fetchall()
    conn.close()

    col_samples = "samples_boxed" if mode == "boxed" else "samples_unboxed"
    col_avg = "avg_boxed" if mode == "boxed" else "avg_unboxed"

    # pooled sd within this series+mode, for figures with too few samples
    # to estimate their own spread
    pooled_sds, pooled_n = [], 0
    for r in rows:
        st = stats_from_samples(json.loads(r[col_samples] or "[]"))
        if st and st[2] and st[0] >= 2:
            pooled_sds.append(st[2] * math.sqrt(st[0] - 1))
            pooled_n += st[0] - 1
    pooled_sd = (
        math.sqrt(sum(x * x for x in pooled_sds) / pooled_n) if pooled_n else 3.0
    )
    pooled_df = max(pooled_n, 5)

    candidates = []
    for r in rows:
        st = stats_from_samples(json.loads(r[col_samples] or "[]"))
        if st:
            n, mean, sd = st
            sd = sd or pooled_sd
            df = n - 1 if n >= 2 else pooled_df
        elif r[col_avg] is not None:
            n, mean, sd, df = 1, r[col_avg], pooled_sd, pooled_df
        else:
            candidates.append(
                {
                    "key": r["key"], "name": r["name"], "image": r["image"],
                    "is_secret": bool(r["is_secret"]), "has_data": False,
                }
            )
            continue
        # predictive distribution: X_new - mean ~ t_df * sd * sqrt(1 + 1/n)
        t_score = (weight - mean) / (sd * math.sqrt(1 + 1 / n))
        candidates.append(
            {
                "key": r["key"],
                "name": r["name"],
                "image": r["image"],
                "is_secret": bool(r["is_secret"]),
                "has_data": True,
                "mean": round(mean, 2),
                "sd": round(sd, 2),
                "n": n,
                "delta": round(weight - mean, 2),
                "t": round(t_score, 2),
                "log_lik": t_logpdf(t_score, df) - math.log(sd * math.sqrt(1 + 1 / n)),
            }
        )

    scored = [c for c in candidates if c.get("has_data")]
    nodata = [c for c in candidates if not c.get("has_data")]
    if scored:
        mx = max(c["log_lik"] for c in scored)
        exps = {c["key"]: math.exp(c["log_lik"] - mx) for c in scored}
        total = sum(exps.values())
        for c in scored:
            c["likelihood"] = round(100 * exps[c["key"]] / total, 1)
        scored.sort(key=lambda c: -c["likelihood"])
        for c in scored:
            del c["log_lik"]
    return scored, nodata


# -------------------------------------------------------------------- api

@app.get("/api/catalog")
def api_catalog():
    conn = db()
    out = {"figures": catalog_rows(conn), "meta": meta_dict(conn)}
    conn.close()
    return out


@app.get("/api/collection")
def api_collection():
    conn = db()
    logs = [
        {
            "id": r["id"], "key": r["key"], "acquired_date": r["acquired_date"],
            "note": r["note"], "has_photo": bool(r["has_photo"]),
        }
        for r in conn.execute("SELECT * FROM logs ORDER BY id")
    ]
    wishlist = [r[0] for r in conn.execute("SELECT key FROM wishlist")]
    conn.close()
    return {"logs": logs, "wishlist": wishlist}


def figure_exists(conn, key: str):
    return conn.execute("SELECT 1 FROM catalog WHERE key=?", (key,)).fetchone()


@app.post("/api/logs")
def api_log_create(body: dict = Body(...)):
    key = body.get("key")
    conn = db()
    if not key or not figure_exists(conn, key):
        conn.close()
        raise HTTPException(404, "unknown figure")
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    cur = conn.execute(
        "INSERT INTO logs (key, acquired_date, note, has_photo, created_at) VALUES (?,?,?,0,?)",
        (key, body.get("acquired_date"), body.get("note"), now),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM logs WHERE id=?", (cur.lastrowid,)).fetchone()
    conn.close()
    return {k: row[k] for k in row.keys()}


@app.patch("/api/logs/{log_id}")
def api_log_update(log_id: int, body: dict = Body(...)):
    conn = db()
    row = conn.execute("SELECT * FROM logs WHERE id=?", (log_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "unknown log")
    conn.execute(
        "UPDATE logs SET acquired_date=?, note=? WHERE id=?",
        (body.get("acquired_date", row["acquired_date"]),
         body.get("note", row["note"]), log_id),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM logs WHERE id=?", (log_id,)).fetchone()
    conn.close()
    return {k: row[k] for k in row.keys()}


@app.delete("/api/logs/{log_id}")
def api_log_delete(log_id: int):
    conn = db()
    row = conn.execute("SELECT * FROM logs WHERE id=?", (log_id,)).fetchone()
    if row:
        conn.execute("DELETE FROM logs WHERE id=?", (log_id,))
        conn.commit()
        p = PHOTO_DIR / f"{row['key']}-{log_id}.jpg"
        if p.exists():
            p.unlink()
    conn.close()
    return {"ok": True}


@app.put("/api/wishlist/{key}")
def api_wishlist_set(key: str, body: dict = Body(...)):
    conn = db()
    if not figure_exists(conn, key):
        conn.close()
        raise HTTPException(404, "unknown figure")
    if body.get("wishlist"):
        conn.execute("INSERT OR IGNORE INTO wishlist (key) VALUES (?)", (key,))
    else:
        conn.execute("DELETE FROM wishlist WHERE key=?", (key,))
    conn.commit()
    conn.close()
    return {"ok": True}


# ----------------------------------------------------------------- photos

PHOTO_MAGIC = (b"\xff\xd8\xff", b"\x89PNG", b"RIFF")  # jpeg / png / webp


@app.post("/api/photo/{log_id}")
async def api_photo_upload(log_id: int, file: UploadFile = File(...)):
    conn = db()
    row = conn.execute("SELECT * FROM logs WHERE id=?", (log_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "unknown log")
    data = await file.read()
    if len(data) > PHOTO_MAX_BYTES:
        raise HTTPException(413, "photo too large (compress client-side)")
    if not data.startswith(PHOTO_MAGIC):
        raise HTTPException(400, "not a jpeg/png/webp image")
    PHOTO_DIR.mkdir(parents=True, exist_ok=True)
    (PHOTO_DIR / f"{row['key']}-{log_id}.jpg").write_bytes(data)
    conn.execute("UPDATE logs SET has_photo=1 WHERE id=?", (log_id,))
    conn.commit()
    conn.close()
    return {"ok": True, "url": f"/photos/{row['key']}-{log_id}.jpg"}


@app.delete("/api/photo/{log_id}")
def api_photo_delete(log_id: int):
    conn = db()
    row = conn.execute("SELECT * FROM logs WHERE id=?", (log_id,)).fetchone()
    if row:
        p = PHOTO_DIR / f"{row['key']}-{log_id}.jpg"
        if p.exists():
            p.unlink()
        conn.execute("UPDATE logs SET has_photo=0 WHERE id=?", (log_id,))
        conn.commit()
    conn.close()
    return {"ok": True}


@app.get("/api/finder")
def api_finder(series: str, weight: float, mode: str = "boxed"):
    if mode not in ("boxed", "unboxed"):
        raise HTTPException(400, "mode must be boxed or unboxed")
    scored, nodata = finder(series, weight, mode)
    return {"results": scored, "no_data": nodata, "weight": weight, "mode": mode, "series": series}


@app.post("/api/sync")
def api_sync():
    import sync
    try:
        total = sync.run(offline=False)
    except Exception as e:
        raise HTTPException(502, f"sync failed: {e}")
    return {"ok": True, "figures": total}


# ----------------------------------------------------------------- static

PHOTO_DIR.mkdir(parents=True, exist_ok=True)  # StaticFiles needs it to exist
app.mount("/images", StaticFiles(directory=IMG_DIR), name="images")
app.mount("/photos", StaticFiles(directory=PHOTO_DIR), name="photos")
app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")


@app.get("/")
def index():
    return FileResponse(ROOT / "static" / "index.html")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 8123)))
