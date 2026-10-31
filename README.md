# 🧏 Smiski Landia

A tiny self-hosted collection tracker for Smiski figures, built around the
community weights Google Sheet (maintained by yunggho on Reddit — thanks! 🙏).

Designed for a home server / VPN: one Docker container, no user accounts, no
build step, no PHP. Just you and your wife hunting gloomy green boys.

## Features

- **Collection catalog** — all ~173 figures across 26 series (incl. secrets),
  with photos pulled straight from the community sheet
- **Log & wishlist** — mark owned/wishlist, duplicates count, acquired date,
  notes; shared state in SQLite so both of you see the same collection
- **📷 Photos** — take a picture from your phone when logging; it's compressed
  client-side (max 1280px JPEG, ~100–300 KB) and stored per figure, viewable
  full-size
- **🙈 Weight privacy** — weights are hidden by default (like a bank balance);
  one 👁️ toggle reveals all, or tap any single weight
- **🔍 Finder** — pick a series, type the weight you measured, get ranked
  likelihoods computed from the sheet's raw community measurements using
  Student-t predictive distributions; hover a result for its tips & tricks
- **📊 Stats** — completion per series, duplicates, secrets found, wishlist
- **🔄 Sync button** — re-pull the Google Sheet whenever it updates upstream

## Run it

```bash
docker compose up -d --build
```

Then open `http://<server>:8123` from anywhere on your VPN.

Everything lives in the `./data` volume:

| Path                | What                                     |
| ------------------- | ---------------------------------------- |
| `data/app.db`       | SQLite: catalog + your collection        |
| `data/images/`      | figure photos extracted from the sheet    |
| `data/photos/`      | your own camera photos                   |
| `data/sheet.xlsx`   | cached sheet download                    |

### Without Docker

```bash
pip install -r requirements.txt
python3 sync.py        # fetch + parse the sheet into data/app.db
python3 -m uvicorn server:app --port 8123
```

## How it works

- `sync.py` — downloads the sheet's `.xlsx` export, parses the "2. Weights"
  grid (series blocks), the tidy "6. Data" tab (raw measurements), the
  "3. Tips + Tricks" tab, and the embedded images (cell-anchored, so each
  maps to its figure). Upserts into `data/app.db`, never touching your
  collection state.
- `server.py` — FastAPI: static frontend, catalog/collection/photos APIs,
  and `/api/finder` which scores a measured weight against each figure's
  sample mean/SD/n via a t-predictive density, normalized across the series.
- `static/` — vanilla Preact + htm (vendored locally, no CDN needed on a VPN)
  single-page app.

## Data credit

All weights, images, and tips come from the community sheet:
<https://docs.google.com/spreadsheets/d/1U4l4ugaL8UG7wzEfQqQ1h_oYYX0s0tGpqw9XV_cxnms>

Be mindful of store policies when weighing — the sheet says it best 🫶
