import { ChevronLeft } from "lucide-react";
import { useNavigate } from "react-router-dom";

/**
 * Goes back one entry in the router history, since a detail page (e.g.
 * Cartão de Ponto) can be reached from more than one parent route.
 * Falls back to `fallback` when there's no previous entry to go back to
 * (e.g. the page was opened directly, so history.state.idx is 0).
 */
export default function BackButton({ fallback = "/" }: { fallback?: string }) {
  const navigate = useNavigate();

  function handleClick() {
    if ((window.history.state?.idx ?? 0) > 0) {
      navigate(-1);
    } else {
      navigate(fallback);
    }
  }

  return (
    <button
      type="button"
      className="ghost"
      onClick={handleClick}
      style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem", padding: "0.45em 0.7em" }}
    >
      <ChevronLeft size={16} />
      Voltar
    </button>
  );
}
