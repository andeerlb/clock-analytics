import { KeyRound, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { aiClearApiKey, aiSetApiKey, aiStatus, type AiStatus } from "../lib/api";
import { READ_ONLY_TITLE, useReadOnly } from "./AreaRoute";
import ConfirmModal from "./ConfirmModal";

export type AiConnection = "api-key" | "none";

/** "dd/mm/aaaa às hh:mm" in the viewer's time zone. */
function formatSavedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const day = date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
  const time = date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return `${day} às ${time}`;
}

/**
 * Configurações → "Assistente com IA": the Anthropic API key the whole team
 * shares. Any signed-in user can save or replace it; the server keeps it and
 * never sends it back, only who saved it, when and its last 4 characters.
 * Reports whether there is a key so the section list can flag it.
 */
export default function AiSettingsCard({ onConnectionChange }: { onConnectionChange?: (connection: AiConnection) => void }) {
  // View-only in Configurações: the key can't be saved or removed.
  const readOnly = useReadOnly();
  const roTitle = readOnly ? READ_ONLY_TITLE : undefined;
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    aiStatus()
      .then(setStatus)
      .catch((e) => setError(String(e)));
  }, []);

  const hasKey = status?.apiKey ?? false;
  const connection: AiConnection = hasKey ? "api-key" : "none";
  useEffect(() => {
    if (status) onConnectionChange?.(connection);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, status]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setStatus(await aiStatus());
      setApiKey("");
      setConfirmRemove(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function save() {
    if (!apiKey.trim() || busy) return;
    void run(() => aiSetApiKey(apiKey));
  }

  return (
    <>
      <div className="settings-list">
        <div className="settings-item">
          <span className="settings-item-icon">
            <Sparkles size={16} />
          </span>
          <div className="settings-item-text">
            <div className="settings-item-title">{status ? (hasKey ? "Conectado pela chave de API" : "Não conectado") : "Verificando..."}</div>
            {status && (
              <div className="settings-item-desc">
                {hasKey ? "O uso é cobrado na conta da Anthropic dona da chave." : "Cadastre uma chave de API da Anthropic abaixo para ligar o assistente."}
              </div>
            )}
          </div>
          {status && (hasKey ? <span className="settings-pill settings-pill-ok">Pronto</span> : <span className="settings-pill settings-pill-warn">Desligado</span>)}
        </div>

        <div className="settings-item">
          <div className="settings-item-text">
            <div className="settings-item-title">O que é enviado à Anthropic</div>
            <div className="settings-item-desc">
              Locais, funções, datas, valores e observações, com nomes e documentos reconhecidos ocultados. Nome, CPF, PIX, matrícula, clientes, empresas e arquivos
              ficam no servidor. O assistente só consulta; não altera nada.
            </div>
          </div>
        </div>

        <div className="settings-item settings-item-wrap">
          <span className="settings-item-icon">
            <KeyRound size={16} />
          </span>
          <div className="settings-item-text">
            <div className="settings-item-title">Chave de API da Anthropic</div>
            {status && (
              <div className={`settings-item-desc ${hasKey ? "settings-text-ok" : "settings-text-warn"}`}>
                {hasKey ? (
                  <>
                    ✓ Chave cadastrada por {status.savedBy ?? "alguém da equipe"}
                    {status.savedAt && ` em ${formatSavedAt(status.savedAt)}`}
                    {status.keyLast4 && ` (termina em …${status.keyLast4})`}
                  </>
                ) : (
                  "O assistente está desligado: falta a chave da Anthropic."
                )}
              </div>
            )}
          </div>
          {hasKey && (
            <button type="button" className="settings-button settings-button-danger" disabled={readOnly || busy} title={roTitle} onClick={() => setConfirmRemove(true)}>
              Remover chave
            </button>
          )}
          <form
            className="settings-inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <input
              type="password"
              aria-label="Chave de API da Anthropic"
              placeholder={hasKey ? "Colar uma chave nova (substitui a atual)" : "Colar a chave (sk-ant-...)"}
              autoComplete="off"
              disabled={readOnly}
              title={roTitle}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
            <button type="submit" className="settings-button settings-button-primary" disabled={readOnly || busy || !apiKey.trim()} title={roTitle}>
              {busy ? "Salvando..." : "Salvar chave"}
            </button>
          </form>
          <div className="settings-item-desc" style={{ width: "100%" }}>
            A chave vale para toda a equipe e fica guardada no servidor, fora do banco e dos backups. Depois de salva ela não aparece de novo, nem para quem cadastrou.
            Os nomes de colaboradores, clientes e empresas continuam indo para a IA como códigos, como no desktop.
          </div>
        </div>
      </div>
      {error && <div className="error-box settings-error">{error}</div>}

      {confirmRemove && (
        <ConfirmModal
          title="Remover a chave de API?"
          message="Sem a chave, o assistente para de responder para toda a equipe até alguém cadastrar outra."
          confirmLabel={busy ? "Removendo..." : "Remover chave"}
          confirmDisabled={busy}
          onConfirm={() => run(aiClearApiKey)}
          onCancel={() => setConfirmRemove(false)}
        />
      )}
    </>
  );
}
