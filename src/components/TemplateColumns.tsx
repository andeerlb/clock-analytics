import type { ReactNode } from "react";
import OptionPicker, { type PickerOption } from "./OptionPicker";
import { columnIndexFromLetter, columnLetter } from "../lib/format";

/**
 * The column pickers shared by the template wizards' "Onde está cada
 * informação?" step (payments and colaboradores).
 */

/** `header`: the column's name in the sample file. `savedName`: the name kept in a saved template, shown only as a hint. */
export type GroupColumn = { index: number; header: string | null; savedName?: string | null };

/** A column chooser in the app's picker style: the column's name, its letter on the right. */
export function ColumnPicker({
  columns,
  value,
  placeholder,
  noneLabel,
  usedBy,
  onChange,
}: {
  columns: GroupColumn[];
  value: number | null;
  placeholder: string;
  /** Adds a first "no column" option (e.g. "Não tem"). */
  noneLabel?: string;
  /** What other questions already point at each column — a column holds one answer, picking it here moves it. */
  usedBy: Record<number, string>;
  onChange: (col: number | null) => void;
}) {
  const options: PickerOption[] = [
    ...(noneLabel ? [{ id: "none", label: noneLabel }] : []),
    ...columns.map((c) => {
      const parts = [
        c.header ? `coluna ${columnLetter(c.index)}` : null,
        c.savedName ? `“${c.savedName}”` : null,
        usedBy[c.index] ? `já é ${usedBy[c.index]}` : null,
      ];
      return {
        id: String(c.index),
        label: c.header ?? `Coluna ${columnLetter(c.index)}`,
        meta: parts.filter(Boolean).join(" · ") || undefined,
      };
    }),
  ];
  return (
    <OptionPicker
      single
      showTiles={false}
      align="left"
      options={options}
      selected={new Set(value === null ? [] : [String(value)])}
      onToggle={(id) => onChange(id === "none" ? null : Number(id))}
      title="Colunas"
      allPlaceholder={placeholder}
      searchPlaceholder="Buscar coluna"
    />
  );
}

/** One "Onde está ...?" row: the question, its column picker and an example value from the sample file. */
export function ColumnQuestion<F extends string>({
  label,
  hint,
  optional,
  columns,
  mapping,
  fieldLabel,
  value,
  onChange,
  example,
  children,
}: {
  label: string;
  hint?: string;
  optional?: boolean;
  columns: GroupColumn[];
  /** The group's answers, to flag columns another question already uses. */
  mapping: Record<number, F>;
  /** How an answer is named in "já é ..." */
  fieldLabel: (field: F) => string;
  value: number | null;
  onChange: (col: number | null) => void;
  example: (col: number) => { sheet: string; value: string } | null;
  children?: ReactNode;
}) {
  const ex = value === null ? null : example(value);
  const usedBy: Record<number, string> = {};
  for (const [col, field] of Object.entries(mapping)) {
    if (Number(col) !== value) usedBy[Number(col)] = fieldLabel(field);
  }
  return (
    <div className={`tmap-q${!optional && value === null ? " miss" : ""}`}>
      <label>
        {label}
        {hint && <small>{hint}</small>}
      </label>
      <div className="tmap-pick">
        <ColumnPicker
          columns={columns}
          value={value}
          placeholder={optional ? "Não tem" : "Escolha a coluna"}
          noneLabel={optional ? "Não tem" : undefined}
          usedBy={usedBy}
          onChange={onChange}
        />
        {ex && (
          <span className="tmap-ex">
            ex. {ex.sheet}: {ex.value}
          </span>
        )}
        {children}
      </div>
    </div>
  );
}

/**
 * The "Ignorar" row: any number of columns the import should drop — not
 * saved anywhere, not shown in "Outras colunas da planilha". Columns another
 * question already uses aren't offered (a column holds one answer); every
 * other unanswered column keeps going to the extras, as before.
 */
export function IgnoreQuestion<F extends string>({
  columns,
  mapping,
  ignoredField,
  onToggle,
  onClear,
}: {
  columns: GroupColumn[];
  mapping: Record<number, F>;
  /** The mapping value that means "ignored" (`IGNORED_COLUMN_FIELD`). */
  ignoredField: F;
  onToggle: (col: number) => void;
  onClear: () => void;
}) {
  const ignored = new Set(
    Object.entries(mapping)
      .filter(([, f]) => f === ignoredField)
      .map(([col]) => col),
  );
  // An ignored column past the listed ones (typed in) still shows as chosen.
  const listed = new Set(columns.map((c) => c.index));
  const all: GroupColumn[] = [
    ...columns,
    ...[...ignored].map(Number).filter((i) => !listed.has(i)).map((i) => ({ index: i, header: null })),
  ];
  const options: PickerOption[] = all
    .filter((c) => mapping[c.index] === undefined || mapping[c.index] === ignoredField)
    .map((c) => ({
      id: String(c.index),
      label: c.header ?? `Coluna ${columnLetter(c.index)}`,
      meta: [c.header ? `coluna ${columnLetter(c.index)}` : null, c.savedName ? `“${c.savedName}”` : null].filter(Boolean).join(" · ") || undefined,
    }));
  return (
    <div className="tmap-q">
      <label>
        Ignorar
        <small>opcional</small>
      </label>
      <div className="tmap-pick">
        <OptionPicker
          showTiles={false}
          align="left"
          options={options}
          selected={ignored}
          onToggle={(id) => onToggle(Number(id))}
          onClear={ignored.size > 0 ? onClear : undefined}
          onCreate={(text) => {
            // A column letter typed in (e.g. "AB"), for one past the list.
            const index = columnIndexFromLetter(text.replace(/^coluna\s+/i, ""));
            if (index !== null && mapping[index] === undefined) onToggle(index);
          }}
          title="Colunas a ignorar"
          allPlaceholder="Nenhuma"
          searchPlaceholder="Buscar coluna"
        />
        <span className="tmap-ex">
          Colunas que a importação descarta: não são salvas e não aparecem em “Outras colunas da planilha”. As demais colunas sem resposta continuam aparecendo lá.
        </span>
      </div>
    </div>
  );
}
