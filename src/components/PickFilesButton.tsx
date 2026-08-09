import { ChevronDown, FileText, FolderOpen, FolderTree } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * "Procurar arquivos" button with two picking modes behind it — individual
 * files (the OS multi-file dialog) or a whole folder (scanned for matching
 * extensions). Same trigger button either way, so the two options don't
 * compete for space as separate buttons.
 */
export default function PickFilesButton({
  onPickFiles,
  onPickFolder,
  disabled = false,
  title,
}: {
  onPickFiles: () => void | Promise<void>;
  onPickFolder: () => void | Promise<void>;
  disabled?: boolean;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  function pick(action: () => void | Promise<void>) {
    setOpen(false);
    action();
  }

  return (
    <div style={{ position: "relative", display: "inline-block" }} ref={rootRef}>
      <button type="button" className="secondary" onClick={() => setOpen((o) => !o)} disabled={disabled} title={title}>
        <FolderOpen size={15} style={{ marginRight: "0.4rem" }} />
        Procurar arquivos
        <ChevronDown size={13} style={{ marginLeft: "0.4rem" }} />
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            left: 0,
            top: "calc(100% + 0.4rem)",
            background: "var(--card-bg)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            padding: "0.4rem",
            minWidth: "200px",
            boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.4)",
            zIndex: 20,
          }}
        >
          <button
            type="button"
            className="ghost"
            style={{ width: "100%", textAlign: "left", padding: "0.5rem 0.6rem" }}
            onClick={() => pick(onPickFiles)}
          >
            <FileText size={14} style={{ marginRight: "0.5rem" }} />
            Arquivos
          </button>
          <button
            type="button"
            className="ghost"
            style={{ width: "100%", textAlign: "left", padding: "0.5rem 0.6rem" }}
            onClick={() => pick(onPickFolder)}
          >
            <FolderTree size={14} style={{ marginRight: "0.5rem" }} />
            Pasta inteira
          </button>
        </div>
      )}
    </div>
  );
}
