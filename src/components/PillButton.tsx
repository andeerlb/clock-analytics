import type { ButtonHTMLAttributes } from "react";

/**
 * Small pill-sized `button.outline` — transparent, fills on hover, no shadow
 * — for a button that needs to sit inline with badges/table cells instead of
 * at full button size. Shared by "Visto" (`ChangeDiffPanel`) and the
 * "extras" count trigger (`PaymentsPage`) so this size/hover treatment can't
 * drift between them.
 */
export default function PillButton({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={`outline pill-button ${className}`.trim()} {...props} />;
}
