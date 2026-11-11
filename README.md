# Smiski Tracker

A tiny self-hosted tracker for Smiski blind-box figures. Built for a home
server / VPN: one Docker container, no accounts, no build step.

## Features

- Collection tracking — per-copy logs with dates, notes, and photos; duplicates
  and stats update automatically
- Photos — snap a picture from your phone when logging, client-side compressed
- Weight privacy — community weights hidden until tapped in the detail view
- Finder — measure a box's weight, get ranked "which one is it?" likelihoods
  (Student-t predictive distributions from raw community measurements), with
  identification tips on hover
- Stats — completion per series, secrets, duplicates, photos
- Sheet sync — re-pull the community spreadsheet on demand, with safety checks
  that refuse to replace the catalog if the sheet's layout changes

## Run

```bash
docker compose up -d --build        # serves on http://<host>:8123
```

or without Docker:

```bash
pip install -r requirements.txt
python3 sync.py && python3 server.py
```

User data lives in `./data` (SQLite db + your photos) — it's the only thing to
back up. Everything else is regenerated from the sheet by `sync.py`.

### Configuration

| Variable           | Default                              | Purpose                          |
| ------------------ | ------------------------------------ | -------------------------------- |
| `PORT`             | `8123`                               | HTTP port when running directly  |
| `SMISKI_XLSX_URL`  | the community sheet's xlsx export    | sync from your own sheet copy    |

## Sync safety

`sync.py` parses the community spreadsheet, whose layout changes over time.
To make sure a sheet change can never destroy your catalog, a sync is refused
(leaving the existing data untouched) when the parse yields:

- zero figures, or fewer than half of the current catalog;
- duplicate figure keys;
- images for fewer than half of the parsed figures;
- a workbook missing the expected tabs, or a download that is not a valid
  `.xlsx` (e.g. rate-limited HTML).

The catalog is replaced in a single transaction after a `data/app.db.bak`
backup is written. Your logs and wishlist are never modified by a sync; if a
figure disappears from the sheet, the orphaned logs are reported and shown as
a warning in the UI.

## Try it without installing

A static preview is published to GitHub Pages from `main`:
**https://toyo97.github.io/smiski-tracker/**

It is the real interface on generated demo data with no backend — browse, log
copies, add photos and use the Finder freely; nothing is saved. Build it
locally with:

```bash
python3 sync.py && python3 tools/export_static.py   # -> dist/ (open with any static server)
```

## Tests

```bash
python3 -m unittest discover -s tests -v            # sync safety (11 tests)

# Finder parity between the JS preview and the Python API:
python3 tools/export_static.py && python3 -m uvicorn server:app --port 8123 &
node tests/test_finder_parity.mjs
```

Covers the wipe regression, every sync safety gate, that collection data
survives syncs, and that the preview's likelihoods match the server's. Requires
a cached sheet (`python3 sync.py` once).

## Acknowledgements

All weights, figure photos and tips come from the community spreadsheet
maintained by u/yunggho and contributors on r/Smiskis — thank you:
<https://docs.google.com/spreadsheets/d/1U4l4ugaL8UG7wzEfQqQ1h_oYYX0s0tGpqw9XV_cxnms>

Weigh figures mindfully and follow store policies.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT
