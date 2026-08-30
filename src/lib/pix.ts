export type PixKeyType = "cpf" | "cnpj" | "phone" | "email" | "random" | "other";

export const PIX_KEY_TYPE_LABELS: Record<PixKeyType, string> = {
  cpf: "CPF",
  cnpj: "CNPJ",
  phone: "Telefone",
  email: "E-mail",
  random: "Aleatória",
  other: "Outro",
};

export const PIX_KEY_TYPES = Object.keys(PIX_KEY_TYPE_LABELS) as PixKeyType[];

function hasValidCpfCheckDigits(digits: string): boolean {
  if (!/^\d{11}$/.test(digits) || /^(\d)\1{10}$/.test(digits)) return false;
  const digit = (length: number) => {
    const sum = digits.slice(0, length).split("").reduce((total, value, index) => total + Number(value) * (length + 1 - index), 0);
    const remainder = (sum * 10) % 11;
    return remainder === 10 ? 0 : remainder;
  };
  return digit(9) === Number(digits[9]) && digit(10) === Number(digits[10]);
}

function hasValidCnpjCheckDigits(digits: string): boolean {
  if (!/^\d{14}$/.test(digits) || /^(\d)\1{13}$/.test(digits)) return false;
  const calculate = (base: string, weights: number[]) => {
    const sum = base.split("").reduce((total, value, index) => total + Number(value) * weights[index], 0);
    const remainder = sum % 11;
    return remainder < 2 ? 0 : 11 - remainder;
  };
  const first = calculate(digits.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const second = calculate(`${digits.slice(0, 12)}${first}`, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return first === Number(digits[12]) && second === Number(digits[13]);
}

/** Best-effort classification only; the employee screen always lets a user correct it. */
export function detectPixKeyType(raw: string): PixKeyType {
  const value = raw.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return "email";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) return "random";
  const digits = value.replace(/\D/g, "");
  if (!value.startsWith("+") && hasValidCpfCheckDigits(digits)) return "cpf";
  if (hasValidCnpjCheckDigits(digits)) return "cnpj";
  if ((digits.length === 10 || digits.length === 11) || (digits.length === 12 || digits.length === 13) && digits.startsWith("55")) return "phone";
  return "other";
}

/** Multiple mapped PIX columns arrive newline-joined; cells may also use common list separators. */
export function parsePixKeys(raw: string): string[] {
  return Array.from(new Set(raw.split(/[\n;|]+/).map((key) => key.trim()).filter(Boolean)));
}
