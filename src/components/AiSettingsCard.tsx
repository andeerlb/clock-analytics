import { Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { aiClearApiKey, aiSetApiKey, aiStatus } from "../lib/api";

/** Configurações card for the assistant API key. The saved key is never read back into the UI. */
export default function AiSettingsCard() {
  const [claudeCode, setClaudeCode] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    aiStatus()
      .then((status) => {
        setClaudeCode(status.claudeCode);
        setHasKey(status.apiKey);
      })
      .catch((e) => setError(String(e)));
  }, []);

  async function run(action: () => Promise<void>, keyPresent: boolean) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setHasKey(keyPresent);
      setApiKey("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h3 style={{ marginTop: 0, display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <Sparkles size={18} />
        Assistente com IA
      </h3>
      <p className="muted" style={{ fontSize: "0.85rem" }}>
        Opcional. O ícone do assistente responde perguntas sobre o aplicativo e os dados e não altera nada. Para responder,
        ele consulta o banco e envia os resultados à Anthropic. Nome, CPF, PIX, matrícula, clientes, empresas e arquivos não
        são enviados; locais, funções, datas, valores e observações vão como estão, com nomes e documentos reconhecidos
        ocultados.
      </p>
      <p className="muted" style={{ fontSize: "0.85rem" }}>
        {claudeCode
          ? "Usando o Claude Code instalado neste computador, com o seu login. O uso entra no limite do seu plano. Em planos pessoais, confira a opção de privacidade \"Help improve Claude\" em claude.ai."
          : "O Claude Code não foi encontrado ou não está logado neste computador. Faça login nele ou cadastre abaixo uma chave de API da Anthropic, cujo uso é cobrado na sua conta."}
      </p>
      {hasKey ? (
        <div style={{ display: "flex", alignItems: "center", gap: "0.8rem", flexWrap: "wrap" }}>
          <span>Chave salva no cofre de senhas do sistema.</span>
          <button type="button" className="secondary" disabled={busy} onClick={() => run(aiClearApiKey, false)}>
            Remover chave
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
          <input
            type="password"
            aria-label="Chave de API da Anthropic"
            placeholder="Chave de API da Anthropic"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            style={{ flex: "1 1 260px" }}
          />
          <button type="button" disabled={busy || !apiKey.trim()} onClick={() => run(() => aiSetApiKey(apiKey), true)}>
            Salvar chave
          </button>
        </div>
      )}
      {error && (
        <div className="error-box" style={{ marginTop: "0.8rem" }}>
          {error}
        </div>
      )}
    </div>
  );
}
