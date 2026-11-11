#!/usr/bin/env python3
"""Sync safety tests.

These lock in the guarantees that make a bad sync harmless: whatever the sheet
looks like, the existing catalog must survive unless the parse is validated.

Run with:  python3 -m unittest discover -s tests -v
"""

import json
import shutil
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

import openpyxl

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import sync  # noqa: E402


class SyncSafetyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="smiski-test-"))
        self.real_sheet = sync.XLSX_PATH
        self.real_db = sync.DB_PATH
        self.real_images = sync.IMG_DIR
        self.assertGreater(self.real_sheet.stat().st_size, 1000, "need a cached sheet to test with")

        # work on copies: never touch the developer's real data
        self.sheet = self.tmp / "sheet.xlsx"
        self.db = self.tmp / "app.db"
        self.images = self.tmp / "images"
        shutil.copy2(self.real_sheet, self.sheet)
        self.images.mkdir()

        sync.XLSX_PATH = self.sheet
        sync.DB_PATH = self.db
        sync.IMG_DIR = self.images
        sync.DB_BACKUP = self.tmp / "app.db.bak"

        # hermetic baseline catalog (independent of any live database), so the
        # "suspiciously few figures" gate has something realistic to compare to
        conn = sqlite3.connect(self.db)
        sync.init_db(conn)
        for i in range(100):
            conn.execute(
                "INSERT INTO catalog VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (i + 1, f"baseline-{i}", "Baseline Series", i, f"Baseline Figure {i}",
                 0, 40.0, 3, 25.0, 3, "[]", "[]", None, None),
            )
        conn.commit()
        conn.close()

        self.baseline = 100

    def tearDown(self):
        sync.XLSX_PATH = self.real_sheet
        sync.DB_PATH = self.real_db
        sync.IMG_DIR = self.real_images
        sync.DB_BACKUP = sync.DATA / "app.db.bak"
        shutil.rmtree(self.tmp, ignore_errors=True)

    def catalog_count(self):
        conn = sqlite3.connect(self.db)
        try:
            return conn.execute("SELECT COUNT(*) FROM catalog").fetchone()[0]
        finally:
            conn.close()

    def make_sheet(self, tabs, blocks=None, path=None):
        """Build a workbook with given tab names; optional simple weight blocks."""
        path = path or self.sheet
        wb = openpyxl.Workbook()
        wb.remove(wb.active)
        for t in tabs:
            wb.create_sheet(t)
        if blocks:
            ws = wb[sync.WEIGHTS_TAB]
            ws.append(["", "Average Box", "10.5 g", "", "Yellow Bag", "1.38 g"])
            r = 4
            for series, names in blocks.items():
                ws.cell(row=r, column=2, value=series)
                ws.cell(row=r, column=3, value="Picture")
                ws.cell(row=r, column=4, value="Avg w/ box (g)")
                ws.cell(row=r, column=5, value="Data Points")
                ws.cell(row=r, column=6, value="Avg w/o box (g)")
                ws.cell(row=r, column=7, value="Data Points")
                for i, n in enumerate(names):
                    ws.cell(row=r + 1 + i, column=2, value=n)
                    ws.cell(row=r + 1 + i, column=4, value=40.0 + i)
                    ws.cell(row=r + 1 + i, column=5, value=3)
                    ws.cell(row=r + 1 + i, column=6, value=25.0 + i)
                    ws.cell(row=r + 1 + i, column=7, value=3)
                r += len(names) + 3
        wb.save(path)

    # ------------------------------------------------------------------ tests

    def test_healthy_sync_replaces_catalog(self):
        """A normal sync works and reports its numbers."""
        report = sync.run(offline=True)
        self.assertGreater(report["figures"], 100)
        self.assertEqual(report["images"], report["figures"])
        self.assertEqual(self.catalog_count(), report["figures"])

    def test_empty_layout_is_rejected_and_catalog_survives(self):
        """The 1.1.0 regression: unrecognised layout must NOT wipe the catalog."""
        self.make_sheet([sync.WEIGHTS_TAB, sync.DATA_TAB, sync.TIPS_TAB, sync.WELCOME_TAB])
        with self.assertRaises(sync.SyncError):
            sync.run(offline=True)
        self.assertEqual(self.catalog_count(), self.baseline)

    def test_partial_parse_is_rejected(self):
        """A sheet that suddenly parses far fewer figures is suspicious."""
        self.make_sheet(
            [sync.WEIGHTS_TAB, sync.DATA_TAB, sync.TIPS_TAB, sync.WELCOME_TAB],
            blocks={"Series 1": ["Hugging Knees", "Sitting"]},
        )
        with self.assertRaises(sync.SyncError):
            sync.run(offline=True)
        self.assertEqual(self.catalog_count(), self.baseline)

    def test_missing_tab_is_rejected(self):
        self.make_sheet(["1. Welcome Page"])
        with self.assertRaises(sync.SyncError):
            sync.run(offline=True)
        self.assertEqual(self.catalog_count(), self.baseline)

    def test_corrupt_cache_is_rejected(self):
        self.sheet.write_bytes(b"<html>rate limited</html>")
        with self.assertRaises(sync.SyncError):
            sync.run(offline=True)
        self.assertEqual(self.catalog_count(), self.baseline)

    def test_missing_images_is_rejected(self):
        """A workbook whose figures can't get photos is refused."""
        with self.assertRaises(sync.SyncError):
            sync.validate_images(0, [{"series": "s", "name": "n"}] * 10)

    def test_extract_images_without_drawing_raises_syncerror(self):
        """A sheet with blocks but no drawing fails cleanly, not with a KeyError."""
        self.make_sheet(
            [sync.WEIGHTS_TAB, sync.DATA_TAB, sync.TIPS_TAB, sync.WELCOME_TAB],
            blocks={"Series 1": ["Hugging Knees"] * 3},
        )
        with self.assertRaises(sync.SyncError):
            sync.run(offline=True)
        self.assertEqual(self.catalog_count(), self.baseline)

    def test_collection_survives_sync(self):
        """Logs and wishlist are user data and must never be touched by a sync."""
        conn = sqlite3.connect(self.db)
        conn.execute(
            "INSERT INTO logs (key, acquired_date, note, has_photo, created_at) VALUES (?,?,?,0,?)",
            ("series-1-scream", "2026-10-31", "keep me", "2026-10-31T00:00:00+00:00"),
        )
        conn.execute("INSERT INTO wishlist (key) VALUES (?)", ("yoga-series-lotus",))
        conn.commit()
        conn.close()

        sync.run(offline=True)

        conn = sqlite3.connect(self.db)
        logs = conn.execute("SELECT key, note FROM logs").fetchall()
        wish = conn.execute("SELECT key FROM wishlist").fetchall()
        conn.close()
        self.assertEqual(logs, [("series-1-scream", "keep me")])
        self.assertEqual(wish, [("yoga-series-lotus",)])

    def test_orphan_logs_are_reported(self):
        """Logs pointing at figures that vanished from the sheet are reported."""
        conn = sqlite3.connect(self.db)
        conn.execute(
            "INSERT INTO logs (key, acquired_date, note, has_photo, created_at) VALUES (?,?,?,0,?)",
            ("gone-series-vanished", None, None, "2026-10-31T00:00:00+00:00"),
        )
        conn.commit()
        conn.close()
        report = sync.run(offline=True)
        self.assertIn("gone-series-vanished", report["orphan_logs"])
        meta = sqlite3.connect(self.db).execute(
            "SELECT value FROM meta WHERE key='orphan_logs'"
        ).fetchone()[0]
        self.assertIn("gone-series-vanished", json.loads(meta))

    def test_bad_download_does_not_poison_the_cache(self):
        """A download that fails validation must not replace the cached sheet."""
        bad = self.tmp / "bad-download.xlsx"
        self.make_sheet(["1. Welcome Page", "Renamed Tab"], path=bad)
        sync.XLSX_URL = bad.as_uri()
        with self.assertRaises(sync.SyncError):
            sync.run(offline=False)  # online sync from the bad workbook
        # the cache still holds the good sheet, so an offline sync works
        report = sync.run(offline=True)
        self.assertGreater(report["figures"], 100)
        self.assertEqual(self.catalog_count(), report["figures"])

    def test_backup_written_before_replacing(self):
        sync.run(offline=True)
        self.assertTrue(sync.DB_BACKUP.exists(), "a pre-sync db backup should exist")


if __name__ == "__main__":
    unittest.main(verbosity=2)
