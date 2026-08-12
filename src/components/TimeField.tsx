import { maskTime } from "../lib/format";

/**
 * Single "HH:MM" text field, masked as-you-type — stands in for `<input
 * type="time">`, whose WebView2/Chromium popup renders as an unstyled white
 * spinner that clashes with the app's dark theme. `size`/`maxLength` keep it
 * as narrow as the "23:59" it holds by default; pass `className="glass-input"`
 * to match the wizard-style rule cards instead.
 */
export default function TimeField({
  id,
  value,
  onChange,
  required,
  className,
  ariaLabel,
}: {
  id?: string;
  /** 24h "HH:MM". */
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <input
      id={id}
      className={className}
      type="text"
      inputMode="numeric"
      size={5}
      maxLength={5}
      value={value}
      onChange={(e) => onChange(maskTime(e.target.value))}
      placeholder="HH:MM"
      pattern="\d{2}:\d{2}"
      title="Formato HH:MM"
      required={required}
      aria-label={ariaLabel}
    />
  );
}
