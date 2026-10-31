# 🧏 Smiski Landia

![Python](https://img.shields.io/badge/python-3.12-blue)
![FastAPI](https://img.shields.io/badge/FastAPI-0.110+-009688)
![Preact](https://img.shields.io/badge/Preact-htm-673ab8)
![Docker](https://img.shields.io/badge/docker-compose-2496ED)
![SQLite](https://img.shields.io/badge/SQLite-003B57)

A tiny self-hosted tracker for **Smiski** blind-box figures. Built for a home
server / VPN: one Docker container, no accounts, no build step.

## ✨ Features

- **Collection tracking** — owned / wishlist, duplicates, acquired dates, notes
- **📷 Photos** — snap a picture from your phone when logging (client-side
  compressed to ~1280 px JPEG)
- **🙈 Weight privacy** — community weights hidden by default, tap to reveal
- **🔍 Finder** — measure a box's weight, get ranked "which one is it?"
  likelihoods (Student-t predictive distributions from raw community
  measurements), with identification tips on hover
- **📊 Stats** — completion per series, secrets, duplicates
- **🔄 Sheet sync** — re-pull the community spreadsheet on demand

## 🚀 Run

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

## 🙏 Acknowledgements

All weights, figure photos and tips come from the amazing community
spreadsheet maintained by **u/yunggho** and contributors on r/Smiskis —
thank you! 🫶
<https://docs.google.com/spreadsheets/d/1U4l4ugaL8UG7wzEfQqQ1h_oYYX0s0tGpqw9XV_cxnms>

Weigh figures mindfully and follow store policies.

## License

MIT
