//! Real OS-level window blur-behind (Windows Acrylic, macOS Vibrancy),
//! applied once when a window is created and left on for that window's whole
//! lifetime — see `enable` below, called from both `lib.rs`'s `setup` (the
//! main window) and `commands::open_reconciliation_window` (the "Destacar"
//! detached window), and `useWindowGlassInit` in
//! `src/lib/useWindowGlass.ts`, which reads back whether it actually took
//! via `window_glass_active` and stamps `document.documentElement`
//! accordingly. Each `window` must itself be created with `transparent:
//! true` or the effect has nothing to show through.
//!
//! `window-vibrancy` has no Linux implementation (blur-behind is a
//! per-compositor thing with no common API — see the discussion that
//! prompted this module), so that target's `enable` always reports "no
//! native effect", which leaves `.modal-overlay`/`.drawer-overlay`'s
//! existing CSS-only `backdrop-filter` blur (of the app's own content, not
//! the desktop) exactly as it already was.

/// Whether `enable` actually turned the native effect on for this app run —
/// read back by the frontend once at startup via `window_glass_active` so
/// it can pick between the `glass-native`/`glass-css-only` CSS treatments
/// in App.css. Managed as Tauri state from `lib.rs`.
pub struct WindowGlassState(pub bool);

#[cfg(target_os = "windows")]
pub fn enable(window: &tauri::WebviewWindow) -> Result<(), String> {
    // Same hue as `--bg` (#0b0e14), tinted heavily opaque (235/255) rather
    // than the ~50% this started at — Acrylic's own blur+noise texture
    // already lightens whatever's behind it, so a merely-half-opaque tint
    // read as a washed-out gray haze instead of a continuation of the app's
    // dark theme, especially over a bright/colorful desktop.
    window_vibrancy::apply_acrylic(window, Some((11, 14, 20, 235))).map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
pub fn enable(window: &tauri::WebviewWindow) -> Result<(), String> {
    window_vibrancy::apply_vibrancy(window, window_vibrancy::NSVisualEffectMaterial::HudWindow, None, None)
        .map_err(|e| e.to_string())
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn enable(_window: &tauri::WebviewWindow) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn window_glass_active(state: tauri::State<WindowGlassState>) -> bool {
    state.0
}
