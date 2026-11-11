# Smiski Landia

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

## Tests

```bash
python3 -m unittest discover -s tests -v
```

Covers the wipe regression, every safety gate, and that collection data
survives syncs. Requires a cached sheet (`python3 sync.py` once).

## Acknowledgements

All weights, figure photos and tips come from the community spreadsheet
maintained by u/yunggho and contributors on r/Smiskis — thank you:
<https://docs.google.com/spreadsheets/d/1U4l4ugaL8UG7wzEfQqQ1h_oYYX0s0tGpqw9XV_cxnms>

Weigh figures mindfully and follow store policies.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT
