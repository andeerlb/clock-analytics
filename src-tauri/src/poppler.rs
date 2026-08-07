use std::path::{Path, PathBuf};

/// The Poppler CLI tools this app shells out to.
pub const BINARIES: [&str; 4] = ["pdfinfo", "pdftotext", "pdfseparate", "pdfunite"];

#[cfg(target_os = "windows")]
fn executable_name(name: &str) -> String {
    format!("{name}.exe")
}

#[cfg(not(target_os = "windows"))]
fn executable_name(name: &str) -> String {
    name.to_string()
}

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
        "/Program Files/Poppler/bin", // Windows
        "/Program Files (x86)/Poppler/bin", // Windows
        "C:/Program Files/Poppler/bin", // Windows
        "C:/Program Files (x86)/Poppler/bin", // Windows
        "C:/poppler/bin", // Windows
    ];

    let executable_name = executable_name(name);

    if let Some(dir) = custom_dir {
        let path = Path::new(dir).join(&executable_name);
        if path.is_file() {
            return path;
        }
    }

    KNOWN_DIRS
        .iter()
        .map(|dir| Path::new(dir).join(&executable_name))
        .find(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from(executable_name))
}

#[cfg(test)]
mod tests {
    use super::resolve;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(prefix: &str) -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock moved backwards")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("{prefix}-{unique}"));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn resolves_poppler_binary_inside_custom_dir() {
        let dir = temp_dir("poppler-resolve");
        let file_name = if cfg!(target_os = "windows") {
            "pdfinfo.exe"
        } else {
            "pdfinfo"
        };
        let file_path = dir.join(file_name);
        fs::write(&file_path, b"").expect("create stub binary");

        let resolved = resolve("pdfinfo", Some(dir.to_string_lossy().as_ref()));

        assert_eq!(resolved, file_path);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn falls_back_to_platform_executable_name() {
        let resolved = resolve("pdfinfo", None);

        if cfg!(target_os = "windows") {
            assert_eq!(resolved, PathBuf::from("pdfinfo.exe"));
        } else {
            assert_eq!(resolved, PathBuf::from("pdfinfo"));
        }
    }
}
