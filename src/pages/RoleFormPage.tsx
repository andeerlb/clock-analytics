import { Info, Plus, Tags, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import BackButton from "../components/BackButton";
import ConfirmModal from "../components/ConfirmModal";
import FormPanel from "../components/FormPanel";
import {
  addRoleAlias,
  createRole,
  deleteRole,
  getRole,
  listCompanies,
  listRoleAliases,
  removeRoleAlias,
  updateRole,
  type CompanyRow,
  type RoleAliasRow,
} from "../lib/db";

/**
 * What a "Cadastrar função" shortcut (from the payment import preview) hands
 * off — a name to start the form pre-filled with, and, whenever the
 * shortcut already resolved exactly which empresa the turno belongs to
 * (via a template's routing rule), that too.
 */
export interface RoleFormNavState {
  prefillName?: string;
  prefillCompanyId?: number;
}

export default function RoleFormPage() {
  const { id } = useParams<{ id: string }>();
  const isEditing = id !== undefined;
  const navigate = useNavigate();
  const location = useLocation();
  const prefill = !isEditing ? (location.state as RoleFormNavState | null) : null;

  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [companyId, setCompanyId] = useState(
    prefill?.prefillCompanyId !== undefined ? String(prefill.prefillCompanyId) : "",
  );
  const [companyName, setCompanyName] = useState("");
  const [name, setName] = useState(prefill?.prefillName ?? "");
  const [loading, setLoading] = useState(isEditing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [aliases, setAliases] = useState<RoleAliasRow[]>([]);
  const [newAlias, setNewAlias] = useState("");
  const [aliasBusy, setAliasBusy] = useState(false);
  const [aliasError, setAliasError] = useState<string | null>(null);

  // "Excluir função" — não apaga turnos já importados, só desvincula o
  // role_id deles (ver `deleteRole`). Ainda assim irreversível o bastante
  // pra pedir confirmação.
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleConfirmDelete() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteRole(Number(id));
      navigate("/roles");
    } catch (e) {
      setDeleteError(String(e instanceof Error ? e.message : e));
    } finally {
      setDeleting(false);
    }
  }

  useEffect(() => {
    if (isEditing) {
      getRole(Number(id))
        .then((r) => {
          setName(r.name);
          setCompanyId(String(r.companyId));
        })
        .catch((e) => setError(String(e instanceof Error ? e.message : e)))
        .finally(() => setLoading(false));
      listRoleAliases(Number(id)).then(setAliases);
    } else {
      listCompanies().then(setCompanies);
    }
  }, [id, isEditing]);

  useEffect(() => {
    if (!isEditing || companies.length === 0) return;
    const match = companies.find((c) => String(c.id) === companyId);
    if (match) setCompanyName(match.name);
  }, [isEditing, companies, companyId]);

  useEffect(() => {
    if (isEditing) listCompanies().then(setCompanies);
  }, [isEditing]);

  async function handleAddAlias(e: React.FormEvent) {
    e.preventDefault();
    setAliasError(null);
    setAliasBusy(true);
    try {
      await addRoleAlias(Number(id), newAlias);
      setNewAlias("");
      setAliases(await listRoleAliases(Number(id)));
    } catch (err) {
      setAliasError(String(err instanceof Error ? err.message : err));
    } finally {
      setAliasBusy(false);
    }
  }

  async function handleRemoveAlias(aliasId: number) {
    await removeRoleAlias(aliasId);
    setAliases((prev) => prev.filter((a) => a.id !== aliasId));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (isEditing) {
        await updateRole(Number(id), name);
      } else {
        await createRole(Number(companyId), name);
      }
      // Same go-back-if-possible logic as `BackButton` — when this form was
      // opened from the payment import preview's "Cadastrar função"
      // shortcut, this returns to that exact preview state instead of
      // always landing on the listing.
      if ((window.history.state?.idx ?? 0) > 0) {
        navigate(-1);
      } else {
        navigate("/roles");
      }
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <BackButton fallback="/roles" />
        <h2 style={{ margin: 0 }}>{isEditing ? "Editar função" : "Nova função"}</h2>
      </div>
      <p className="page-subtitle">
        {isEditing
          ? "Empresa não pode ser alterada aqui — mudar de empresa é, na prática, uma função diferente."
          : "O nome é único por empresa — a mesma função pode existir para empresas diferentes."}
      </p>

      {error && <div className="error-box">{error}</div>}

      <div className="details-main" style={{ maxWidth: "52rem" }}>
        {loading ? (
          <p className="muted">Carregando...</p>
        ) : (
          <FormPanel icon={Info} title="Informações Gerais">
            <form onSubmit={handleSubmit}>
              {isEditing ? (
                <div className="field" style={{ marginBottom: "1rem" }}>
                  <label>Empresa</label>
                  <p className="muted" style={{ margin: 0 }}>{companyName}</p>
                </div>
              ) : (
                <div className="field" style={{ marginBottom: "1rem" }}>
                  <label htmlFor="role-company">Empresa</label>
                  {companies.length === 0 ? (
                    <p className="field-hint">Nenhuma empresa cadastrada.</p>
                  ) : (
                    <select
                      id="role-company"
                      value={companyId}
                      onChange={(e) => setCompanyId(e.target.value)}
                      required
                    >
                      <option value="">Selecione</option>
                      {companies.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              )}

              <div className="field" style={{ marginBottom: "1.2rem" }}>
                <label htmlFor="role-name">Nome</label>
                <input
                  id="role-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ex.: Caixa, FLV, Mercearia"
                  required
                  style={{ width: "100%" }}
                />
              </div>

              <button type="submit" disabled={busy}>
                {busy ? "Salvando..." : isEditing ? "Salvar" : "Cadastrar"}
              </button>
            </form>
          </FormPanel>
        )}

        {!loading && isEditing && (
          <FormPanel
            icon={Tags}
            title="Possíveis nomes"
            description={
              'Outras grafias dessa função que podem aparecer em arquivos de pagamento (ex.: "Op. de Caixa" para "Caixa") — consideradas junto com o nome cadastrado ao ler a coluna Função durante a importação. Um nome só pode estar vinculado a uma função por vez, dentro da mesma empresa.'
            }
          >
            {aliasError && <div className="error-box">{aliasError}</div>}

            {aliases.length > 0 && (
              <div className="file-list" style={{ marginBottom: "0.8rem" }}>
                {aliases.map((a) => (
                  <div className="file-row" key={a.id}>
                    <div className="file-row-info">
                      <div className="file-name">{a.alias}</div>
                    </div>
                    <div className="file-row-actions">
                      <button
                        type="button"
                        className="ghost"
                        style={{ padding: "0.3rem" }}
                        onClick={() => handleRemoveAlias(a.id)}
                        aria-label="Remover"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <form onSubmit={handleAddAlias} style={{ display: "flex", gap: "0.5rem" }}>
              <input
                type="text"
                value={newAlias}
                onChange={(e) => setNewAlias(e.target.value)}
                placeholder="Ex.: Op. de Caixa"
                style={{ flex: 1 }}
              />
              <button type="submit" className="secondary" disabled={aliasBusy || !newAlias.trim()}>
                <Plus size={14} style={{ marginRight: "0.3rem" }} />
                Adicionar
              </button>
            </form>
          </FormPanel>
        )}

        {!loading && isEditing && (
          <FormPanel
            icon={Trash2}
            title="Excluir função"
            danger
            description={`Remove ${name || "esta função"} do cadastro. Turnos já importados com essa função não são apagados — só perdem o vínculo com o cadastro (deixam de aparecer no filtro "Função"). Não pode ser desfeito.`}
          >
            <button type="button" className="danger" onClick={() => setDeleteConfirmOpen(true)}>
              <Trash2 size={14} style={{ marginRight: "0.4rem" }} />
              Excluir função
            </button>
          </FormPanel>
        )}
      </div>

      {deleteConfirmOpen && (
        <ConfirmModal
          title="Excluir função?"
          message={`Isso exclui ${name || "esta função"} permanentemente do cadastro. Turnos já importados com essa função não são apagados, só perdem o vínculo. Não pode ser desfeito.`}
          confirmLabel={deleting ? "Excluindo..." : "Excluir função"}
          confirmDisabled={deleting}
          onConfirm={handleConfirmDelete}
          onCancel={() => setDeleteConfirmOpen(false)}
          error={deleteError}
        />
      )}
    </div>
  );
}
