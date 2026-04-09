# Print Farm Manager

Locally-hosted web app for managing a multi-brand 3D printer farm. Supports Prusa (PrusaLink), Elegoo Centauri (SDCP), and Bambu printers from a single interface.

## Quick Start

```bash
npm install
cd client && npm install && cd ..
npm run dev
```

- API server: http://localhost:3000
- Web UI: http://localhost:5173

## Features

- Fleet view with live printer status (15-second poll)
- Printer registry with CSV import
- Multi-brand support: Prusa, Elegoo, Bambu
- Settings page for managing printers and models

## CSV Import Format

| Column | Example |
|---|---|
| name | `MK4S_01` |
| ip | `192.168.15.194` |
| api_key | `aauukLtMLUTqq6e` |
| group | `MK4S Farm` |
| type | `prusa` |

Model is inferred from the printer name automatically.
