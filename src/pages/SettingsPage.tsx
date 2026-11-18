import { ChevronRight, Search } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import AiSettingsCard, { type AiConnection } from "../components/AiSettingsCard";
import Modal from "../components/Modal";
import PageHeader from "../components/PageHeader";
import { aiStatus, getImportsFileList, getStorageUsage } from "../lib/api";
import { getDatabaseTableSizes, getImportedFileNamesByBasename, type DatabaseTableSize } from "../lib/db";
import { formatBytes } from "../lib/format";
import { fetchServerVersion } from "../lib/http";
import type { StorageFileEntry, StorageUsage } from "../lib/types";

/** Rows whose details open below them. */
type ExpandableRow = "espaco" | "ia";

export default function SettingsPage() {
  const [storage, setStorage] = useState<StorageUsage | null>(null);
  const [loadingStorage, setLoadingStorage] = useState(true);
  // Which storage tile's breakdown is open in the detail Modal, if any —
  // "Total" has no breakdown of its own, so it isn't a valid value here.
  const [storageDetail, setStorageDetail] = useState<"db" | "imports" | null>(null);
  const [dbTableSizes, setDbTableSizes] = useState<DatabaseTableSize[] | null>(null);
  const [importFileEntries, setImportFileEntries] = useState<StorageFileEntry[] | null>(null);
  const [loadingStorageDetail, setLoadingStorageDetail] = useState(false);
  const [storageDetailError, setStorageDetailError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [serverVersion, setServerVersion] = useState<string | null>(null);

  function refreshStorage() {
    setLoadingStorage(true);
    return getStorageUsage()
      .then(setStorage)
      .catch((e) => setError(String(e)))
      .finally(() => setLoadingStorage(false));
  }

  function closeStorageDetail() {
    setStorageDetail(null);
    setDbTableSizes(null);
    setImportFileEntries(null);
    setStorageDetailError(null);
  }

  // Fetches the clicked tile's breakdown on open — "Banco de dados" lists
  // per-table disk usage (see `getDatabaseTableSizes`), "Arquivos importados"
  // lists each file actually inside imports/ (PDFs plus any payment
  // spreadsheet downloaded by link), largest first, with its human name
  // resolved where possible (see `getImportedFileNamesByBasename` for why
  // that resolution isn't always available).
  useEffect(() => {
    if (!storageDetail) return;
    setLoadingStorageDetail(true);
    setStorageDetailError(null);
    const request =
      storageDetail === "db"
        ? getDatabaseTableSizes().then(setDbTableSizes)
        : Promise.all([getImportsFileList(), getImportedFileNamesByBasename()]).then(([files, namesByBasename]) => {
            setImportFileEntries(
              [...files]
                .map((f) => ({ name: namesByBasename.get(f.name) ?? f.name, bytes: f.bytes }))
                .sort((a, b) => b.bytes - a.bytes),
            );
          });
    request.catch((e) => setStorageDetailError(String(e))).finally(() => setLoadingStorageDetail(false));
  }, [storageDetail]);

  useEffect(() => {
    refreshStorage();
    fetchServerVersion()
      .then(setServerVersion)
      .catch(() => setServerVersion(null));
  }, []);

  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const [expanded, setExpanded] = useState<ExpandableRow | null>(null);
  const [aiConnection, setAiConnection] = useState<AiConnection | null>(null);
  // The assistant row shows how it's connected before it's opened.
  useEffect(() => {
    aiStatus()
      .then((status) => setAiConnection(status.apiKey ? "api-key" : "none"))
      .catch(() => setAiConnection(null));
  }, []);

  // Ctrl/Cmd+K jumps to the search.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const totalBytes = storage ? storage.dbBytes + storage.importsBytes : 0;

  // The list filters as you type: each row matches on its own words plus
  // its title, so "backup", "espaço" or "bandeja" finds the right one.
  const query = normalizeSearch(search.trim());
  const matches = (keywords: string) => !query || normalizeSearch(keywords).includes(query);

  const rows = {
    versao: matches("geral versão versao atualização atualizacao sobre"),
    espaco: matches("dados espaço usado armazenamento disco tamanho banco arquivos servidor"),
    ia: matches("integrações assistente ia inteligência artificial claude anthropic chave api"),
  };
  const groups = {
    geral: rows.versao,
    dados: rows.espaco,
    integracoes: rows.ia,
  };
  const nothingFound = !Object.values(groups).some(Boolean);

  function toggleRow(id: ExpandableRow) {
    setExpanded((current) => (current === id ? null : id));
  }

  return (
    <div className="settings-page">
      <PageHeader title="Configurações" subtitle="Procure pelo que você quer fazer." />

      <label className="settings-search">
        <Search size={16} />
        <input
          ref={searchRef}
          type="search"
          placeholder="Ex.: espaço, assistente, versão"
          aria-label="Buscar nas configurações"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <kbd>Ctrl K</kbd>
      </label>

      {error && <div className="error-box">{error}</div>}

      {nothingFound && <p className="settings-empty">Nada encontrado com “{search.trim()}”.</p>}

      {groups.geral && (
        <section className="settings-group" aria-labelledby="settings-group-geral">
          <h3 id="settings-group-geral" className="settings-group-title">
            Geral
          </h3>
          <div className="settings-card">
            {rows.versao && (
              <div className="settings-row">
                <span className="settings-row-text">
                  <span className="settings-row-title">Versão</span>
                  <span className="settings-row-desc">A web se atualiza sozinha. Se aparecer algo estranho depois de uma atualização, recarregue a página.</span>
                </span>
                <span className="settings-row-value">{serverVersion ? `versão ${serverVersion.slice(0, 7)}` : "—"}</span>
              </div>
            )}
          </div>
        </section>
      )}

      {groups.dados && (
        <section className="settings-group" aria-labelledby="settings-group-dados">
          <h3 id="settings-group-dados" className="settings-group-title">
            Dados
          </h3>
          <div className="settings-card">
            {rows.espaco && (
              <div className="settings-expandable">
                <ExpandHead
                  open={expanded === "espaco"}
                  onToggle={() => toggleRow("espaco")}
                  title="Espaço usado"
                  desc={storage ? `Banco ${formatBytes(storage.dbBytes)} · Arquivos ${formatBytes(storage.importsBytes)}` : undefined}
                  value={<span className="settings-row-value">{loadingStorage || !storage ? "Calculando..." : formatBytes(totalBytes)}</span>}
                />
                {expanded === "espaco" && storage && (
                  <div className="settings-detail">
                    {totalBytes > 0 && (
                      <div className="settings-storage-bar" aria-hidden="true">
                        <i style={{ width: `${(storage.dbBytes / totalBytes) * 100}%`, background: "#60a5fa" }} />
                        <i style={{ width: `${(storage.importsBytes / totalBytes) * 100}%`, background: "#a78bfa" }} />
                      </div>
                    )}
                    <div className="settings-storage-legend">
                      <button type="button" onClick={() => setStorageDetail("db")} title="Ver o que ocupa espaço, do maior para o menor">
                        <i style={{ background: "#60a5fa" }} />
                        Banco de dados · {formatBytes(storage.dbBytes)}
                      </button>
                      <button type="button" onClick={() => setStorageDetail("imports")} title="Ver o que ocupa espaço, do maior para o menor">
                        <i style={{ background: "#a78bfa" }} />
                        Arquivos importados · {formatBytes(storage.importsBytes)} ({storage.importsFileCount} {storage.importsFileCount === 1 ? "arquivo" : "arquivos"})
                      </button>
                    </div>
                    <p className="settings-detail-text">No servidor. Clique em cada parte para ver o que ocupa mais espaço.</p>
                  </div>
                )}
              </div>
            )}
          </div>
        </section>
      )}

      {groups.integracoes && (
        <section className="settings-group" aria-labelledby="settings-group-integracoes">
          <h3 id="settings-group-integracoes" className="settings-group-title">
            Integrações
          </h3>
          <div className="settings-card">
            {rows.ia && (
              <div className="settings-expandable">
                <ExpandHead
                  open={expanded === "ia"}
                  onToggle={() => toggleRow("ia")}
                  title="Assistente com IA"
                  desc={aiConnection === "api-key" ? "Chave da Anthropic cadastrada para a equipe" : "Responde perguntas sobre o app e os dados"}
                  value={
                    aiConnection &&
                    (aiConnection === "none" ? (
                      <span className="settings-pill settings-pill-warn">Desligado</span>
                    ) : (
                      <span className="settings-pill settings-pill-ok">Pronto</span>
                    ))
                  }
                />
                {expanded === "ia" && (
                  <div className="settings-detail settings-detail-flush">
                    <AiSettingsCard onConnectionChange={setAiConnection} />
                  </div>
                )}
              </div>
            )}
          </div>
        </section>
      )}

      {storageDetail && (
        <Modal onClose={closeStorageDetail} title={storageDetail === "db" ? "Banco de dados" : "Arquivos importados"} maxHeight="70vh">
          {loadingStorageDetail && <p className="muted">Calculando...</p>}
          {storageDetailError && <div className="error-box">{storageDetailError}</div>}
          {!loadingStorageDetail && !storageDetailError && (
            <div className="settings-detail-list">
              {(storageDetail === "db" ? (dbTableSizes ?? []).length : (importFileEntries ?? []).length) === 0 && <p className="muted">Nada para mostrar.</p>}
              {storageDetail === "db" &&
                dbTableSizes?.map((t) => (
                  <div key={t.tableName} className="settings-detail-row">
                    <span>{t.tableName}</span>
                    <span className="muted">{formatBytes(t.bytes)}</span>
                  </div>
                ))}
              {storageDetail === "imports" &&
                importFileEntries?.map((f, i) => (
                  <div key={i} className="settings-detail-row">
                    <span style={{ overflowWrap: "anywhere" }}>{f.name}</span>
                    <span className="muted">{formatBytes(f.bytes)}</span>
                  </div>
                ))}
            </div>
          )}
        </Modal>
      )}

    </div>
  );
}

/** A settings row that opens its details below it when clicked. */
function ExpandHead({ open, onToggle, title, desc, value }: { open: boolean; onToggle: () => void; title: string; desc?: ReactNode; value?: ReactNode }) {
  return (
    <button type="button" className="settings-row settings-row-button" aria-expanded={open} onClick={onToggle}>
      <span className="settings-row-text">
        <span className="settings-row-title">{title}</span>
        {desc && <span className="settings-row-desc">{desc}</span>}
      </span>
      {value}
      <ChevronRight size={16} className={open ? "settings-chevron settings-chevron-open" : "settings-chevron"} />
    </button>
  );
}

/** Lowercase, without accents: "Atualização" and "atualizacao" find the same row. */
function normalizeSearch(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}
