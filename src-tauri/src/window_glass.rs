//! Real OS-level window blur-behind (Windows Acrylic, macOS Vibrancy),
//! toggled on for exactly as long as a `Modal`/`Drawer` backdrop is on
//! screen — see `useWindowGlass` in `src/lib/useWindowGlass.ts`. `window`
//! itself must be created with `transparent: true` (see `tauri.conf.json`)
//! or neither effect has anything to show through.
//!
//! `window-vibrancy` has no Linux implementation (blur-behind is a
//! per-compositor thing with no common API — see the discussion that
//! prompted this module), so that target gets its own trivial command
//! below that always reports "no native effect" back to the frontend,
//! which then leaves `.modal-overlay`/`.drawer-overlay`'s existing
//! CSS-only `backdrop-filter` blur (of the app's own content, not the
//! desktop) exactly as it already was.

#[cfg(target_os = "windows")]
#[tauri::command]
pub fn set_window_glass(window: tauri::WebviewWindow, active: bool) -> Result<bool, String> {
    let result = if active {
        // Dark, mostly-opaque tint so the acrylic material reads as a
        // continuation of the app's own dark theme rather than a bright
        // Windows-default frosted panel.
        window_vibrancy::apply_acrylic(&window, Some((18, 18, 18, 125)))
    } else {
        window_vibrancy::clear_acrylic(&window)
    };
    result.map(|_| true).map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn set_window_glass(window: tauri::WebviewWindow, active: bool) -> Result<bool, String> {
    let result = if active {
        window_vibrancy::apply_vibrancy(
            &window,
            window_vibrancy::NSVisualEffectMaterial::HudWindow,
            None,
            None,
        )
    } else {
        window_vibrancy::clear_vibrancy(&window).map(|_| ())
    };
    result.map(|_| true).map_err(|e| e.to_string())
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
#[tauri::command]
pub fn set_window_glass(_window: tauri::WebviewWindow, _active: bool) -> Result<bool, String> {
    Ok(false)
}
