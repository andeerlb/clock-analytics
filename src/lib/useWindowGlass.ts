import { useEffect } from "react";
import { setWindowGlass } from "./api";

/**
 * Turns on the native window blur-behind for as long as `active` is true —
 * used by `Modal`/`Drawer` for their full lifetime (open + closing-animation).
 *
 * Stamps `document.documentElement` with exactly one of two classes once
 * `setWindowGlass` resolves (see the `:root.glass-native`/`:root.glass-css-only`
 * rules in App.css):
 * - `glass-native` when the backend confirms a real native effect (Windows/
 *   macOS) — the desktop shows blurred through the dimmed backdrop area.
 * - `glass-css-only` everywhere else (Linux). This does *not* mean "fall
 *   back to the CSS `backdrop-filter` blur" — WebKitGTK's support for it is
 *   unreliable enough (works on some driver/compositor combos, silently
 *   renders as flat, unblurred transparency on others — letting whatever's
 *   behind the modal/drawer show straight through) that leaning on it to
 *   hide the app's own content isn't safe. Linux instead goes fully opaque.
 */
export function useWindowGlass(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setWindowGlass(true)
      .then((native) => {
        if (!cancelled) document.documentElement.classList.add(native ? "glass-native" : "glass-css-only");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      document.documentElement.classList.remove("glass-native", "glass-css-only");
      setWindowGlass(false).catch(() => {});
    };
  }, [active]);
}
