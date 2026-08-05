import { colorForName, initials } from "../lib/avatar";

/** Colored initials avatar for a colaborador's name — used anywhere a name shows up in a list (Colaboradores, Pagamentos, Cartão Ponto). */
export default function Avatar({ name }: { name: string }) {
  return (
    <span className="avatar" style={{ background: colorForName(name) }}>
      {initials(name)}
    </span>
  );
}
