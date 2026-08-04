# PontoScan

A cross-platform desktop app (Linux, macOS, Windows) built with [Tauri](https://tauri.app/) for ingesting Brazilian "Espelho Ponto" (timesheet) PDF exports, parsing punch data per employee/day, and analyzing it locally — no data ever leaves the machine, everything is persisted to a local SQLite database.

## Features

- **Extensible parser architecture.** Timesheet providers are plugged in via a `TimesheetParser` trait + registry (see `src-tauri/src/parsers/`); adding a new export format doesn't touch the rest of the app. The [Coalize](https://coalize.com.br/) export format is supported today.
- **Robust PDF import.** Handles single-file and multi-page batch exports (one employee per page), content-hash based duplicate detection (independent of filename/path), and resilient parsing — one bad page in a batch doesn't fail the whole import.
- **Companies, Clients, Employees.** A company can have many clients and a client can be linked to more than one company (many-to-many); employees and their imported timesheets are scoped to a client.
- **Cartão de Ponto (employee detail).** A full day-by-day breakdown per import, with dynamic Entrada/Saída columns, computed metrics (worked hours, overtime, faltas/atrasos, breaks), and a multi-select filter over per-day status.
- **Colaboradores.** The main list of already-imported timesheets, filterable by name, company, client, period, and per-period status — the same filters double as a report generator, bundling the matching employees' original PDFs into a single ZIP organized in `Company/Client/` folders, either one PDF per employee or one merged PDF per client.
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
- **Poppler utilities installed** — `pdftotext`, `pdfseparate`, `pdfinfo`, and `pdfunite`. These aren't bundled with the app yet (see [PDF tooling (Poppler)](#pdf-tooling-poppler) and [Known limitations](#known-limitations)), so they're required both for local development and on any machine that runs the packaged app.
  - Debian/Ubuntu: `sudo apt-get install poppler-utils`
  - macOS: `brew install poppler`
  - Windows: **not currently supported** — see [PDF tooling (Poppler)](#pdf-tooling-poppler) below.

## PDF tooling (Poppler)

The app shells out to four Poppler CLI tools — `pdfinfo`, `pdftotext`, `pdfseparate`, `pdfunite` — for page counting, text extraction, and PDF splitting/merging. They're **not bundled** with the app (see [Known limitations](#known-limitations)), so they need to already be installed on whatever machine runs it, dev or packaged.

**macOS.** `brew install poppler` is enough — no `PATH` setup required. A packaged `.app` opened from Finder is launched with a minimal `PATH` that doesn't include Homebrew's `bin/`, so the app looks for the tools directly in the well-known install locations instead of relying on `PATH`: `/opt/homebrew/bin` (Apple Silicon Homebrew), `/usr/local/bin` (Intel Homebrew), and `/opt/local/bin` (MacPorts). See `src-tauri/src/poppler.rs`.

**Linux.** `sudo apt-get install poppler-utils` (or your distro's equivalent) installs to `/usr/bin`, which is on `PATH` for GUI-launched apps in most desktop environments — no extra setup needed. `/usr/bin` is also checked directly as a fallback, same as the macOS locations above.

**Windows — not currently supported.** There's no bundled or auto-detected Poppler for Windows, and no Windows build is produced by this repo's tooling yet (see [Known limitations](#known-limitations)). If you build for Windows yourself, you'd need to install a [Poppler for Windows](https://github.com/oschwartz10612/poppler-windows) build and add its `bin/` folder to `PATH` — but note the packaged-app `PATH` caveat above likely applies there too, and hasn't been addressed for Windows.

**If auto-detection doesn't find it** (a non-Homebrew/MacPorts/apt install, or a custom location), open **Configurações** in the app — it shows the resolved status of each of the four tools and lets you point at the folder containing them manually. The app also checks on startup and shows a banner linking to Configurações if anything's missing.

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

## Building for Linux and macOS (automated)

The [`Release`](.github/workflows/release.yml) GitHub Actions workflow builds `.deb`/`.rpm`/`.AppImage` (Linux) and a universal `.app`/`.dmg` that runs on both Apple Silicon and Intel Macs, publishing everything to a single draft GitHub Release. It runs automatically whenever a version tag is pushed.

Bump the version *before* tagging, so the tag actually points at the commit it describes (the app reads its own version at runtime — Configurações shows it and flags when a newer GitHub Release exists — so this has to be accurate):

```sh
yarn version:bump 0.2.0
git commit -am "chore: bump version to 0.2.0"
git tag v0.2.0
git push origin master v0.2.0
```

You can also trigger the workflow manually from the Actions tab (`workflow_dispatch`), e.g. to rebuild an existing tag. Review the draft release and publish it once you're happy with it.

The macOS artifacts are unsigned and non-notarized (see the code-signing note below) — CI has no Apple Developer ID to sign with, so opening them will trigger Gatekeeper warnings just like a manual build.

## Building for macOS locally (manual)

The steps below are for iterating on a Mac without waiting on CI, or for signing/notarizing a build yourself — the automated workflow above already produces a macOS build on every tag push.

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

- **Poppler isn't bundled yet.** The app shells out to `pdftotext`/`pdfseparate`/`pdfinfo`/`pdfunite` as external processes rather than bundling them as a Tauri sidecar per platform. Any machine running the app (not just the build machine) needs Poppler installed — see [PDF tooling (Poppler)](#pdf-tooling-poppler). macOS and Linux auto-detect common install locations (with a manual override in Configurações); Windows has no equivalent yet and isn't a supported target.
- **One timesheet provider today.** Only the Coalize export format is supported; additional providers can be added under `src-tauri/src/parsers/` without changing the rest of the app.
- **Windows isn't covered by CI yet.** Linux and macOS are automated via GitHub Actions (the macOS build is unsigned/non-notarized); Windows builds are untested by this repo's tooling so far.
