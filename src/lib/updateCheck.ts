import { getVersion } from "@tauri-apps/api/app";

const REPO_OWNER = "andeerlb";
const REPO_NAME = "clock-analytics";

export const REPO_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}`;

export interface UpdateStatus {
  currentVersion: string;
  latestVersion: string | null;
  latestUrl: string | null;
  updateAvailable: boolean;
}

/** "v1.2.3" or "1.2.3" -> [1, 2, 3] — anything non-numeric (a pre-release suffix, say) reads as 0. */
function parseVersion(v: string): number[] {
  return v
    .replace(/^v/i, "")
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
}

function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * Compares the running app version (from `tauri.conf.json`, read via
 * Tauri's own API rather than duplicated here) against the latest GitHub
 * Release tag. Best-effort: a network failure (offline, rate-limited, no
 * releases published yet) just means no update is reported, not an error
 * shown to the user — this is an ambient "nova versão disponível" hint, not
 * a required check.
 */
export async function checkForUpdate(): Promise<UpdateStatus> {
  const currentVersion = await getVersion();
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`);
    if (!res.ok) throw new Error(`GitHub respondeu ${res.status}`);
    const data = (await res.json()) as { tag_name: string; html_url: string };
    return {
      currentVersion,
      latestVersion: data.tag_name,
      latestUrl: data.html_url,
      updateAvailable: isNewer(data.tag_name, currentVersion),
    };
  } catch {
    return { currentVersion, latestVersion: null, latestUrl: null, updateAvailable: false };
  }
}
