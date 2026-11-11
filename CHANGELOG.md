# Changelog

All notable changes to Smiski Tracker are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] — 2026-11-11

### Added

- **Static preview, deployable to GitHub Pages.** The real frontend runs on
  generated demo data with no backend, so anyone can try it without Docker:
  browsing, logging copies, the wishlist, photos, stats and the Finder all work,
  but nothing is saved (photos live in the browser tab) and a banner says so.
  The sync button is still shown — clicking it explains that syncing isn't
  available in the static preview.
- `tools/export_static.py` builds `dist/` — frontend, `demo/catalog.json` and
  the figure images. `.github/workflows/pages.yml` rebuilds and redeploys it on
  every push to `main`, so the published preview always matches the main branch
  and the latest community sheet data.
- `static/finder.js` — the Finder maths extracted into a shared module so the
  preview can compute likelihoods in the browser.
- `tests/test_finder_parity.mjs` — compares the JavaScript and Python Finder
  implementations (1530 likelihoods across every series: maximum difference
  0.0000 percentage points).

### Changed

- Frontend asset URLs are now relative, so the app works both at a domain root
  (Docker) and under a subpath (GitHub Pages project sites).
- Sync safety tests build their own baseline database, so they can no longer
  race with a running instance.

### Fixed

- Closing the full-screen photo viewer no longer closes the detail view behind
  it.

## [1.1.1] — 2026-11-11

### Changed

- **Photos now open in a full-screen viewer instead of a new browser tab.**
  Tapping a logged photo shows it large over a dimmed background, with big
  *Delete photo* and *Close* buttons (Escape or tapping outside also closes).
  The tiny delete button that used to sit on the log thumbnail is gone, so
  there is no longer a small target to hit on a phone.
- **The header stays on a single line on narrow screens.** Below 640 px the
  sync button collapses to just its icon; below 460 px the nav tabs collapse to
  icons as well. Both keep their accessible labels and tooltips, so nothing is
  lost for screen readers.
- Touch targets are larger on phones: log rows, the photo thumbnail and the
  delete-log button are all easier to tap.

### Fixed

- The photo viewer scales the image up to the viewport (up to 92 vw / 72 vh)
  instead of displaying small photos at their natural size.

### Changed (internal)

- The sync safety tests now build their own baseline database instead of
  copying the live one, so they can no longer race with a running instance.

## [1.1.0] — 2026-11-11

### Fixed

- **Sync no longer wipes the catalog when the community sheet changes layout.**
  The parser relied on hard-coded column positions; when the sheet inserted a
  column, parsing silently returned zero figures and the sync replaced the
  catalog with nothing — every figure disappeared from the site. Parsing now
  discovers blocks and column offsets from the sheet headers, so column shifts
  and new series are handled automatically. Verified against the current sheet:
  180 figures in 26 series, including the new *Hanging Series - Xmas*.
- Figure names with the sheet's `SERCRET` typo are now recognised as secrets.

### Added

- **Sync safety gates.** A sync is refused (with a clear message, leaving the
  existing catalog untouched) when the parse yields zero figures, fewer than
  half of the current catalog, duplicate figure keys, or images for fewer than
  half of the parsed figures. Missing sheet tabs and a corrupt or rate-limited
  download are also detected before anything is replaced.
- Atomic catalog replacement in a single transaction, plus a
  `data/app.db.bak` snapshot written before every sync.
- Sheet downloads are validated as real `.xlsx` files before replacing the
  cached copy, and are written via a temporary file.
- **Orphaned log detection.** Logged copies whose figure is no longer in the
  sheet are counted, reported by the sync, stored in the API metadata, and
  shown as a warning banner in the UI.
- Sync reports details (figures, images, series, orphaned logs) to the UI.
- Footer showing the app version, sheet last-updated date and catalog size.
- `tests/test_sync_safety.py`: regression suite (stdlib `unittest`, no extra
  dependencies) covering the wipe regression, the safety gates, and that
  collection data survives syncs.
- `CHANGELOG.md` and `VERSION`.

## [1.0.0] — 2026-10-31

### Added

- Initial release: catalog from the community weights spreadsheet, per-copy
  logging with dates, notes and photos, wishlist, weight privacy, Finder with
  Student-t likelihoods and hover tips, collection statistics, on-demand sheet
  sync, and a single-container Docker deployment.
