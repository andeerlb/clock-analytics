import { Plus, User } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import Pagination from "../components/Pagination";
import { listEmployeesGlobal, type EmployeeRow } from "../lib/db";
import { formatCpf } from "../lib/format";

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

export default function EmployeesPage() {
  const navigate = useNavigate();
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_OPTIONS[0]);

  useEffect(() => {
    listEmployeesGlobal()
      .then(setEmployees)
      .finally(() => setLoading(false));
  }, []);

  const pageCount = Math.max(1, Math.ceil(employees.length / pageSize));
  const pageItems = useMemo(
    () => employees.slice(page * pageSize, page * pageSize + pageSize),
    [employees, page, pageSize],
  );

  return (
    <div>
      <div className="page-header">
        <h2>Colaboradores</h2>
        <button type="button" onClick={() => navigate("/employees/new")}>
          <Plus size={15} style={{ marginRight: "0.4rem" }} />
          Novo colaborador
        </button>
      </div>
      <p className="page-subtitle">
        Cadastro de colaboradores, independente de espelho de ponto ou pagamento importado. O CPF
        é único por cliente — o mesmo CPF pode existir para clientes diferentes.
      </p>

      <div className="card table-card">
        {loading && <p className="muted" style={{ padding: "1.4rem" }}>Carregando...</p>}
        {!loading && employees.length === 0 && (
          <p className="muted" style={{ padding: "1.4rem" }}>
            Nenhum colaborador cadastrado ainda.
          </p>
        )}
        {employees.length > 0 && (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Colaborador</th>
                    <th>CPF</th>
                    <th>Matrícula</th>
                    <th>Cliente</th>
                    <th>Empresa</th>
                  </tr>
                </thead>
                <tbody>
                  {pageItems.map((e) => (
                    <tr key={e.id}>
                      <td>
                        <div className="person-cell">
                          <span className="avatar" style={{ background: "var(--surface-variant)" }}>
                            <User size={15} />
                          </span>
                          <Link to={`/employees/${e.id}`}>{e.name}</Link>
                        </div>
                      </td>
                      <td className="mono">{formatCpf(e.cpf)}</td>
                      <td className="mono">{e.matricula ?? "—"}</td>
                      <td>{e.clientName}</td>
                      <td>{e.companyName}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {employees.length > PAGE_SIZE_OPTIONS[0] && (
              <Pagination
                page={page}
                pageCount={pageCount}
                onPageChange={setPage}
                rangeLabel={`Mostrando ${page * pageSize + 1} a ${Math.min(
                  employees.length,
                  page * pageSize + pageSize,
                )} de ${employees.length}`}
                pageSize={pageSize}
                pageSizeOptions={PAGE_SIZE_OPTIONS}
                onPageSizeChange={(size) => {
                  setPageSize(size);
                  setPage(0);
                }}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
