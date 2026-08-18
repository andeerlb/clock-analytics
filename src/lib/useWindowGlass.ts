import { useEffect } from "react";
import { isWindowGlassActive } from "./api";

/**
 * Reads back, once at app startup, whether the native window blur-behind
 * (Windows Acrylic, macOS Vibrancy) — applied once in Rust for the window's
 * whole lifetime, not toggled per Modal/Drawer — actually took, and stamps
 * `document.documentElement` with exactly one of two classes
 * (see the `:root.glass-native`/`:root.glass-css-only` rules in App.css):
 * - `glass-native` when the backend confirms a real native effect (Windows/
 *   macOS) — the desktop shows blurred through the app's own transparent
 *   regions, permanently.
 * - `glass-css-only` everywhere else (Linux). This does *not* mean "fall
 *   back to the CSS `backdrop-filter` blur" — WebKitGTK's support for it is
 *   unreliable enough (works on some driver/compositor combos, silently
 *   renders as flat, unblurred transparency on others) that leaning on it to
 *   hide the app's own content isn't safe. Linux instead goes fully opaque.
 *
 * Called once from `App`, not from `Modal`/`Drawer` — the class, once set,
 * is never removed for the life of the window. Runs the same way in both
 * windows this app ever creates ("main" and the "Destacar"-detached
 * "reconciliation" one) — both are built with `transparent: true` and get
 * `window_glass::enable` called on them (see `lib.rs`'s `setup` and
 * `commands::open_reconciliation_window`), so there's always something
 * behind `glass-native`'s dropped `--bg` to show through.
 */
export function useWindowGlassInit(): void {
  useEffect(() => {
    let cancelled = false;
    isWindowGlassActive()
      .then((native) => {
        if (!cancelled) document.documentElement.classList.add(native ? "glass-native" : "glass-css-only");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
}
