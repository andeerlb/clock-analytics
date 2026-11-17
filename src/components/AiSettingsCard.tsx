import { KeyRound, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { aiClearApiKey, aiSetApiKey, aiStatus } from "../lib/api";
import ConfirmModal from "./ConfirmModal";

export type AiConnection = "claude-code" | "api-key" | "none";

/**
 * Configurações → "Assistente com IA": how the assistant is connected and
 * the optional Anthropic API key. The saved key is never read back into
 * the UI. Reports how it's connected so the section list can flag it.
 */
export default function AiSettingsCard({ onConnectionChange }: { onConnectionChange?: (connection: AiConnection) => void }) {
  const [claudeCode, setClaudeCode] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [addingKey, setAddingKey] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    aiStatus()
      .then((status) => {
        setClaudeCode(status.claudeCode);
        setHasKey(status.apiKey);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoaded(true));
  }, []);

  const connection: AiConnection = claudeCode ? "claude-code" : hasKey ? "api-key" : "none";
  useEffect(() => {
    if (loaded) onConnectionChange?.(connection);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, loaded]);

  async function run(action: () => Promise<void>, keyPresent: boolean) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setHasKey(keyPresent);
      setApiKey("");
      setAddingKey(false);
      setConfirmRemove(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  let title = "Não conectado";
  let detail = "Entre no Claude Code deste computador ou adicione uma chave de API da Anthropic abaixo.";
  let pill = <span className="settings-pill settings-pill-warn">Desligado</span>;
  if (claudeCode) {
    title = "Conectado pelo Claude Code";
    detail = "Usa o login do Claude Code deste computador. O uso entra no limite do seu plano; em planos pessoais, confira a opção “Help improve Claude” em claude.ai.";
    pill = <span className="settings-pill settings-pill-ok">Pronto</span>;
  } else if (hasKey) {
    title = "Conectado pela chave de API";
    detail = "O uso é cobrado na sua conta da Anthropic.";
    pill = <span className="settings-pill settings-pill-ok">Pronto</span>;
  }

  return (
    <>
      <div className="settings-list">
        <div className="settings-item">
          <span className="settings-item-icon">
            <Sparkles size={16} />
          </span>
          <div className="settings-item-text">
            <div className="settings-item-title">{loaded ? title : "Verificando..."}</div>
            {loaded && <div className="settings-item-desc">{detail}</div>}
          </div>
          {loaded && pill}
        </div>

        <div className="settings-item">
          <div className="settings-item-text">
            <div className="settings-item-title">O que é enviado à Anthropic</div>
            <div className="settings-item-desc">
              Locais, funções, datas, valores e observações, com nomes e documentos reconhecidos ocultados. Nome, CPF, PIX, matrícula, clientes, empresas e arquivos
              ficam no computador. O assistente só consulta; não altera nada.
            </div>
          </div>
        </div>

        <div className="settings-item settings-item-wrap">
          <span className="settings-item-icon">
            <KeyRound size={16} />
          </span>
          <div className="settings-item-text">
            <div className="settings-item-title">Chave de API da Anthropic</div>
            <div className="settings-item-desc">
              {hasKey ? "Salva no cofre de senhas do sistema. Ela não é mostrada de novo." : claudeCode ? "Opcional: o Claude Code já está conectado." : "Use se não tiver o Claude Code. O uso é cobrado na sua conta."}
            </div>
          </div>
          {hasKey ? (
            <button type="button" className="settings-button settings-button-danger" disabled={busy} onClick={() => setConfirmRemove(true)}>
              Remover chave
            </button>
          ) : (
            !addingKey && (
              <button type="button" className="settings-button" onClick={() => setAddingKey(true)}>
                Adicionar chave
              </button>
            )
          )}
          {!hasKey && addingKey && (
            <div className="settings-inline-form">
              <input
                type="password"
                aria-label="Chave de API da Anthropic"
                placeholder="sk-ant-..."
                autoComplete="off"
                autoFocus
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <button type="button" className="settings-button" onClick={() => setAddingKey(false)}>
                Cancelar
              </button>
              <button type="button" className="settings-button settings-button-primary" disabled={busy || !apiKey.trim()} onClick={() => run(() => aiSetApiKey(apiKey), true)}>
                {busy ? "Salvando..." : "Salvar chave"}
              </button>
            </div>
          )}
        </div>
      </div>
      {error && <div className="error-box settings-error">{error}</div>}

      {confirmRemove && (
        <ConfirmModal
          title="Remover a chave de API?"
          message={claudeCode ? "O assistente continua funcionando pelo Claude Code." : "Sem a chave, o assistente para de responder até você entrar no Claude Code ou adicionar outra."}
          confirmLabel={busy ? "Removendo..." : "Remover chave"}
          confirmDisabled={busy}
          onConfirm={() => run(aiClearApiKey, false)}
          onCancel={() => setConfirmRemove(false)}
        />
      )}
    </>
  );
}
