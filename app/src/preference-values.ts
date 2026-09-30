export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  const digits = value >= 10 ? 1 : 2;
  return `${value.toFixed(digits).replace(/\.0+$|(?<=\.[0-9])0$/, "")} ${units[unit]}`;
}

const BYTES_PER_MIB = 1024 * 1024;
const MAXIMUM_MIB = 1024 * 1024;

export function parseMaximumBytes(
  text: string,
): { ok: true; bytes: number } | { ok: false; error: string } {
  const value = text.trim();
  if (!/^[0-9]+$/.test(value)) {
    return { ok: false, error: "Maximum size must be a whole number of MiB." };
  }
  const mib = Number(value);
  if (!Number.isSafeInteger(mib) || mib < 1 || mib > MAXIMUM_MIB) {
    return { ok: false, error: "Maximum size must be between 1 MiB and 1 TiB." };
  }
  return { ok: true, bytes: mib * BYTES_PER_MIB };
}

export interface CacheControlInput {
  available: boolean;
  totalBytes: number;
  currentProjectCached: boolean;
}

export function cacheClearControls(
  status: CacheControlInput,
  root: string | null,
): { clearCurrent: boolean; clearAll: boolean } {
  return {
    clearCurrent: status.available && status.currentProjectCached && root !== null,
    clearAll: status.available && status.totalBytes > 0,
  };
}
