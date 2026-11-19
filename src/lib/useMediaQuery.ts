import { useEffect, useState } from "react";

/** The phone layout (top bar, menu over the page): see `@media (max-width: 760px)` in App.css. */
export const PHONE_QUERY = "(max-width: 760px)";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => (typeof window !== "undefined" ? window.matchMedia(query).matches : false));
  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    onChange();
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}
