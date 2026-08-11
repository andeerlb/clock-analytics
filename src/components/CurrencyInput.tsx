import type { KeyboardEvent } from "react";
import { formatCentsMask } from "../lib/format";

/**
 * "R$ 1.234,56" masked currency input — builds the display mask from raw
 * digits as they're typed (cents-first, like a checkout amount field)
 * instead of a native `<input type="number">`, which shows a spinner that
 * makes no sense for a currency value and doesn't format while typing.
 *
 * Controlled by `digits` (the raw digit string, unformatted) rather than the
 * parsed amount, so a caller that needs "did the user actually touch this"
 * semantics (`EditableCurrencyCell`'s commit-on-blur, which must NOT commit
 * just from opening and closing the field) can layer that on top — this
 * component only owns the mask and the look. Use `centsMaskToAmount` (see
 * `lib/format`) to turn `digits` into a number on commit.
 */
export default function CurrencyInput({
  digits,
  onChange,
  id,
  placeholder,
  autoFocus,
  onBlur,
  onKeyDown,
  /** "sm" — compact, label-beside-input, for a dense table cell (`EditableCurrencyCell`). "md" — full-width boxed field with the "R$" prefix inset into the input itself, for a form/modal (`ConfirmPaymentModal`). */
  size = "md",
}: {
  digits: string;
  onChange: (digits: string) => void;
  id?: string;
  placeholder?: string;
  autoFocus?: boolean;
  onBlur?: () => void;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  size?: "sm" | "md";
}) {
  return (
    <div className={`currency-input currency-input-${size}`}>
      <span className="currency-input-prefix">R$</span>
      <input
        id={id}
        type="text"
        inputMode="numeric"
        autoFocus={autoFocus}
        placeholder={placeholder}
        value={digits === "" ? "" : formatCentsMask(digits)}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, ""))}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
