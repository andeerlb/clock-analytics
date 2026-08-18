import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { isReconciliationWindowOpen, openReconciliationWindow } from "../lib/api";
import {
  applyPaymentsFiltersSnapshot,
  REATTACH_RECONCILIATION_EVENT,
  usePaymentsFilters,
  type PaymentsFiltersSnapshot,
} from "./FiltersContext";

interface ReconciliationModalState {
  open: boolean;
  openReconciliation: () => void;
  closeReconciliation: () => void;
}

const ReconciliationModalContext = createContext<ReconciliationModalState | null>(null);

/**
 * Owns whether "Conferência de Pagamentos" is open in the main window —
 * lifted here (mounted once in `App.tsx`'s shell, outside the router)
 * instead of living as `PaymentsPage`-local state, because it now has two
 * triggers that don't share a common ancestor: the "Conferência" button on
 * `PaymentsPage` (which may not even be mounted at the time of the other
 * one) and "Anexar" on the detached window (`PaymentReconciliationWindowPage`),
 * which reattaches by emitting `REATTACH_RECONCILIATION_EVENT` at "main"
 * and closing itself — this provider is what's listening on the other end,
 * seeding this window's `usePaymentsFilters()` with whatever the detached
 * window's filters were and opening the modal in response.
 */
export function ReconciliationModalProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const paymentsFilters = usePaymentsFilters();

  useEffect(() => {
    const unlisten = listen<PaymentsFiltersSnapshot>(REATTACH_RECONCILIATION_EVENT, (event) => {
      applyPaymentsFiltersSnapshot(paymentsFilters, event.payload);
      setOpen(true);
      const win = getCurrentWindow();
      win.show().catch(() => {});
      win.setFocus().catch(() => {});
    });
    return () => {
      unlisten.then((f) => f()).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value: ReconciliationModalState = {
    open,
    // Checks for an already-detached window first — "Conferência" (the only
    // caller of this) must never open the in-app `Modal` on top of one
    // that's already running standalone; it should just bring that window
    // forward instead, exactly like clicking "Destacar" a second time
    // already does (`open_reconciliation_window`'s own existing-window
    // check) — same one-surface-at-a-time rule, just reachable from the
    // other trigger too.
    openReconciliation: () => {
      isReconciliationWindowOpen()
        .then((alreadyDetached) => {
          if (alreadyDetached) {
            openReconciliationWindow().catch(() => {});
          } else {
            setOpen(true);
          }
        })
        .catch(() => setOpen(true));
    },
    closeReconciliation: () => setOpen(false),
  };

  return <ReconciliationModalContext.Provider value={value}>{children}</ReconciliationModalContext.Provider>;
}

export function useReconciliationModal(): ReconciliationModalState {
  const ctx = useContext(ReconciliationModalContext);
  if (!ctx) throw new Error("useReconciliationModal must be used within a ReconciliationModalProvider");
  return ctx;
}
