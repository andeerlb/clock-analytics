import { Briefcase, Info, KeyRound, Plus, Tags, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import BackButton from "../components/BackButton";
import ConfirmModal from "../components/ConfirmModal";
import FormPanel from "../components/FormPanel";
import {
  addEmployeeAlias,
  addEmployeePixKey,
  createEmployeeManual,
  deleteEmployee,
  getEmployee,
  linkEmployeeToClientCompany,
  listClients,
  listEmployeeAliases,
  listEmployeePixKeys,
  removeEmployeeAlias,
  removeEmployeePixKey,
  unlinkEmployeeClientCompany,
  updateEmployee,
  updateEmployeeClientCompanyMatricula,
  updateEmployeePixKeyType,
  type ClientRow,
  type EmployeeAliasRow,
  type EmployeeClientCompanyLink,
  type EmployeePixKeyRow,
} from "../lib/db";
import { maskCpf } from "../lib/format";
import { detectPixKeyType, PIX_KEY_TYPE_LABELS, PIX_KEY_TYPES, type PixKeyType } from "../lib/pix";

/**
 * What a "Cadastrar colaborador" shortcut (e.g. from the payment import
 * preview) hands off — a name to start the form pre-filled with, and,
 * whenever the shortcut already resolved exactly which cliente/empresa the
 * colaborador belongs to (e.g. via a template's routing rule), that too.
 */
export interface EmployeeFormNavState {
  prefillName?: string;
  prefillClientId?: number;
  prefillCompanyId?: number;
}

export default function EmployeeFormPage() {
  const { id } = useParams<{ id: string }>();
  const isEditing = id !== undefined;
  const navigate = useNavigate();
  const location = useLocation();
  // Only used as the initial values below — irrelevant once editing takes
  // over the form, and never applies to `isEditing` at all (an existing
  // colaborador's fields always come from `getEmployee`).
  const prefill = !isEditing ? (location.state as EmployeeFormNavState | null) : null;

  const [clients, setClients] = useState<ClientRow[]>([]);
  const [clientId, setClientId] = useState(prefill?.prefillClientId !== undefined ? String(prefill.prefillClientId) : "");
  const [companyId, setCompanyId] = useState(
    prefill?.prefillCompanyId !== undefined ? String(prefill.prefillCompanyId) : "",
  );
  // Edit mode only — every (cliente, empresa) pair this colaborador is
  // linked to. Unlike the create-mode `clientId`/`companyId` above (a single
  // starting pair), a colaborador can have any number of these once created.
  const [links, setLinks] = useState<EmployeeClientCompanyLink[]>([]);
  const [name, setName] = useState(prefill?.prefillName ?? "");
  const [cpf, setCpf] = useState("");
  const [matricula, setMatricula] = useState("");
  const [loading, setLoading] = useState(isEditing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [aliases, setAliases] = useState<EmployeeAliasRow[]>([]);
  const [newAlias, setNewAlias] = useState("");
  const [aliasBusy, setAliasBusy] = useState(false);
  const [aliasError, setAliasError] = useState<string | null>(null);
  const [pixKeys, setPixKeys] = useState<EmployeePixKeyRow[]>([]);
  const [newPixKey, setNewPixKey] = useState("");
  const [pixBusy, setPixBusy] = useState(false);
  const [pixError, setPixError] = useState<string | null>(null);

  // "Vincular a outro cliente/empresa" — edit mode only.
  const [addClientId, setAddClientId] = useState("");
  const [addCompanyId, setAddCompanyId] = useState("");
  const [addMatricula, setAddMatricula] = useState("");
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  // "Excluir colaborador" — irreversible, wipes payment_shifts/imports too
  // (see `deleteEmployee`). No count query first — the confirm message
  // just names what categories of data go with it, not exact numbers.
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleConfirmDelete() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteEmployee(Number(id));
      navigate("/employees");
    } catch (e) {
      setDeleteError(String(e instanceof Error ? e.message : e));
    } finally {
      setDeleting(false);
    }
  }

  useEffect(() => {
    listClients().then(setClients);
    if (isEditing) {
      getEmployee(Number(id))
        .then((e) => {
          setName(e.name);
          setCpf(maskCpf(e.cpf));
          setLinks(e.links);
        })
        .catch((e) => setError(String(e instanceof Error ? e.message : e)))
        .finally(() => setLoading(false));
      listEmployeeAliases(Number(id)).then(setAliases);
      listEmployeePixKeys(Number(id)).then(setPixKeys);
    }
  }, [id, isEditing]);

  async function refreshLinks() {
    setLinks((await getEmployee(Number(id))).links);
  }

  async function handleAddLink(e: React.FormEvent) {
    e.preventDefault();
    setLinkError(null);
    setLinkBusy(true);
    try {
      await linkEmployeeToClientCompany(Number(id), Number(addClientId), Number(addCompanyId), addMatricula.trim() || null);
      setAddClientId("");
      setAddCompanyId("");
      setAddMatricula("");
      await refreshLinks();
    } catch (err) {
      setLinkError(String(err instanceof Error ? err.message : err));
    } finally {
      setLinkBusy(false);
    }
  }

  async function handleRemoveLink(clientIdToRemove: number, companyIdToRemove: number) {
    setLinkError(null);
    try {
      await unlinkEmployeeClientCompany(Number(id), clientIdToRemove, companyIdToRemove);
      setLinks((prev) => prev.filter((l) => !(l.clientId === clientIdToRemove && l.companyId === companyIdToRemove)));
    } catch (err) {
      setLinkError(String(err instanceof Error ? err.message : err));
    }
  }

  async function handleMatriculaChange(clientIdToUpdate: number, companyIdToUpdate: number, value: string) {
    setLinks((prev) =>
      prev.map((l) =>
        l.clientId === clientIdToUpdate && l.companyId === companyIdToUpdate ? { ...l, matricula: value } : l,
      ),
    );
  }

  async function handleMatriculaBlur(clientIdToUpdate: number, companyIdToUpdate: number, value: string) {
    setLinkError(null);
    try {
      await updateEmployeeClientCompanyMatricula(Number(id), clientIdToUpdate, companyIdToUpdate, value.trim() || null);
    } catch (err) {
      setLinkError(String(err instanceof Error ? err.message : err));
    }
  }

  // `clients` has one row per (client, company) link — same pattern the
  // create-mode Cliente/Empresa selects already use. The "add vínculo"
  // picker narrows to whichever cliente is currently selected there, minus
  // pairs already linked to this colaborador.
  const addClientCompanies = useMemo(() => clients.filter((c) => String(c.id) === addClientId), [clients, addClientId]);
  const availableLinksToAdd = useMemo(
    () => addClientCompanies.filter((c) => !links.some((l) => l.clientId === c.id && l.companyId === c.companyId)),
    [addClientCompanies, links],
  );

  async function handleAddAlias(e: React.FormEvent) {
    e.preventDefault();
    setAliasError(null);
    setAliasBusy(true);
    try {
      await addEmployeeAlias(Number(id), newAlias);
      setNewAlias("");
      setAliases(await listEmployeeAliases(Number(id)));
    } catch (err) {
      setAliasError(String(err instanceof Error ? err.message : err));
    } finally {
      setAliasBusy(false);
    }
  }

  async function handleRemoveAlias(aliasId: number) {
    await removeEmployeeAlias(aliasId);
    setAliases((prev) => prev.filter((a) => a.id !== aliasId));
  }

  async function handleAddPixKey(e: React.FormEvent) {
    e.preventDefault();
    setPixError(null);
    setPixBusy(true);
    try {
      await addEmployeePixKey(Number(id), newPixKey, detectPixKeyType(newPixKey));
      setNewPixKey("");
      setPixKeys(await listEmployeePixKeys(Number(id)));
    } catch (err) {
      setPixError(String(err instanceof Error ? err.message : err));
    } finally {
      setPixBusy(false);
    }
  }

  async function handlePixTypeChange(key: EmployeePixKeyRow, keyType: PixKeyType) {
    setPixKeys((previous) => previous.map((item) => item.id === key.id ? { ...item, keyType } : item));
    setPixError(null);
    try {
      await updateEmployeePixKeyType(key.id, keyType);
    } catch (err) {
      setPixKeys((previous) => previous.map((item) => item.id === key.id ? key : item));
      setPixError(String(err instanceof Error ? err.message : err));
    }
  }

  async function handleRemovePixKey(keyId: number) {
    setPixError(null);
    try {
      await removeEmployeePixKey(keyId);
      setPixKeys((previous) => previous.filter((key) => key.id !== keyId));
    } catch (err) {
      setPixError(String(err instanceof Error ? err.message : err));
    }
  }

  // `clients` has one row per (client, company) link — same pattern as the
  // timesheet import form's Cliente/Empresa selects.
  const clientCompanies = useMemo(
    () => clients.filter((c) => String(c.id) === clientId),
    [clients, clientId],
  );

  useEffect(() => {
    // `clients` hasn't loaded yet — `clientCompanies` is spuriously empty
    // regardless of `clientId`, so there's nothing real to derive from it
    // yet. Without this guard, this effect fired on first mount (before
    // `listClients()` resolves), saw an empty `clientCompanies`, and wiped
    // out a pre-filled `companyId` (from "Cadastrar colaborador") before it
    // ever got a chance to be checked against the real list.
    if (clients.length === 0) return;
    // Already a valid choice for this clientCompanies set — leave it alone.
    // Covers both a still-fresh manual pick and a pre-filled `companyId`.
    if (clientCompanies.some((c) => String(c.companyId) === companyId)) return;
    if (clientCompanies.length === 1) {
      setCompanyId(String(clientCompanies[0].companyId));
    } else {
      setCompanyId("");
    }
  }, [clients, clientCompanies]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (isEditing) {
        await updateEmployee(Number(id), name, cpf);
      } else {
        const trimmedMatricula = matricula.trim() || null;
        await createEmployeeManual(Number(clientId), Number(companyId), name, cpf, trimmedMatricula);
      }
      // Same go-back-if-possible logic as `BackButton` — when this form was
      // opened from the payment import preview's "Cadastrar colaborador"
      // shortcut, this returns to that exact preview state (see
      // `PaymentImportNavState`) instead of always landing on the listing.
      if ((window.history.state?.idx ?? 0) > 0) {
        navigate(-1);
      } else {
        navigate("/employees");
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
        <BackButton fallback="/employees" />
        <h2 style={{ margin: 0 }}>{isEditing ? "Editar colaborador" : "Novo colaborador"}</h2>
      </div>
      <p className="page-subtitle">
        {isEditing
          ? "O CPF é único, globalmente — o mesmo colaborador pode estar vinculado a vários clientes e empresas, gerenciados na seção abaixo."
          : "O CPF é único, globalmente — o mesmo CPF não pode ser cadastrado duas vezes; depois de criado, o colaborador pode ser vinculado a outros clientes/empresas na tela de edição."}
      </p>

      {error && <div className="error-box">{error}</div>}

      <div className="details-main" style={{ maxWidth: "52rem" }}>
        {loading ? (
          <p className="muted">Carregando...</p>
        ) : (
          <FormPanel icon={Info} title="Informações Gerais">
            <form onSubmit={handleSubmit}>
              {!isEditing && (
                <div className="field-row" style={{ marginBottom: "1rem" }}>
                  <div className="field" style={{ flex: "1 1 200px" }}>
                    <label htmlFor="employee-client">Cliente</label>
                    {clients.length === 0 ? (
                      <p className="field-hint">
                        Nenhum cliente cadastrado. <Link to="/clients">Cadastre um cliente</Link>{" "}
                        antes.
                      </p>
                    ) : (
                      <select
                        id="employee-client"
                        value={clientId}
                        onChange={(e) => setClientId(e.target.value)}
                        required
                      >
                        <option value="">Selecione</option>
                        {Array.from(new Map(clients.map((c) => [c.id, c])).values()).map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                  <div className="field" style={{ flex: "1 1 180px" }}>
                    <label htmlFor="employee-company">Empresa</label>
                    <select
                      id="employee-company"
                      value={companyId}
                      onChange={(e) => setCompanyId(e.target.value)}
                      disabled={clientCompanies.length <= 1}
                      required
                    >
                      {clientCompanies.length !== 1 && <option value="">Selecione uma empresa</option>}
                      {clientCompanies.map((c) => (
                        <option key={c.companyId} value={c.companyId}>
                          {c.companyName}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}

              <div className="field" style={{ marginBottom: "1rem" }}>
                <label htmlFor="employee-name">Nome</label>
                <input
                  id="employee-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Nome completo"
                  required
                  style={{ width: "100%" }}
                />
              </div>
              <div className="field-row" style={{ marginBottom: "1.2rem" }}>
                <div className="field" style={{ flex: "1 1 200px" }}>
                  <label htmlFor="employee-cpf">CPF</label>
                  <input
                    id="employee-cpf"
                    type="text"
                    value={cpf}
                    onChange={(e) => setCpf(maskCpf(e.target.value))}
                    placeholder="000.000.000-00"
                    inputMode="numeric"
                    required
                    style={{ width: "100%" }}
                  />
                </div>
                {!isEditing && (
                  <div className="field" style={{ flex: "1 1 160px" }}>
                    <label htmlFor="employee-matricula">Matrícula (opcional)</label>
                    <input
                      id="employee-matricula"
                      type="text"
                      value={matricula}
                      onChange={(e) => setMatricula(e.target.value)}
                      placeholder="Ex.: 00123"
                      style={{ width: "100%" }}
                    />
                  </div>
                )}
              </div>

              <button type="submit" disabled={busy}>
                {busy ? "Salvando..." : isEditing ? "Salvar" : "Cadastrar"}
              </button>
            </form>
          </FormPanel>
        )}

        {!loading && isEditing && (
          <FormPanel
            icon={KeyRound}
            title="Chaves PIX"
            description="Um colaborador pode ter várias chaves. O tipo é detectado automaticamente na importação e pode ser corrigido aqui."
          >
            {pixError && <div className="error-box">{pixError}</div>}
            {pixKeys.length > 0 && (
              <div className="file-list" style={{ marginBottom: "0.8rem" }}>
                {pixKeys.map((key) => (
                  <div className="file-row" key={key.id}>
                    <div className="file-row-info" style={{ minWidth: 0 }}>
                      <div className="file-name" style={{ overflowWrap: "anywhere" }}>{key.keyValue}</div>
                    </div>
                    <select
                      value={key.keyType}
                      onChange={(e) => handlePixTypeChange(key, e.target.value as PixKeyType)}
                      aria-label={`Tipo da chave ${key.keyValue}`}
                      style={{ width: "9rem" }}
                    >
                      {PIX_KEY_TYPES.map((type) => <option key={type} value={type}>{PIX_KEY_TYPE_LABELS[type]}</option>)}
                    </select>
                    <button type="button" className="ghost" style={{ padding: "0.3rem" }} onClick={() => handleRemovePixKey(key.id)} aria-label="Remover chave PIX">
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <form onSubmit={handleAddPixKey} style={{ display: "flex", gap: "0.5rem" }}>
              <input
                type="text"
                value={newPixKey}
                onChange={(e) => setNewPixKey(e.target.value)}
                placeholder="CPF, CNPJ, telefone, e-mail ou chave aleatória"
                style={{ flex: 1 }}
              />
              <button type="submit" className="secondary" disabled={pixBusy || !newPixKey.trim()}>
                <Plus size={14} style={{ marginRight: "0.3rem" }} />
                Adicionar
              </button>
            </form>
          </FormPanel>
        )}

        {!loading && isEditing && (
          <FormPanel
            icon={Briefcase}
            title="Clientes e empresas vinculados"
            description="Um colaborador pode estar vinculado a mais de um cliente e, para cada cliente, a mais de uma empresa (ex.: contratado por duas empresas diferentes que atendem o mesmo cliente) — cada vínculo tem sua própria matrícula, já que ela é emitida pela folha de pagamento de cada empresa."
          >
            {linkError && <div className="error-box">{linkError}</div>}

            <div className="file-list" style={{ marginBottom: "0.8rem" }}>
              {links.map((l) => (
                <div className="file-row" key={`${l.clientId}-${l.companyId}`}>
                  <div className="file-row-info">
                    <div className="file-name">
                      <span className="muted" style={{ fontWeight: 400 }}>
                        Empresa:{" "}
                      </span>
                      {l.companyName}
                    </div>
                    <div className="file-name">
                      <span className="muted" style={{ fontWeight: 400 }}>
                        Cliente:{" "}
                      </span>
                      {l.clientName}
                    </div>
                  </div>
                  <input
                    type="text"
                    value={l.matricula ?? ""}
                    onChange={(e) => handleMatriculaChange(l.clientId, l.companyId, e.target.value)}
                    onBlur={(e) => handleMatriculaBlur(l.clientId, l.companyId, e.target.value)}
                    placeholder="Matrícula (opcional)"
                    style={{ width: "10rem" }}
                  />
                  <div className="file-row-actions">
                    <button
                      type="button"
                      className="ghost"
                      style={{ padding: "0.3rem" }}
                      onClick={() => handleRemoveLink(l.clientId, l.companyId)}
                      disabled={links.length <= 1}
                      title={links.length <= 1 ? "O colaborador precisa de ao menos um vínculo" : "Remover vínculo"}
                      aria-label="Remover vínculo"
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <form onSubmit={handleAddLink} style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
              <select
                value={addClientId}
                onChange={(e) => {
                  setAddClientId(e.target.value);
                  setAddCompanyId("");
                }}
                required
                style={{ flex: "1 1 160px" }}
              >
                <option value="">Vincular a outro cliente...</option>
                {Array.from(new Map(clients.map((c) => [c.id, c])).values()).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <select
                value={addCompanyId}
                onChange={(e) => setAddCompanyId(e.target.value)}
                required
                disabled={!addClientId}
                style={{ flex: "1 1 160px" }}
              >
                <option value="">Empresa...</option>
                {availableLinksToAdd.map((c) => (
                  <option key={c.companyId} value={c.companyId}>
                    {c.companyName}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={addMatricula}
                onChange={(e) => setAddMatricula(e.target.value)}
                placeholder="Matrícula (opcional)"
                style={{ width: "10rem" }}
              />
              <button type="submit" className="secondary" disabled={linkBusy || !addClientId || !addCompanyId}>
                <Plus size={14} style={{ marginRight: "0.3rem" }} />
                Vincular
              </button>
            </form>
          </FormPanel>
        )}

        {!loading && isEditing && (
          <FormPanel
            icon={Tags}
            title="Possíveis nomes"
            description={
              'Outras grafias do nome desse colaborador que podem aparecer em arquivos de pagamento (ex.: "Anderson Lucas" para "Anderson Lucas Babinski") — consideradas junto com o nome cadastrado ao buscar o colaborador durante a importação. Um nome só pode estar vinculado a um colaborador por vez, entre os clientes/empresas em que ele já está vinculado.'
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
                placeholder="Ex.: Anderson Lucas"
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
            title="Excluir colaborador"
            danger
            description={`Remove ${name || "este colaborador"} do cadastro, junto com todo o histórico vinculado a ele — turnos de pagamento, cartões de ponto, chaves PIX e apelidos. Não pode ser desfeito.`}
          >
            <button type="button" className="danger" onClick={() => setDeleteConfirmOpen(true)}>
              <Trash2 size={14} style={{ marginRight: "0.4rem" }} />
              Excluir colaborador
            </button>
          </FormPanel>
        )}
      </div>

      {deleteConfirmOpen && (
        <ConfirmModal
          title="Excluir colaborador?"
          message={`Isso exclui ${name || "este colaborador"} permanentemente, junto com todo o histórico vinculado a ele — turnos de pagamento, cartões de ponto, chaves PIX e apelidos cadastrados. Não pode ser desfeito.`}
          confirmLabel={deleting ? "Excluindo..." : "Excluir colaborador"}
          confirmDisabled={deleting}
          onConfirm={handleConfirmDelete}
          onCancel={() => setDeleteConfirmOpen(false)}
          error={deleteError}
        />
      )}
    </div>
  );
}
