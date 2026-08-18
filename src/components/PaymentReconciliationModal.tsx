import { useEffect, useState } from "react";
import { openReconciliationWindow } from "../lib/api";
import { listClients, listCompanies, listDistinctPaymentShiftLocals, listRolesGlobal, type ClientRow, type CompanyRow, type RoleRow } from "../lib/db";
import Modal from "./Modal";
import PaymentReconciliationScreen from "./PaymentReconciliationScreen";

/**
 * In-app "Conferência de Pagamentos" — `PaymentReconciliationScreen` run
 * inside `Modal`'s `fullScreen` surface, closing on Escape/backdrop-click
 * like every other modal (unless the filters drawer it opens is up, same
 * as before). "Destacar" moves the same screen into its own OS window
 * instead (`open_reconciliation_window`) and closes this one — see
 * `PaymentReconciliationWindowPage` for that side, and
 * `PaymentReconciliationScreen`'s own doc comment for how the two stay in
 * sync.
 *
 * Fetches its own companies/clients/roles/locals rather than taking them as
 * props from whichever page opened it — this is mounted from two different
 * places now (`PaymentsPage`'s "Conferência" button, and
 * `ReconciliationModalProvider` in response to "Anexar" from a detached
 * window, which has no `PaymentsPage` instance to source them from), so
 * self-sufficiency is simpler than coordinating a shared fetch between
 * them. Same small `Promise.all` `PaymentReconciliationWindowPage` already
 * does for the same reason.
 */
export default function PaymentReconciliationModal({ onClose }: { onClose: () => void }) {
  const [filtersDrawerOpen, setFiltersDrawerOpen] = useState(false);
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

  return (
    <Modal fullScreen zIndex={100} onClose={onClose} closeOnEscape={!filtersDrawerOpen}>
      {loadError ? (
        <div className="error-box" style={{ margin: "1.2rem" }}>
          Não foi possível carregar a Conferência de Pagamentos: {loadError}
        </div>
      ) : (
        <PaymentReconciliationScreen
          companies={companies}
          clients={clients}
          roles={roles}
          locals={locals}
          embedded
          onFiltersDrawerOpenChange={setFiltersDrawerOpen}
          onDetach={() => {
            openReconciliationWindow().catch(() => {});
            onClose();
          }}
        />
      )}
    </Modal>
  );
}
