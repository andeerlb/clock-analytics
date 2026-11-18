# PontoScan

A web app for a small team (Google login) that ingests Brazilian "Espelho Ponto" (timesheet) PDF exports and payment spreadsheets, parses punch data per employee/day, and analyzes it. It started as a Tauri desktop app; the desktop version has been retired and everything now runs on a small server.

## Features

- **Extensible parser architecture.** Timesheet providers are plugged in via a `TimesheetParser` trait + registry (see `server/src/domain/parsers/`); adding a new export format doesn't touch the rest of the app. The [Coalize](https://coalize.com.br/) export format is supported today.
- **Robust PDF import.** Handles single-file and multi-page batch exports (one employee per page), content-hash based duplicate detection (independent of filename), and resilient parsing — one bad page in a batch doesn't fail the whole import.
- **Companies, Clients, Employees.** A company can have many clients and a client can be linked to more than one company (many-to-many); employees and their imported timesheets are scoped to a client.
- **Cartão de Ponto (employee detail).** A full day-by-day breakdown per import, with dynamic Entrada/Saída columns, computed metrics (worked hours, overtime, faltas/atrasos, breaks), and a multi-select filter over per-day status.
- **Colaboradores.** The main list of imported timesheets, filterable by name, company, client, period and per-period status — the same filters double as a report generator, bundling the matching employees' original PDFs into one ZIP organized in `Company/Client/` folders.
- **Pagamentos.** Payment spreadsheets imported through column-mapping templates, with routing/status rules, reconciliation and Excel/PDF exports.
- **Verificação automática.** Spreadsheets imported by link (OneDrive, SharePoint or a direct link) are checked by the server every minute; changes are listed for review and only written when someone accepts them.
- **In-app PDF viewer** with [pdf.js](https://mozilla.github.io/pdf.js/).
- **AI assistant (optional).** A floating icon on every screen answers questions about the app and the data. It only answers and cannot change anything, and is on only when an Anthropic API key is saved in Configurações (one key for the team, kept on the server). It runs read-only queries and sends the results to Anthropic; employee names, CPF, PIX, matrícula, clients, companies and files are sent as codes, never as names.

## Tech stack

- Frontend: React + TypeScript + Vite, hosted on Firebase Hosting; Google login via Firebase Auth.
- Server (`server/`): Rust + [axum](https://github.com/tokio-rs/axum), SQLite via sqlx with versioned migrations (`server/migrations/`), [Poppler](https://poppler.freedesktop.org/) utilities for PDF text extraction, splitting and merging.
- Hosting (`infra/`, OpenTofu): a Google Cloud e2-micro VM (Always Free) with Caddy (HTTPS), Litestream (continuous SQLite backup to Cloud Storage) and DuckDNS.

## Local development

Prerequisites: Node.js 20+ and Yarn, Rust (stable, via `rustup`), and Poppler (`sudo apt-get install poppler-utils` / `brew install poppler`).

```sh
yarn install

# terminal 1: the server, without login (debug builds only)
cd server && PONTOSCAN_DEV_USER_EMAIL=dev@local cargo run

# terminal 2: the frontend on http://localhost:1420 (proxies /api to the server)
yarn dev
```

Without `VITE_FIREBASE_*` variables (e.g. no `.env.local`) the app opens without the login screen. See `server/README.md` for every server setting (database path, time zone, the automatic check switch, CORS, Firebase) and how to test against a copy of real data.

## Deploying

Pushing to the `web` branch runs [`deploy-web.yml`](.github/workflows/deploy-web.yml): it builds the server, uploads it for the VM to install (with automatic rollback if the health check fails), and publishes the frontend to Firebase Hosting once the API reports the new version. Creating the infrastructure is described in [`infra/README.md`](infra/README.md).

## Migrations

`server/migrations/*.sql` plus the ordered list in `server/src/migrations_list.rs`. To add one, create the `.sql` file **and** append its line to the list. Never edit or reorder an existing migration: databases that already applied it would refuse to open.
