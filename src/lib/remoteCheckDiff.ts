import { rpc } from "./http";
import type { ReimportConfig } from "./db";

/**
 * "Aceitar e atualizar": a person reviewing one turno's pending change
 * confirms it should be written. The server downloads `config.sourceUrl`
 * fresh and runs the same diff the automatic check uses, scoped to this one
 * shift, with both protections (edited by hand / already paid) lifted:
 * clicking "Aceitar" is the consent they exist to ask for.
 *
 * The diff itself (`computeReimportDiff`) lives on the server with the
 * automatic check: see server/src/remote_checks/diff.rs.
 */
export async function acceptShiftChange(config: ReimportConfig, shiftId: number): Promise<void> {
  await rpc<void>("acceptShiftChange", { configId: config.id, shiftId });
}
