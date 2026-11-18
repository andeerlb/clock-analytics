import { useEffect, useMemo, useState } from "react";
import ConfirmModal from "../components/ConfirmModal";
import PageHeader from "../components/PageHeader";
import { useAccess } from "../contexts/AuthContext";
import { AREAS, type Area, type Level, type Permissions } from "../lib/access";
import { formatDateTime } from "../lib/format";
import {
  addAppUser,
  createAccessProfile,
  deleteAccessProfile,
  listAccessProfiles,
  listAppUsers,
  removeAppUser,
  setAppUserProfile,
  updateAccessProfile,
  type AccessProfile,
  type AppUser,
} from "../lib/users";

type Tab = "usuarios" | "perfis";

const EMPTY_PERMISSIONS: Permissions = {
  areas: Object.fromEntries(AREAS.map((a) => [a.id, "none"])) as Record<Area, Level>,
  export: false,
  ai: false,
  users: false,
};

const LEVEL_LABEL: Record<Level, string> = { none: "Sem acesso", view: "Ver", edit: "Editar" };

const EXTRAS: { key: "export" | "ai" | "users"; label: string; desc: string }[] = [
  { key: "export", label: "Exportar e baixar", desc: "Excel, PDF, ZIP de espelhos, cópia do banco" },
  { key: "ai", label: "Assistente com IA", desc: "Cada pergunta usa a chave da equipe" },
  { key: "users", label: "Gerenciar usuários e perfis", desc: "Dá acesso a esta tela: na prática, vira admin" },
];

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** "Usuários e perfis": who can sign in, and what each profile allows. */
export default function UsersPage() {
  const { access } = useAccess();
  const [tab, setTab] = useState<Tab>("usuarios");
  const [users, setUsers] = useState<AppUser[] | null>(null);
  const [profiles, setProfiles] = useState<AccessProfile[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    try {
      const [u, p] = await Promise.all([listAppUsers(), listAccessProfiles()]);
      setUsers(u);
      setProfiles(p);
    } catch (e) {
      setError(errorText(e));
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  return (
    <div className="settings-page users-page">
      <PageHeader title="Usuários e perfis" subtitle="Quem pode entrar e o que cada pessoa pode fazer." />
      <div className="analytics-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "usuarios"} className={tab === "usuarios" ? "active" : ""} onClick={() => setTab("usuarios")}>
          Usuários
        </button>
        <button type="button" role="tab" aria-selected={tab === "perfis"} className={tab === "perfis" ? "active" : ""} onClick={() => setTab("perfis")}>
          Perfis
        </button>
      </div>
      {error && <div className="error-box">{error}</div>}
      {users && profiles && tab === "usuarios" && <UsersTab users={users} profiles={profiles} myEmail={access.email} onChanged={reload} />}
      {profiles && tab === "perfis" && <ProfilesTab profiles={profiles} onChanged={reload} />}
    </div>
  );
}

function UsersTab({ users, profiles, myEmail, onChanged }: { users: AppUser[]; profiles: AccessProfile[]; myEmail: string; onChanged: () => Promise<void> }) {
  const defaultProfile = profiles.find((p) => p.name === "Visualizador") ?? profiles.find((p) => !p.isAdmin) ?? profiles[0];
  const [email, setEmail] = useState("");
  const [profileId, setProfileId] = useState<number>(defaultProfile?.id ?? 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<AppUser | null>(null);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="settings-card">
        {users.map((u) => (
          <div key={u.email} className="settings-row users-row">
            <span className="settings-row-text">
              <span className="settings-row-title users-email">{u.email}</span>
              <span className="settings-row-desc">
                {u.initialAdmin
                  ? "Admin inicial, definido no servidor. Não dá para remover nem trocar o perfil por aqui."
                  : [
                      u.addedBy && u.createdAt ? `Adicionado por ${u.addedBy} em ${formatDateTime(u.createdAt)}` : null,
                      u.lastSeenAt ? `último acesso em ${formatDateTime(u.lastSeenAt)}` : "ainda não entrou",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
              </span>
            </span>
            {u.initialAdmin ? (
              <span className="settings-pill settings-pill-info">Admin · fixo</span>
            ) : (
              <>
                <select
                  aria-label={`Perfil de ${u.email}`}
                  value={u.profileId ?? ""}
                  disabled={busy}
                  onChange={(e) => run(() => setAppUserProfile(u.email, Number(e.target.value)))}
                >
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="settings-button settings-button-ghost"
                  disabled={busy || u.email === myEmail}
                  title={u.email === myEmail ? "Você não pode remover a si mesmo" : undefined}
                  onClick={() => setRemoving(u)}
                >
                  Remover
                </button>
              </>
            )}
          </div>
        ))}
        <form
          className="users-add"
          onSubmit={(e) => {
            e.preventDefault();
            if (!email.trim()) return;
            void run(async () => {
              await addAppUser(email, profileId);
              setEmail("");
            });
          }}
        >
          <input
            id="users-new-email"
            type="email"
            aria-label="E-mail da pessoa"
            placeholder="E-mail da conta Google (qualquer domínio)"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <select id="users-new-profile" aria-label="Perfil da pessoa" value={profileId} onChange={(e) => setProfileId(Number(e.target.value))}>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button type="submit" className="settings-button settings-button-primary" disabled={busy || !email.trim()}>
            Adicionar
          </button>
        </form>
        <div className="settings-row">
          <span className="settings-row-desc">
            A pessoa entra com o Google usando esse e-mail. Remover ou trocar o perfil vale na hora, mesmo para quem já está com o app aberto.
          </span>
        </div>
      </div>
      {error && <div className="error-box">{error}</div>}
      {removing && (
        <ConfirmModal
          title={`Remover ${removing.email}?`}
          message="A pessoa perde o acesso na hora. Dá para adicionar de novo depois."
          confirmLabel={busy ? "Removendo..." : "Remover"}
          confirmDisabled={busy}
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            const target = removing;
            setRemoving(null);
            void run(() => removeAppUser(target.email));
          }}
        />
      )}
    </>
  );
}

function ProfilesTab({ profiles, onChanged }: { profiles: AccessProfile[]; onChanged: () => Promise<void> }) {
  /** `null`: a new profile being created. */
  const [selectedId, setSelectedId] = useState<number | null>(profiles.find((p) => !p.isAdmin)?.id ?? profiles[0]?.id ?? null);
  const selected = profiles.find((p) => p.id === selectedId) ?? null;
  const [name, setName] = useState("");
  const [permissions, setPermissions] = useState<Permissions>(EMPTY_PERMISSIONS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setName(selected?.name ?? "");
    setPermissions(selected ? { ...EMPTY_PERMISSIONS, ...selected.permissions, areas: { ...EMPTY_PERMISSIONS.areas, ...selected.permissions.areas } } : EMPTY_PERMISSIONS);
    setError(null);
    setSaved(false);
  }, [selectedId, selected]);

  const locked = selected?.isAdmin ?? false;
  const dirty = useMemo(() => !selected || name !== selected.name || JSON.stringify(permissions) !== JSON.stringify({ ...EMPTY_PERMISSIONS, ...selected.permissions, areas: { ...EMPTY_PERMISSIONS.areas, ...selected.permissions.areas } }), [selected, name, permissions]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (selected) {
        await updateAccessProfile(selected.id, name, permissions);
      } else {
        const id = await createAccessProfile(name, permissions);
        setSelectedId(id);
      }
      await onChanged();
      setSaved(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!selected) return;
    setDeleting(false);
    setBusy(true);
    setError(null);
    try {
      await deleteAccessProfile(selected.id);
      setSelectedId(profiles.find((p) => !p.isAdmin && p.id !== selected.id)?.id ?? null);
      await onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="users-profiles">
        <div className="settings-card users-profile-list">
          {profiles.map((p) => (
            <button key={p.id} type="button" className={`settings-row settings-row-button${p.id === selectedId ? " users-profile-active" : ""}`} onClick={() => setSelectedId(p.id)}>
              <span className="settings-row-text">
                <span className="settings-row-title">{p.name}</span>
                <span className="settings-row-desc">
                  {p.isAdmin ? "Tudo · " : ""}
                  {p.userCount} {p.userCount === 1 ? "usuário" : "usuários"}
                </span>
              </span>
              {p.isAdmin && <span className="settings-pill settings-pill-info">fixo</span>}
            </button>
          ))}
          <div className="settings-row">
            <button type="button" className="settings-button" onClick={() => setSelectedId(null)}>
              + Novo perfil
            </button>
          </div>
        </div>

        <div className="settings-card">
          <div className="settings-row">
            <label htmlFor="profile-name" className="settings-row-desc">
              Nome
            </label>
            <input id="profile-name" type="text" value={name} disabled={locked} maxLength={60} onChange={(e) => setName(e.target.value)} className="users-profile-name" placeholder="Ex.: Financeiro" />
          </div>
          <span className="settings-label users-section">Áreas</span>
          {AREAS.map((area) => {
            const levels: Level[] = area.editable ? ["none", "view", "edit"] : ["none", "view"];
            const current = permissions.areas[area.id] ?? "none";
            return (
              <div key={area.id} className="settings-row">
                <span className="settings-row-text">
                  <span className="settings-row-title">{area.label}</span>
                  <span className="settings-row-desc">{area.desc}</span>
                </span>
                <div className="users-seg" role="group" aria-label={area.label}>
                  {levels.map((level) => (
                    <button
                      key={level}
                      type="button"
                      aria-pressed={current === level}
                      disabled={locked}
                      onClick={() => setPermissions((p) => ({ ...p, areas: { ...p.areas, [area.id]: level } }))}
                    >
                      {LEVEL_LABEL[level]}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
          <span className="settings-label users-section">Extras</span>
          {EXTRAS.map((extra) => (
            <label key={extra.key} className="settings-row settings-row-clickable">
              <span className="settings-row-text">
                <span className="settings-row-title">{extra.label}</span>
                <span className="settings-row-desc">{extra.desc}</span>
              </span>
              <input
                type="checkbox"
                role="switch"
                className="settings-switch"
                checked={permissions[extra.key]}
                disabled={locked}
                onChange={(e) => setPermissions((p) => ({ ...p, [extra.key]: e.target.checked }))}
              />
            </label>
          ))}
          <div className="settings-row users-profile-actions">
            {locked ? (
              <span className="settings-row-desc">O perfil Admin é fixo (tudo liberado) para ninguém ficar trancado do lado de fora.</span>
            ) : (
              <>
                {saved && !dirty && <span className="settings-row-desc">Salvo.</span>}
                {selected && (
                  <button
                    type="button"
                    className="settings-button settings-button-danger"
                    disabled={busy || selected.userCount > 0}
                    title={selected.userCount > 0 ? `Tem ${selected.userCount} ${selected.userCount === 1 ? "usuário" : "usuários"} com este perfil` : undefined}
                    onClick={() => setDeleting(true)}
                  >
                    Excluir perfil
                  </button>
                )}
                <button type="button" className="settings-button settings-button-primary" disabled={busy || !dirty || !name.trim()} onClick={save}>
                  {selected ? "Salvar" : "Criar perfil"}
                </button>
              </>
            )}
          </div>
          {error && <div className="error-box settings-error">{error}</div>}
        </div>
      </div>
      <p className="muted users-hint">Um perfil em uso não pode ser excluído: troque antes o perfil das pessoas.</p>
      {deleting && selected && (
        <ConfirmModal title={`Excluir o perfil ${selected.name}?`} message="Ninguém usa este perfil." confirmLabel="Excluir" onCancel={() => setDeleting(false)} onConfirm={remove} />
      )}
    </>
  );
}
