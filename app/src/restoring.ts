import type { CacheRestore, Diagnostic } from "./ipc";

// The DOM half of restoration lives in main.ts, but the decision about whether a
// response still owns the build state is deliberately pure. A backend generation
// prevents late Rules from being installed; this decision independently prevents
// the matching late response from advertising those rules in the frontend.
export type RestorationDecision =
  | { kind: "compiled"; ruleCount: number; diagnostics: Diagnostic[]; reason: "hit" }
  | {
      kind: "not-compiled";
      reason: "disabled" | "miss" | "unavailable" | "not-requested" | "orphaned-superseded";
    }
  | {
      kind: "unchanged";
      reason: "selection-superseded" | "newer-build-owner" | "already-terminal";
    };

export type InvalidationBuildState =
  | "not-compiled"
  | "restoring"
  | "compiling"
  | "compiled"
  | "stale";

export interface RestorationOwner {
  kind: "restoration";
  selection: number;
  serial: number;
  revision: number;
}

export type BuildOwner =
  | { kind: "none" }
  | RestorationOwner
  | { kind: "compile"; serial: number; revision: number }
  | { kind: "invalidation"; revision: number };

export interface RestorationAuthority {
  selectionIsCurrent: boolean;
  operationIsCurrent: boolean;
  buildState: InvalidationBuildState;
  buildOwner: BuildOwner;
}

export function invalidationRequiresReset(state: InvalidationBuildState): boolean {
  return state === "restoring" || state === "compiling" || state === "compiled";
}

export function decideRestoration(
  response: CacheRestore,
  restoration: RestorationOwner,
  authority: RestorationAuthority,
): RestorationDecision {
  if (!authority.selectionIsCurrent) {
    return { kind: "unchanged", reason: "selection-superseded" };
  }

  if (!sameRestoration(authority.buildOwner, restoration)) {
    if (authority.buildOwner.kind !== "none") {
      return { kind: "unchanged", reason: "newer-build-owner" };
    }
    // A terminal state with no producer is already safe. The dangerous case is
    // exactly the state this module exists to prevent: `restoring` with nobody
    // identifiable left to settle it.
    if (authority.buildState !== "restoring") {
      return { kind: "unchanged", reason: "already-terminal" };
    }
    return { kind: "not-compiled", reason: "orphaned-superseded" };
  }

  if (!authority.operationIsCurrent) {
    // Normally invalidation or Compile replaced the owner synchronously. If a
    // caller lost operation currency without recording that producer, refusing
    // to leave `restoring` is the fail-safe answer.
    return authority.buildState === "restoring"
      ? { kind: "not-compiled", reason: "orphaned-superseded" }
      : { kind: "unchanged", reason: "already-terminal" };
  }

  switch (response.status) {
    case "hit":
      return {
        kind: "compiled",
        ruleCount: response.ruleCount,
        diagnostics: response.diagnostics,
        reason: "hit",
      };
    case "disabled":
      return { kind: "not-compiled", reason: "disabled" };
    case "miss":
      return { kind: "not-compiled", reason: "miss" };
    case "unavailable":
      return { kind: "not-compiled", reason: "unavailable" };
    case "notRequested":
      return { kind: "not-compiled", reason: "not-requested" };
    case "superseded":
      // Backend generation authority was lost but no correlated frontend
      // producer replaced this restoration. Remaining `restoring` would be an
      // orphan, so settle conservatively without touching any newer rules.
      return { kind: "not-compiled", reason: "orphaned-superseded" };
  }
}

export function sameRestoration(owner: BuildOwner, restoration: RestorationOwner): boolean {
  return (
    owner.kind === "restoration" &&
    owner.selection === restoration.selection &&
    owner.serial === restoration.serial &&
    owner.revision === restoration.revision
  );
}

export function decideRestorationFailure(
  restoration: RestorationOwner,
  authority: RestorationAuthority,
): RestorationDecision {
  return decideRestoration({ status: "superseded" }, restoration, authority);
}
