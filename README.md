# Clock Analytics

A cross-platform desktop app (Linux, macOS, Windows) built with [Tauri](https://tauri.app/) for ingesting Brazilian "Espelho Ponto" (timesheet) PDF exports, parsing punch data per employee/day, and analyzing it locally — no data ever leaves the machine, everything is persisted to a local SQLite database.

## Features

- **Extensible parser architecture.** Timesheet providers are plugged in via a `TimesheetParser` trait + registry (see `src-tauri/src/parsers/`); adding a new export format doesn't touch the rest of the app. The [Coalize](https://coalize.com.br/) export format is supported today.
- **Robust PDF import.** Handles single-file and multi-page batch exports (one employee per page), content-hash based duplicate detection (independent of filename/path), and resilient parsing — one bad page in a batch doesn't fail the whole import.
- **Companies, Clients, Employees.** A company can have many clients and a client can be linked to more than one company (many-to-many); employees and their imported timesheets are scoped to a client.
- **Cartão de Ponto (employee detail).** A full day-by-day breakdown per import, with dynamic Entrada/Saída columns, computed metrics (worked hours, overtime, faltas/atrasos, breaks), and a multi-select filter over per-day status.
- **Relatórios.** Filters over already-imported timesheets (by company, client, period, and per-period status) that bundle the matching employees' original PDFs into a single ZIP, organized in `Company/Client/` folders — either one PDF per employee or one merged PDF per client.
- **In-app PDF viewer.** PDFs are rendered inside the app with [pdf.js](https://mozilla.github.io/pdf.js/), with actions to download a copy or reveal the file in the OS file manager.

## Tech stack

- [Tauri v2](https://tauri.app/) — Rust backend, native OS webview for the UI
- React + TypeScript + Vite
- SQLite via [`@tauri-apps/plugin-sql`](https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/sql), with versioned Rust-side migrations
- [Poppler](https://poppler.freedesktop.org/) command-line utilities (`pdftotext`, `pdfseparate`, `pdfinfo`, `pdfunite`) for PDF text extraction, page splitting, and merging
- [pdf.js](https://mozilla.github.io/pdf.js/) for the in-app PDF viewer

## Prerequisites

- [Node.js](https://nodejs.org/) 20+ and [Yarn](https://yarnpkg.com/)
- [Rust](https://www.rust-lang.org/tools/install) (stable toolchain, via `rustup`)
- [Tauri's platform-specific system dependencies](https://tauri.app/start/prerequisites/) (WebKitGTK on Linux, Xcode Command Line Tools on macOS, WebView2 on Windows)
- **Poppler utilities on your `PATH`** — `pdftotext`, `pdfseparate`, `pdfinfo`, and `pdfunite` must be installed. These aren't bundled with the app yet (see [Known limitations](#known-limitations)), so they're required both for local development and on any machine that runs the packaged app.
  - Debian/Ubuntu: `sudo apt-get install poppler-utils`
  - macOS: `brew install poppler`
  - Windows: install a [Poppler for Windows](https://github.com/oschwartz10612/poppler-windows) build and add its `bin/` folder to `PATH`

## Development

```sh
yarn install
yarn tauri dev
```

## Building locally

```sh
yarn tauri build
```

Bundled artifacts land under `src-tauri/target/release/bundle/`.

## Building for Linux (automated)

The [`Release Linux`](.github/workflows/release-linux.yml) GitHub Actions workflow builds `.deb`, `.rpm`, and `.AppImage` artifacts and publishes them as a draft GitHub Release. It runs automatically whenever a version tag is pushed:

```sh
git tag v0.1.0
git push origin v0.1.0
```

You can also trigger it manually from the Actions tab (`workflow_dispatch`). Review the draft release and publish it once you're happy with it.

## Building for macOS (manual)

There's no macOS CI in this repo yet, so producing a macOS build means running it locally on a Mac:

1. Install the Xcode Command Line Tools:
   ```sh
   xcode-select --install
   ```
2. Install [Homebrew](https://brew.sh) if you don't already have it.
3. Install Rust:
   ```sh
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```
   then restart your shell (or `source "$HOME/.cargo/env"`).
4. Install Node.js and Yarn:
   ```sh
   brew install node
   npm install -g yarn
   ```
5. Install Poppler (required at runtime, see [Prerequisites](#prerequisites)):
   ```sh
   brew install poppler
   ```
6. Clone the repo and install JS dependencies:
   ```sh
   git clone git@github.com:andeerlb/clock-analytics.git
   cd clock-analytics
   yarn install
   ```
7. Build the app:
   ```sh
   yarn tauri build
   ```
8. The `.app` bundle and `.dmg` installer are written to `src-tauri/target/release/bundle/macos/` and `src-tauri/target/release/bundle/dmg/` respectively.

**Note on code signing:** this produces an unsigned, non-notarized build. Opening it on another Mac will trigger Gatekeeper warnings. To distribute it publicly, you'll need an Apple Developer ID and to configure signing/notarization under `bundle.macOS` in `src-tauri/tauri.conf.json` — see [Tauri's macOS code-signing guide](https://tauri.app/distribute/sign/macos/).

## Known limitations

- **Poppler isn't bundled yet.** The app shells out to `pdftotext`/`pdfseparate`/`pdfinfo`/`pdfunite` as external processes rather than bundling them as a Tauri sidecar per platform. Any machine running the app (not just the build machine) needs Poppler installed and on `PATH`. See `src-tauri/src/pdf_extract.rs` for the rationale.
- **One timesheet provider today.** Only the Coalize export format is supported; additional providers can be added under `src-tauri/src/parsers/` without changing the rest of the app.
- **Windows isn't covered by CI yet.** Only Linux is automated via GitHub Actions; macOS is manual (above), and Windows builds are untested by this repo's tooling so far.
