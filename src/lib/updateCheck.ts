import { check, type Update } from "@tauri-apps/plugin-updater";

const REPO_OWNER = "andeerlb";
const REPO_NAME = "clock-analytics";

export const REPO_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}`;
/** For the manual fallback link on installs the updater can't self-replace (.deb/.rpm) or when an automatic update fails. */
export const LATEST_RELEASE_URL = `${REPO_URL}/releases/latest`;

/**
 * Checks the GitHub Releases updater manifest (`plugins.updater.endpoints`
 * in tauri.conf.json, published as `latest.json` alongside each release —
 * see `release.yml`) for a newer version than the one currently running.
 * `null` means "no update available"; a thrown error means the check
 * itself failed (offline, no releases published yet, GitHub unreachable) —
 * kept distinct so a caller can choose whether that's worth surfacing: the
 * Sidebar's passive check on launch treats both the same (silently, it's
 * just an ambient hint), but Configurações' on-demand "Procurar
 * atualização" button should tell the user their check failed rather than
 * claim they're up to date.
 *
 * Returns the live `Update` resource itself (not a plain status object),
 * since actually installing means calling back into it via `UpdateModal` —
 * a caller that checks but never shows/acts on the result must call
 * `.close()` on it directly to release the underlying resource.
 */
export async function checkForUpdate(): Promise<Update | null> {
  return check();
}
