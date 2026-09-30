// Deciding which open documents a compile has to write, and when the answer has
// stopped changing.
//
// The backend compiles what is on disk, so Compile writes out the dirty
// documents first. Which ones is not a fixed question: an edit can *change the
// answer*. Add `include "dep.yar"` to a dirty `main.yar` and `dep.yar` joins the
// project - but only once `main.yar` has been written, because the analysis that
// discovers the include reads `main.yar` from disk. Deciding membership once, up
// front, therefore compiles the new dependency's stale contents.
//
// So membership is driven to a fixpoint instead: write what is known to belong,
// re-analyse, write whatever that brought in, and repeat only while a wave
// actually wrote something. This lives apart from main.ts, with the filesystem
// and the analysis behind an interface, so the decision can be tested without a
// running application (see saveplan.test.mjs).

/**
 * What became of one document the plan asked for.
 *
 * A write can be declined for reasons that have nothing to do with failure: the file
 * changed on disk after the user was asked about it, or the document the plan named
 * has been closed or renamed onto another path. Neither is an error to report, and
 * neither may be passed over either - the compile that wanted this document written
 * would then read stale contents from disk and call the result compiled. So the
 * callback says which of these happened, and the plan stops on all but the first two.
 */
export type SaveOutcome =
  /** The document's text is on disk because this wrote it. */
  | { kind: "written" }
  /**
   * Nothing needed writing: the disk already holds this document's text. A save the
   * user made themselves, queued ahead of this plan, is the ordinary way that happens.
   */
  | { kind: "unchanged" }
  /**
   * The write was not made and is not permitted, so nothing that depends on this
   * document being on disk may proceed. `why` says what stopped it, in the caller's
   * words - the plan has no view about it beyond passing it back up.
   */
  | { kind: "refused"; why: string }
  /**
   * Whatever this plan is writing for has been superseded, and the callback found out
   * mid-write - deciding whether a document may be written takes its own awaits, and
   * `superseded` can become true during them.
   *
   * Nothing is wrong, so nothing is reported: this ends the plan exactly as the checks
   * around the awaits below do. Distinct from `refused` because a refusal is news the
   * caller has to act on, and an abandoned operation is not.
   */
  | { kind: "superseded" };

/** What a whole plan did. */
export interface SaveResult {
  /** The documents it wrote, in the order it wrote them. */
  written: string[];
  /** Why it stopped short, or null if it did not. */
  refused: string | null;
}

// What the fixpoint needs from the outside world.
export interface SaveEnvironment {
  // Every path the project's include graph currently reaches, spelled the way
  // open documents are keyed. Called only when the answer could still matter.
  //
  // A rejection is not absorbed here. If membership cannot be determined, the
  // remaining writes cannot be decided either, and continuing would compile
  // whatever is on disk while quietly skipping the dependencies the answer would
  // have named. It propagates to the caller's failure path instead.
  members(): Promise<Set<string>>;
  // Writes one document's editor contents to disk, and says what became of it. A
  // rejection is a failed write; a `refused` outcome is a write that was never made.
  save(key: string): Promise<SaveOutcome>;
  // True once this compile has been superseded - the user opened another folder,
  // or started a newer compile. Checked before every await that has effects, so
  // an abandoned operation stops writing rather than finishing on someone else's
  // behalf.
  superseded(): boolean;
}

// Writes the dirty documents belonging to the project being compiled, in the
// order it decided to write them, and reports what it managed.
//
// A refusal ends the plan there and is passed back rather than raised: the writes
// already made stand, and it is the caller that knows whether being one document short
// matters (for a compile it does - see main.ts).
//
// `dirty` is the candidate set: the caller has already excluded the scratch
// buffer, which has nowhere to write to. Documents outside the project - one left
// open from a folder the user has switched away from - are excluded here, by
// never appearing in `members`.
//
// Terminates because every iteration either returns or accounts for at least one
// document, no document is accounted for twice, and `dirty` is finite. At most
// `dirty.length + 1` analyses happen, and in the common case where the explorer
// list already accounts for every dirty document, none does.
export async function saveDirtyMembers(
  dirty: readonly string[],
  explorerMembers: ReadonlySet<string>,
  env: SaveEnvironment,
): Promise<SaveResult> {
  const written: string[] = [];
  const stopped = () => ({ written, refused: null });
  if (dirty.length === 0) return stopped();

  const members = new Set(explorerMembers);
  // Accounted for: written, or found to need no writing. Either way the disk holds
  // this document's text and the plan has no further business with it.
  const done = new Set<string>();
  const isDone = (key: string) => done.has(key);
  // The explorer's flat list is not the whole membership - a file opened from a
  // diagnostic can be nested below the root, or outside it entirely - so the
  // graph is consulted when, and only when, a dirty document is unaccounted for.
  let reanalyse = dirty.some((key) => !members.has(key));

  for (;;) {
    if (reanalyse) {
      if (env.superseded()) return stopped();
      for (const path of await env.members()) members.add(path);
    }

    const wave = dirty.filter((key) => !isDone(key) && members.has(key));
    // Nothing left that is known to belong: the answer has stopped changing.
    if (wave.length === 0) return stopped();

    for (const key of wave) {
      if (env.superseded()) return stopped();
      const outcome = await env.save(key);
      // Not a document to move on from: whatever wanted it written is now looking at
      // a disk that does not hold the editor's text. Carrying on would write the rest,
      // re-analyse around the gap and hand back a plan that reads as complete.
      if (outcome.kind === "refused") return { written, refused: outcome.why };
      // Superseded while this document was being decided. The writes already made stand
      // - they cannot be taken back - and nothing more is written for an operation
      // nobody is waiting for.
      if (outcome.kind === "superseded") return stopped();
      done.add(key);
      if (outcome.kind === "written") written.push(key);
    }

    // Those writes may have introduced includes, which can only pull in a
    // document that is still unaccounted for. When none is left there is nothing a
    // fresh analysis could tell us.
    reanalyse = dirty.some((key) => !isDone(key));
    if (!reanalyse) return stopped();
  }
}
