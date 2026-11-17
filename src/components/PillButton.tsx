import type { ButtonHTMLAttributes } from "react";

/**
 * Small pill-sized `button.outline` — transparent, fills on hover, no shadow
 * — for a button that needs to sit inline with badges/table cells instead of
 * at full button size. Used by the "extras" count trigger (`PaymentsPage`).
 */
export default function PillButton({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={`outline pill-button ${className}`.trim()} {...props} />;
}
