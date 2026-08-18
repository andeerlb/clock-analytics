import { useEffect } from "react";
import { setWindowGlass } from "./api";

/**
 * Turns on the native window blur-behind for as long as `active` is true —
 * used by `Modal`/`Drawer` for their full lifetime (open + closing-animation),
 * so the desktop shows real, OS-blurred through their dimmed backdrop area
 * instead of just the CSS `backdrop-filter` blur of the app's own content.
 *
 * `document.documentElement`'s `glass-native` class (see the `:root.glass-native`
 * rules in App.css) is only added once the backend confirms a native effect
 * actually applies — on Linux `setWindowGlass` resolves `false`, so the class
 * never lands and `.modal-overlay`/`.drawer-overlay` fall back to their
 * existing CSS-only blur exactly as before this feature existed.
 */
export function useWindowGlass(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setWindowGlass(true)
      .then((native) => {
        if (!cancelled && native) document.documentElement.classList.add("glass-native");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      document.documentElement.classList.remove("glass-native");
      setWindowGlass(false).catch(() => {});
    };
  }, [active]);
}
