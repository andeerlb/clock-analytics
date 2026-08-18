import { emit, listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import PaymentReconciliationScreen from "../components/PaymentReconciliationScreen";
import {
  applyPaymentsFiltersSnapshot,
  RECONCILIATION_WINDOW_READY_EVENT,
  SEED_PAYMENTS_FILTERS_EVENT,
  usePaymentsFilters,
  type PaymentsFiltersSnapshot,
} from "../contexts/FiltersContext";
import { listClients, listCompanies, listDistinctPaymentShiftLocals, listRolesGlobal, type ClientRow, type CompanyRow, type RoleRow } from "../lib/db";

/**
 * The whole content of "Conferência" on `PaymentsPage`
 * (`open_reconciliation_window`) — `App.tsx` renders this instead of the
 * normal app shell whenever `getCurrentWindow().label === "reconciliation"`.
 * It always opens as its own OS window, never as an in-app modal, and
 * closes via its own native OS chrome — no in-app "Anexar" back into the
 * main window. Its own `FiltersProvider` (see `App.tsx`) starts at the same
 * defaults as any fresh one, so this asks the main window for its current
 * Pagamentos filters right after mounting
 * (`RECONCILIATION_WINDOW_READY_EVENT`/`SEED_PAYMENTS_FILTERS_EVENT` — see
 * `FiltersContext.tsx`) instead of opening on an empty/default list. A
 * one-time seed, not a subscription: from this point on the two windows'
 * filters evolve independently, only the underlying *data* stays in sync
 * (via `PAYMENT_SHIFTS_CHANGED_EVENT`, inside `PaymentReconciliationScreen`
 * itself).
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

  if (loadError) {
    return (
      <div className="error-box" style={{ margin: "1.2rem" }}>
        Não foi possível carregar esta janela: {loadError}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", width: "100vw" }}>
      <PaymentReconciliationScreen companies={companies} clients={clients} roles={roles} locals={locals} />
    </div>
  );
}
