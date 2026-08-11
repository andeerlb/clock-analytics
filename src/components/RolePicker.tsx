import { Briefcase, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { listRoles, type RoleRow } from "../lib/db";

const POPOVER_WIDTH = 288; // 18rem at the default 16px root size

/**
 * A single-função combobox, scoped to one empresa — search box + results,
 * backed by `listRoles` (a small, finite cadastro per empresa, unlike
 * colaboradores, so this fetches the whole list once per open and filters
 * client-side instead of `EmployeePicker`'s server-paginated search).
 *
 * Same popover mechanics as `EmployeePicker` (portaled to `document.body`,
 * `fixed`-positioned off the trigger button) for the same reason: this sits
 * inside a table cell, and the table's own `overflow-x: auto` would
 * otherwise clip a plain `position: absolute` popover.
 */
export default function RolePicker({
  companyId,
  onSelect,
  placeholder = "Vincular função...",
  disabled = false,
}: {
  companyId: number;
  onSelect: (role: RoleRow) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number; openUp: boolean } | null>(null);
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<RoleRow[]>([]);
  const [loading, setLoading] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  useEffect(() => {
    if (!open) return;
    function onScroll(e: Event) {
      if (e.target instanceof Node && popoverRef.current?.contains(e.target)) return;
      setOpen(false);
    }
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    listRoles(companyId)
      .then((r) => {
        if (!cancelled) setRows(r);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, companyId]);

  function toggleOpen() {
    if (disabled) return;
    if (open) {
      setOpen(false);
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const estimatedHeight = 280;
    const openUp = rect.bottom + estimatedHeight > window.innerHeight && rect.top > estimatedHeight;
    const left = Math.min(rect.left, window.innerWidth - POPOVER_WIDTH - 8);
    setCoords({
      top: openUp ? rect.top - 8 : rect.bottom + 8,
      left: Math.max(8, left),
      openUp,
    });
    setSearch("");
    setOpen(true);
  }

  function pick(role: RoleRow) {
    setOpen(false);
    onSelect(role);
  }

  const filtered = rows.filter((r) => r.name.toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <>
      <button
        type="button"
        className="secondary"
        onClick={toggleOpen}
        disabled={disabled}
        ref={triggerRef}
        style={{ fontSize: "0.82rem" }}
      >
        <Briefcase size={13} style={{ marginRight: "0.35rem" }} />
        {placeholder}
      </button>
      {open &&
        coords &&
        createPortal(
          <div
            ref={popoverRef}
            style={{
              position: "fixed",
              top: coords.openUp ? undefined : coords.top,
              bottom: coords.openUp ? window.innerHeight - coords.top : undefined,
              left: coords.left,
              background: "var(--card-bg)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: "0.6rem",
              width: `${POPOVER_WIDTH}px`,
              boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.4)",
              zIndex: 100,
            }}
          >
            <div style={{ position: "relative", marginBottom: "0.5rem" }}>
              <Search
                size={13}
                style={{ position: "absolute", left: "0.55rem", top: "50%", transform: "translateY(-50%)", color: "var(--text-muted)" }}
              />
              <input
                ref={inputRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar por nome..."
                style={{ width: "100%", paddingLeft: "1.8rem", fontSize: "0.85rem" }}
              />
            </div>

            {loading && <p className="muted" style={{ fontSize: "0.82rem", margin: "0.4rem 0" }}>Carregando...</p>}
            {!loading && filtered.length === 0 && (
              <p className="muted" style={{ fontSize: "0.82rem", margin: "0.4rem 0" }}>
                Nenhuma função encontrada.
              </p>
            )}
            {!loading && filtered.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", maxHeight: "14rem", overflowY: "auto" }}>
                {filtered.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className="ghost"
                    onClick={() => pick(r)}
                    style={{
                      textAlign: "left",
                      padding: "0.4rem 0.5rem",
                      fontSize: "0.85rem",
                    }}
                  >
                    {r.name}
                  </button>
                ))}
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
