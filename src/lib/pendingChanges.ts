import { useEffect, useState } from "react";

/**
 * How many "atualizações pendentes" there are, shared between the floating
 * card that fetches them (`PendingChangesTab`) and the phone layout, which
 * hides that card and shows the number in the menu instead.
 */

let count = 0;
const listeners = new Set<(n: number) => void>();

export function setPendingChangesCount(n: number) {
  if (n === count) return;
  count = n;
  listeners.forEach((listener) => listener(n));
}

export function usePendingChangesCount(): number {
  const [n, setN] = useState(count);
  useEffect(() => {
    listeners.add(setN);
    setN(count);
    return () => {
      listeners.delete(setN);
    };
  }, []);
  return n;
}

/** Opens the review Drawer of `PendingChangesTab` from elsewhere (the phone menu). */
export const OPEN_PENDING_CHANGES_EVENT = "tapago:open-pending-changes";

export function openPendingChanges() {
  window.dispatchEvent(new Event(OPEN_PENDING_CHANGES_EVENT));
}
