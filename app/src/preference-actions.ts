// Native confirmation is injected so the authorization boundary is testable
// without a browser or Tauri. The current-project helper returns the root named
// by the question, never a root read again after the await.

export async function authorizeCurrentCacheClear(
  capturedRoot: string | null,
  ask: () => Promise<boolean>,
): Promise<string | null> {
  if (capturedRoot === null) return null;
  return (await ask()) ? capturedRoot : null;
}

export async function authorizeAllCachesClear(ask: () => Promise<boolean>): Promise<boolean> {
  return ask();
}

interface ClearEffects {
  isCurrent: () => boolean;
  isOpen: () => boolean;
  clear: () => Promise<void>;
  setBusy: (busy: boolean) => void;
  clearError: () => void;
  showError: (error: unknown) => void;
  refresh: () => void;
}

export async function runPreferenceClear(effects: ClearEffects): Promise<void> {
  if (effects.isCurrent()) {
    effects.clearError();
    effects.setBusy(true);
  }
  try {
    await effects.clear();
  } catch (error) {
    if (effects.isCurrent()) {
      effects.showError(error);
      effects.setBusy(false);
    }
    return;
  }
  // A successful clear remains authoritative backend work even if its original
  // dialog generation closed. If Preferences is open now, a newly-owned status
  // request is the only safe way to reflect it.
  if (effects.isOpen()) effects.refresh();
}
