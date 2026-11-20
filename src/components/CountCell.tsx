/**
 * A count column in the cadastro lists. On a desktop the header names the
 * column, so the cell is just the number; on a phone (`mobile-cards`) the
 * header is hidden, so the unit shows next to the number instead.
 */
export default function CountCell({ value, singular, plural }: { value: number; singular: string; plural: string }) {
  return (
    <td className="count-col">
      {value.toLocaleString("pt-BR")}
      <span className="count-unit"> {value === 1 ? singular : plural}</span>
    </td>
  );
}
