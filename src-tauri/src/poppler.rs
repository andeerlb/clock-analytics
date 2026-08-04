use std::path::{Path, PathBuf};

/// The Poppler CLI tools this app shells out to.
pub const BINARIES: [&str; 4] = ["pdfinfo", "pdftotext", "pdfseparate", "pdfunite"];

/// Resolves a Poppler CLI tool (`pdfinfo`, `pdftotext`, `pdfseparate`,
/// `pdfunite`) to an absolute path when possible, instead of relying on
/// `$PATH`.
///
/// `cargo tauri dev` runs with the launching terminal's `$PATH`, which on a
/// dev machine includes Homebrew's bin dir — so a bare `Command::new("pdfinfo")`
/// works there. A packaged `.app` opened from Finder/Launchpad is started by
/// launchd with a minimal PATH (no `/usr/local/bin` or `/opt/homebrew/bin`),
/// so the same call fails with "No such file or directory" even though
/// Poppler is installed. Checking the well-known Homebrew/MacPorts install
/// locations directly sidesteps that.
///
/// `custom_dir` — the user-supplied override from Configurações — is tried
/// first, so it wins over the auto-detected locations when set. Falls back
/// to the bare name (a `$PATH` lookup) if nothing else matched, so this
/// still works for a Poppler installed somewhere else while running from a
/// terminal.
///
/// macOS-only in practice: these are Homebrew/MacPorts/apt install
/// locations, and `PathBuf` isn't given a `.exe` suffix. Linux (see
/// `.github/workflows/release-linux.yml`, which apt-installs
/// `poppler-utils` to `/usr/bin`) likely doesn't need this at all — Linux
/// desktop sessions generally pass the login shell's `$PATH` through to
/// GUI-launched apps, unlike macOS's launchd — but `/usr/bin` is checked
/// too as a cheap safety net. There's no Windows build target yet; if one
/// is added, this needs its own resolution (Poppler isn't preinstalled or
/// on `$PATH` on Windows the way it can be via Homebrew/apt, so bundling it
/// as a sidecar is more likely the right call there than path-guessing).
pub fn resolve(name: &str, custom_dir: Option<&str>) -> PathBuf {
    const KNOWN_DIRS: [&str; 4] = [
        "/opt/homebrew/bin", // Homebrew on Apple Silicon
        "/usr/local/bin",    // Homebrew on Intel
        "/opt/local/bin",    // MacPorts
        "/usr/bin",          // apt/dnf poppler-utils on Linux
    ];

    if let Some(dir) = custom_dir {
        let path = Path::new(dir).join(name);
        if path.is_file() {
            return path;
        }
    }

    KNOWN_DIRS
        .iter()
        .map(|dir| Path::new(dir).join(name))
        .find(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from(name))
}
