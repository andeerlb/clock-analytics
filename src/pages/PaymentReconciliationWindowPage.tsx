import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import PaymentReconciliationScreen from "../components/PaymentReconciliationScreen";
import {
  applyPaymentsFiltersSnapshot,
  MAIN_WINDOW_LABEL,
  REATTACH_RECONCILIATION_EVENT,
  RECONCILIATION_WINDOW_READY_EVENT,
  SEED_PAYMENTS_FILTERS_EVENT,
  snapshotPaymentsFilters,
  usePaymentsFilters,
  type PaymentsFiltersSnapshot,
} from "../contexts/FiltersContext";
import { listClients, listCompanies, listDistinctPaymentShiftLocals, listRolesGlobal, type ClientRow, type CompanyRow, type RoleRow } from "../lib/db";

/**
 * The whole content of the "Destacar" window (`open_reconciliation_window`)
 * — `App.tsx` renders this instead of the normal app shell whenever
 * `getCurrentWindow().label === "reconciliation"`. Its own `FiltersProvider`
 * (see `App.tsx`) starts at the same defaults as any fresh one, so this
 * asks the main window for its current Pagamentos filters right after
 * mounting (`RECONCILIATION_WINDOW_READY_EVENT`/`SEED_PAYMENTS_FILTERS_EVENT`
 * — see `FiltersContext.tsx`) instead of opening on an empty/default list.
 * A one-time seed, not a subscription: from this point on the two windows'
 * filters evolve independently, only the underlying *data* stays in sync
 * (via `PAYMENT_SHIFTS_CHANGED_EVENT`, inside `PaymentReconciliationScreen`
 * itself) — until "Anexar" (`handleReattach` below) sends this window's
 * current filters back to main and closes this window, the reverse of the
 * handshake this page opened with.
 */
export default function PaymentReconciliationWindowPage() {
  const paymentsFilters = usePaymentsFilters();
  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [locals, setLocals] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([listCompanies(), listClients(), listRolesGlobal(), listDistinctPaymentShiftLocals()])
      .then(([companyRows, clientRows, roleRows, localValues]) => {
        setCompanies(companyRows);
        setClients(clientRows);
        setRoles(roleRows);
        setLocals(localValues);
      })
      .catch((e) => setLoadError(String(e instanceof Error ? e.message : e)));
  }, []);

  useEffect(() => {
    const unlisten = listen<PaymentsFiltersSnapshot>(SEED_PAYMENTS_FILTERS_EVENT, (event) => {
      applyPaymentsFiltersSnapshot(paymentsFilters, event.payload);
    });
    emit(RECONCILIATION_WINDOW_READY_EVENT).catch(() => {});
    return () => {
      unlisten.then((f) => f()).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleReattach() {
    emitTo(MAIN_WINDOW_LABEL, REATTACH_RECONCILIATION_EVENT, snapshotPaymentsFilters(paymentsFilters)).catch(() => {});
    getCurrentWindow().close().catch(() => {});
  }

  if (loadError) {
    return (
      <div className="error-box" style={{ margin: "1.2rem" }}>
        Não foi possível carregar esta janela: {loadError}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", width: "100vw" }}>
      <PaymentReconciliationScreen
        companies={companies}
        clients={clients}
        roles={roles}
        locals={locals}
        embedded={false}
        onReattach={handleReattach}
      />
    </div>
  );
}
