/**
 * The chip filters (Cartão Ponto status, Pagamentos status and turno) keep
 * exactly what was picked, and an empty set means "no filter". Queries
 * still expect every option for "no filter", so they read the set through
 * this.
 */
export function orAll<T>(picked: Set<T>, all: readonly T[]): T[] {
  return picked.size === 0 ? [...all] : Array.from(picked);
}
