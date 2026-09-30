// The editor's open documents, without Monaco.
//
// One document per key: a file's absolute path, or "" for a scratch buffer that
// has no path at all. Each document remembers which revision of itself is on
// disk, so "dirty" is a comparison rather than a flag something has to remember
// to clear.
//
// Saving is why this is a module of its own. A write is asynchronous and the user
// can keep typing during it, so what reaches the disk is the text as it was when
// the write STARTED. Marking the document clean at whatever revision it has when
// the write finishes declares an edit saved that was never written - and Ctrl+S,
// having apparently been serviced, would not write it again. So a save is two
// steps over an opaque snapshot: `beginSave` captures the document, the model, the
// exact text and the revision; `completeSave` moves the baseline to THAT revision,
// and only while the same model is still open under the same key.
//
// Each document also remembers the TEXT of the revision it last agreed with the
// disk on, which is what lets an external change be classified rather than
// guessed at. A file changed by another program is either identical to what Quipu
// last wrote (nothing happened), identical to what the editor is showing (the
// editor is already right), a change to a document the user has not touched (it
// can simply be reloaded), or a change to one they have (a conflict, and their
// text is never replaced). See `reconcile`.
//
// That agreement is itself counted, because reads of the disk are asynchronous
// too. A read is issued against the agreement in force when it started, and if
// something has established a NEW one since - a save that wrote the file, a reload
// that took the file's text - then what the read found is a comparison against a
// baseline that no longer exists, and acting on it would reinstate the state the
// disk has just moved out of. The model's revision cannot stand in for this: a
// save moves the baseline without moving the revision. So each document carries a
// `baselineId`, every probe records it, and `reconcile` and `reload` refuse a probe
// drawn against an earlier one. An EDIT deliberately does not move it - that is the
// case a conflict exists for.
//
// What those reads FOUND is counted too, and that is a third thing again. Recording
// a disagreement deliberately establishes no new baseline, so two different external
// versions of one file are both just "changed on disk" and nothing tells them apart.
// A write, though, is authorised against a particular version: the user is shown one,
// and by the time the write takes its turn in the queue the file may hold another. So
// each document also counts the OBSERVATIONS of its file - accepted answers, whatever
// they concluded - advancing only when what was found differs from what was found
// before. The number is opaque: a caller records it when it asks the user, hands it
// back when the write's turn comes, and an unequal one means the answer it holds was
// about a version that is no longer there. Repeating an observation - a catch-up
// re-reading an external version already reported, a file that is still missing -
// tells nobody anything new, and must not invalidate an authorisation given for it.
//
// One thing an authorisation depends on cannot be answered by counting what was found,
// though, because it is about the document rather than the file: whether the editor has
// since TAKEN the file's side. Quipu's own save leaves the file holding Quipu's text,
// which is nobody else's doing and no news, so a write queued behind it still means
// what it meant. Reload from Disk is the opposite: it replaces the document with the
// file's contents, so the revision a queued write captured is one the user has just
// discarded, and writing it would put their discarded text back. Replacing a document's
// text is therefore counted too - see `reload` - and a caller that recorded the count
// when it asked can tell those two transitions apart.
//
// The reads are counted as well, and for a reason the baseline cannot cover. Two
// reads of one file can be in flight at once - automatic reconciliation overlapping
// a manual Refresh, a fence's catch-up overlapping either - and the outcomes that
// merely record a disagreement (`missing`, `conflict`) deliberately establish no new
// baseline, because a disagreement is not knowledge of what the file holds. So the
// baseline cannot order two reads taken against the same one, and the answers can
// land in either order: a later read finding the file present but changed, then an
// earlier read landing with "it was gone", would leave the document claiming a file
// that exists has been deleted. Each document therefore counts the reads issued for
// it and remembers the highest one whose answer has been applied; an answer from
// below that mark is inert. It is deliberately NOT the same counter as the baseline:
// what it orders is competing questions, not competing facts about the disk.
//
// No Monaco and no DOM. A model is anything that can report its alternative
// version id and its text, which Monaco's `ITextModel` does, so the bookkeeping
// can be tested on its own (see documents.test.mjs) while editor.ts keeps the
// parts that are genuinely Monaco's.

/** What the bookkeeping needs of a text model. Monaco's ITextModel satisfies it. */
export interface DocModel {
  // The *alternative* version id, not the plain one: it goes back to an earlier
  // value when the user undoes back to an earlier state, so a document undone all
  // the way back to what is on disk is correctly clean again.
  getAlternativeVersionId(): number;
  getValue(): string;
  setValue(text: string): void;
}

// A revision id no model can report. Monaco's version ids start at 1 and only
// ever move between values it has issued, so a document whose baseline is this
// differs from disk no matter what it does next - which is what a document
// carrying unsaved edits onto a new model (a rename) needs.
const NEVER_SAVED = -1;

// One document as it was when a disk operation on it started, to be handed back
// when that operation finishes.
//
// `key` is for the caller - it is the path to read or write. The rest is opaque:
// which document this is, which revision of it, which agreement with the disk it was
// drawn against, and where it comes in the order of that document's disk operations.
// Pass the probe back unchanged rather than taking it apart.
export interface DiskProbe<M extends DocModel = DocModel> {
  readonly key: string;
  readonly model: M;
  readonly versionId: number;
  readonly baselineId: number;
  // This operation's place in the sequence of operations issued for this document.
  // What makes an older read inert once a newer one has been answered, in the cases
  // where neither answer establishes a new baseline. See the note at the top.
  readonly readId: number;
}

/**
 * One at-risk document as a confirmation was shown it: which document, and which
 * revision of it.
 *
 * A path is not enough to identify work. The question "and lose a.yar?" is answered
 * across an await, and in that interval the document under a.yar can be edited
 * further, or closed and re-created by a refresh or a rename, so the path can still
 * be at risk while the work at risk under it is work nobody has been asked about. The
 * model pins which document it is - object identity, as everywhere else in this file -
 * and the version id pins which revision of it. A `model` of null is a key with no
 * document open under it at all, which cannot be at risk and matches no stamp taken
 * of a real one.
 */
export interface RiskStamp<M extends DocModel = DocModel> {
  readonly key: string;
  readonly model: M | null;
  readonly versionId: number;
}

/** The paths of an at-risk set, for the wording of a question about it. */
export function riskKeys(stamps: readonly RiskStamp[]): string[] {
  return stamps.map((stamp) => stamp.key);
}

/**
 * Whether everything now at risk was shown in the answered question, as the same
 * document at the same revision.
 *
 * Not equality, in one direction only. Work that has been saved, reloaded or closed
 * since simply is not at risk any more, and refusing over that would let a save
 * landing during the question cancel the user's answer. The other direction is what
 * may not happen: a document that became at risk while the dialogue was up, or a
 * further edit to one that was already in it, is work the user has never been shown,
 * and an answer given without it does not authorise discarding it.
 */
export function coversRisk(
  shown: readonly RiskStamp[],
  atRisk: readonly RiskStamp[],
): boolean {
  return atRisk.every((now) =>
    shown.some(
      (then) =>
        then.key === now.key && then.model === now.model && then.versionId === now.versionId,
    ),
  );
}

// One document as it was when a save started, to be handed back to completeSave()
// when the write finishes.
//
// `text` is the exact string to write, and re-reading the model instead is the bug
// this type exists to prevent.
export interface SaveSnapshot<M extends DocModel = DocModel> extends DiskProbe<M> {
  readonly text: string;
}

/**
 * How an open document disagrees with the disk.
 *
 * `changed` is an external write the editor cannot simply take: the document has
 * unsaved edits, so replacing it would destroy them and overwriting the file
 * would destroy the other program's. `missing` is the file having been removed or
 * renamed away; the document stays open, because its text is the only copy left.
 */
export type ConflictKind = "changed" | "missing";

/** What one reconciliation read found on disk. */
export type DiskState = { present: true; text: string } | { present: false };

/**
 * How a document stood with its file at one moment: the disagreement, if any, which
 * observation of the file that was, and how many times the document had taken the
 * file's side.
 *
 * All of it, never the kind on its own. "Changed on disk" says nothing about WHICH
 * version is there, and the same kind can outlive the version it was reported for, so
 * an answer given about one external version would otherwise authorise a write over
 * the next one. Nor does the kind survive being resolved: Quipu's own save clears it
 * without anything having happened that the user was not asking for, and a reload
 * clears it by discarding exactly the text a queued write would put back. What a
 * confirmation records and what the write re-checks when its turn comes; opaque, so
 * compare two of them rather than taking one apart.
 */
export interface DiskAnswer {
  readonly conflict: ConflictKind | null;
  readonly observation: number;
  readonly restored: number;
}

/**
 * What reconciling a document against the disk concluded.
 *
 * Everything except `reload` has already been recorded; `reload` is deliberately
 * the one outcome that changes nothing, because replacing a document's text has
 * to be guarded on the read still describing it (see [`DocumentSet.reload`]).
 */
export type Reconciliation =
  /**
   * The read no longer describes the document it probed, the baseline it was drawn
   * against has been superseded since, or a later read of the same file has already
   * been answered. See `reconcile`.
   */
  | { kind: "stale" }
  /** The file is gone. Recorded as a `missing` conflict. */
  | { kind: "missing" }
  /** The disk still holds the revision this document was last agreed with. */
  | { kind: "none" }
  /** The disk now holds exactly what the editor shows; the baseline moved to it. */
  | { kind: "adopt" }
  /** An external write to a document with unsaved edits. Recorded as a conflict. */
  | { kind: "conflict" }
  /** A clean document whose file changed: `text` is what to reload it with. */
  | { kind: "reload"; text: string };

/**
 * What a document takes with it when it is re-keyed onto another path.
 *
 * A rename re-creates the model (a Monaco URI is immutable), so the new document
 * cannot derive any of these for itself: `dirty` because a fresh model reports no
 * changes of its own, `diskText` because the file under the new path holds whatever
 * the old path held rather than what the model says, and `conflict` because a
 * disagreement with the disk was moved to the new path along with the file - the
 * rename settled where the bytes live, not whose version of them is right.
 */
export interface Carried {
  dirty: boolean;
  diskText: string | null;
  conflict: ConflictKind | null;
  // What the file was last seen to hold, which the rename moved onto the new path
  // along with the bytes. Deliberately not `diskText`: a document in conflict has seen
  // a version it has not agreed with, and that version is what is under the new name
  // now - so a read of it there is not news, and does not invalidate an authorisation
  // given about it.
  observed: string | null;
}

interface Doc<M extends DocModel> {
  model: M;
  // The alternative version id the contents had when they last matched the disk.
  savedVersionId: number;
  // The TEXT of that revision, or null when it is not known - a document carrying
  // unsaved edits onto a path nothing has written yet. Not derivable from the
  // model: the point of holding it is to compare against a model that has since
  // moved on.
  diskText: string | null;
  conflict: ConflictKind | null;
  // Identifies the agreement above. Advanced whenever `savedVersionId` and
  // `diskText` are replaced by something that knows what the file holds: a
  // completed save, a reload, or a reconciliation that found the disk had caught up
  // with the editor. A probe taken before that describes a comparison that no
  // longer exists; see the note at the top of this file.
  baselineId: number;
  // Counts the disk operations issued for this document, so that two of them can be
  // put in order. Handed out by `probe`; never reused.
  reads: number;
  // The highest `reads` value whose answer has been applied. An answer from at or
  // above it is the newest word on the subject; one from below it has been overtaken
  // by a read that saw the file later, whether or not that read moved the baseline.
  answered: number;
  // What the file was last KNOWN to hold - the contents the newest accepted answer
  // found, or null for a file that was not there. Not `diskText`, which is the
  // revision this document AGREES with: an external version the user has not taken is
  // observed without being agreed with, and it is the version a write would replace.
  observed: string | null;
  // Counts changes to `observed`, and only changes to it. Handed out as part of a
  // [`DiskAnswer`] so that permission given for one version of a file cannot be spent
  // on another; see the note at the top of this file.
  observation: number;
  // Counts the times this document's contents have been replaced with its file's. Also
  // handed out as part of a [`DiskAnswer`], and for the half of an authorisation the
  // observations cannot answer: whether the revision a queued write captured is one the
  // user has since discarded by taking the file's version instead.
  restored: number;
}

export class DocumentSet<M extends DocModel = DocModel> {
  // Insertion-ordered, which is the order the explorer and the compile's save
  // plan see documents in. Nothing depends on it being that order in particular,
  // only on it being the same order every time.
  private docs = new Map<string, Doc<M>>();

  has(key: string): boolean {
    return this.docs.has(key);
  }

  keys(): string[] {
    return [...this.docs.keys()];
  }

  model(key: string): M | null {
    return this.docs.get(key)?.model ?? null;
  }

  textOf(key: string): string {
    return this.docs.get(key)?.model.getValue() ?? "";
  }

  isDirty(key: string): boolean {
    const doc = this.docs.get(key);
    return doc !== undefined && doc.model.getAlternativeVersionId() !== doc.savedVersionId;
  }

  /** Every open document with unsaved edits, in the order they were opened. */
  dirtyKeys(): string[] {
    return this.keys().filter((key) => this.isDirty(key));
  }

  /** How the document under `key` disagrees with the disk, if it does. */
  conflictOf(key: string): ConflictKind | null {
    return this.docs.get(key)?.conflict ?? null;
  }

  /**
   * How the document under `key` stands with its file, as one comparable answer.
   *
   * What a confirmation is recorded as, and what the write it authorised re-checks
   * when its turn comes; see [`DiskAnswer`]. A key nothing is open under answers with
   * no conflict and nothing having happened to it, which is what a write to a path this
   * window is not showing a document for has to be held to.
   */
  diskAnswer(key: string): DiskAnswer {
    const doc = this.docs.get(key);
    if (doc === undefined) return { conflict: null, observation: 0, restored: 0 };
    return { conflict: doc.conflict, observation: doc.observation, restored: doc.restored };
  }

  // Records what an accepted answer found on disk, and counts it only if it is news.
  //
  // Two answers that found the same thing are one observation: a catch-up re-reading
  // an external version that has already been reported, or a file that is still
  // missing, tells nobody anything new, and counting it would revoke a permission the
  // user gave for exactly that version.
  private observe(doc: Doc<M>, found: string | null): void {
    if (found === doc.observed) return;
    doc.observed = found;
    doc.observation += 1;
  }

  /** Every open document currently in conflict, in the order they were opened. */
  conflictedKeys(): string[] {
    return this.keys().filter((key) => this.conflictOf(key) !== null);
  }

  /**
   * Whether the document under `key` holds work the disk does not.
   *
   * Unsaved edits, or any disagreement with the disk. The second is what a plain
   * dirty check misses: a file deleted or renamed away while it was open leaves a
   * document whose text is the last copy of it anywhere, and it reports no unsaved
   * edits because nothing was edited. Saving it writes the file back.
   */
  needsSaving(key: string): boolean {
    return this.isDirty(key) || this.conflictOf(key) !== null;
  }

  /**
   * Every open document whose text would be lost with it, in the order they were
   * opened. What closing the project has to be confirmed against.
   *
   * Unsaved edits, or a file that is no longer there at all. Deliberately not every
   * conflict: a clean document whose file merely changed underneath it holds nothing
   * the disk has not got, so naming it in that question would be asking the user to
   * protect something that is not at risk.
   */
  atRiskKeys(): string[] {
    return this.keys().filter((key) => this.isDirty(key) || this.conflictOf(key) === "missing");
  }

  /**
   * The same set, as which document and which revision each one is: what a
   * confirmation about it has to be held to. See [`RiskStamp`].
   */
  atRiskStamps(): RiskStamp<M>[] {
    return this.atRiskKeys().map((key) => this.stampOf(key));
  }

  /** How the document under `key` stands as work at risk, whether or not it is. */
  stampOf(key: string): RiskStamp<M> {
    const doc = this.docs.get(key);
    if (doc === undefined) return { key, model: null, versionId: 0 };
    return { key, model: doc.model, versionId: doc.model.getAlternativeVersionId() };
  }

  // Registers a document under `key`, creating its model only if the key is not
  // open already - `created` says which happened, so the caller can do the rest
  // of the setting up (an LSP notification, change listeners) exactly once.
  //
  // `carried` is for a rename, and only for a rename: see [`Carried`]. Without it
  // the document starts out agreeing with the disk at the text it was created
  // with, which is what opening a file that has just been read means.
  ensure(key: string, create: () => M, carried?: Carried): { model: M; created: boolean } {
    const existing = this.docs.get(key);
    if (existing !== undefined) return { model: existing.model, created: false };
    const model = create();
    this.docs.set(key, {
      model,
      savedVersionId: carried?.dirty === true ? NEVER_SAVED : model.getAlternativeVersionId(),
      diskText: carried === undefined ? model.getValue() : carried.diskText,
      conflict: carried?.conflict ?? null,
      // Deliberately not carried across a rename: the new document is a different
      // model under a different key, so every probe of the old one is already stale
      // by identity and nothing can be superseded by starting again from 0.
      baselineId: 0,
      // Likewise: a probe of the document this one replaces names another model, so
      // there is no ordering to inherit.
      reads: 0,
      answered: 0,
      // A file that has just been read holds what it was opened with; a rename brings
      // the old path's last observation with it. Counting starts at 0 either way,
      // because a confirmation names a document and a rename makes another one.
      observed: carried === undefined ? model.getValue() : carried.observed,
      observation: 0,
      // Likewise from 0: nothing has replaced THIS document's contents, and an
      // authorisation given for the document a rename replaced names the other one.
      restored: 0,
    });
    return { model, created: true };
  }

  /**
   * What re-keying `key` onto another path should carry across, or null when
   * nothing is open under it.
   */
  carriedFrom(key: string): Carried | null {
    const doc = this.docs.get(key);
    if (doc === undefined) return null;
    return {
      dirty: this.isDirty(key),
      diskText: doc.diskText,
      conflict: doc.conflict,
      observed: doc.observed,
    };
  }

  // Forgets the document under `key` and returns its model for the caller to
  // announce as closed and dispose of, or null if there was none.
  remove(key: string): M | null {
    const doc = this.docs.get(key);
    if (doc === undefined) return null;
    this.docs.delete(key);
    return doc.model;
  }

  // Captures the document under `key` exactly as it is now: which model it is,
  // which revision of it, which agreement with the disk that revision was reached
  // against, and where this operation comes in the document's own order. Null when
  // nothing is open under `key`.
  //
  // What a reconciliation read is issued against: it captures first and proves
  // afterwards that nothing it depended on moved while it was reading. Which is
  // why it may never re-read the model to find out what it was working on.
  //
  // Taking a probe therefore CLAIMS a place in that order, and each call takes a new
  // one: two probes of the same document are two operations, and which of them speaks
  // last is decided by the numbers rather than by which reply arrives first.
  probe(key: string): DiskProbe<M> | null {
    const doc = this.docs.get(key);
    if (doc === undefined) return null;
    doc.reads += 1;
    return {
      key,
      model: doc.model,
      versionId: doc.model.getAlternativeVersionId(),
      baselineId: doc.baselineId,
      readId: doc.reads,
    };
  }

  /**
   * Whether `expect` still describes the document open under its key.
   *
   * Identity only: the same key, still open, still on the same model. What a
   * mutation that has waited its turn behind another one checks before it acts - the
   * document it was asked about may have been closed or renamed while it queued, and
   * writing then would write to a path nobody is looking at. Deliberately says
   * nothing about revisions, baselines or conflicts: those are for `reconcile`.
   */
  holds(expect: DiskProbe<M>): boolean {
    const doc = this.docs.get(expect.key);
    return doc !== undefined && doc.model === expect.model;
  }

  // Captures what a save is about to write. Null when nothing is open under
  // `key`, which is the caller's cue not to write anything at all.
  //
  // The same capture a read is issued against, plus the text: a save is a disk
  // operation like any other, and the revision it writes is the one it captured
  // here rather than whatever the model says when the write lands.
  beginSave(key: string): SaveSnapshot<M> | null {
    const probe = this.probe(key);
    if (probe === null) return null;
    return { ...probe, text: probe.model.getValue() };
  }

  /**
   * Classifies what a read of `expect`'s file found, and records everything except
   * a reload.
   *
   * `expect` is the probe the read was issued against, and it is what scopes the
   * whole conclusion: a read describes the document it started from, and nothing
   * else. If a different model is under that key by now - a rename re-creates one -
   * then this read is about a document that has gone, and recording a conflict or
   * moving a baseline would be recording it against a stranger. Nor may it be about
   * a baseline that has been superseded: a save or a reload since the read started
   * knows what the file holds, and this read does not.
   *
   * The model's *revision* deliberately does not have to match. An edit made while
   * the file was being read leaves the same model in place with unsaved changes,
   * which is exactly the conflict this is here to find - and an edit moves no
   * baseline, so it does not make the read stale either.
   *
   * Nor may it be an answer a LATER read has already given. Two reads of one file
   * overlap whenever automatic reconciliation meets a manual Refresh or a fence's
   * catch-up, and `missing` and `conflict` establish no baseline to be superseded by,
   * so without this the answers would take effect in whatever order they arrived: a
   * file that a later read found present and changed could end up recorded as deleted.
   *
   * The order of the tests is the meaning:
   *
   * * not the document that was probed, or not the baseline it was probed against,
   *   or overtaken by a later read of the same file - see above;
   * * gone from the disk - a conflict, never a reason to close the document;
   * * still the revision this document was last agreed with - a notification with
   *   nothing behind it, including Quipu's own completed save arriving late;
   * * already what the editor is showing - the editor is right, so the baseline
   *   moves to it and the document is clean rather than conflicted;
   * * unsaved edits - a conflict, and `diskText` is deliberately NOT moved, so
   *   every later reconcile reaches this same answer until it is resolved. Nor is
   *   the baseline: marking a disagreement establishes nothing about the file, so a
   *   read of it that is still in flight is still worth having;
   * * otherwise a clean document whose file changed underneath it, which is the
   *   only case the caller has anything left to do.
   */
  reconcile(expect: DiskProbe<M>, disk: DiskState): Reconciliation {
    const doc = this.docs.get(expect.key);
    if (doc === undefined || doc.model !== expect.model) return { kind: "stale" };
    if (doc.baselineId !== expect.baselineId) return { kind: "stale" };
    if (expect.readId < doc.answered) return { kind: "stale" };
    // From here every path returns an answer, and this read is the newest one given.
    doc.answered = expect.readId;
    // Before the classification, and whatever it turns out to be: what the file holds
    // is what a write would replace, and every outcome below - including the ones that
    // establish no baseline and the one that merely repeats a conflict already known -
    // is this read's report of it.
    this.observe(doc, disk.present ? disk.text : null);
    if (!disk.present) {
      doc.conflict = "missing";
      return { kind: "missing" };
    }
    if (disk.text === doc.diskText) {
      doc.conflict = null;
      return { kind: "none" };
    }
    if (disk.text === doc.model.getValue()) {
      doc.savedVersionId = doc.model.getAlternativeVersionId();
      doc.diskText = disk.text;
      doc.conflict = null;
      // A new agreement, so an older read still in flight no longer describes this
      // document's relationship with its file: reloading it with what that read
      // found would replace text the disk has since been shown to hold.
      doc.baselineId += 1;
      return { kind: "adopt" };
    }
    if (this.isDirty(expect.key)) {
      doc.conflict = "changed";
      return { kind: "conflict" };
    }
    return { kind: "reload", text: disk.text };
  }

  /**
   * Replaces the document `expect` describes with `text`, and reports whether it
   * did.
   *
   * False means the read no longer describes anything worth replacing: the
   * document was closed, a rename put a different model under the key, its baseline
   * was superseded by a save or by another reload, a later read of the same file has
   * already been answered, or its contents moved while the file was being read.
   * Nothing is touched in that case, not even the baseline, so the next reconcile
   * decides again with current facts.
   *
   * A successful reload is a new agreement with the disk, not an edit: the
   * document is clean at the revision just installed, and any conflict it was in
   * has been resolved by taking the other side.
   *
   * Taking the other side is also counted, because it is the one way an authorisation
   * to write can be revoked by the user themselves: the text a write queued behind this
   * captured has just been discarded, and writing it would put it back. See
   * [`DiskAnswer`].
   */
  reload(expect: DiskProbe<M>, text: string): boolean {
    const doc = this.docs.get(expect.key);
    if (doc === undefined || doc.model !== expect.model) return false;
    if (doc.baselineId !== expect.baselineId) return false;
    // Deliberately `<` and not `<=`: a `reload` outcome is one answer given in two
    // steps by one read, and `reconcile` has already recorded this read as the newest.
    // Refusing an equal number would refuse every reload there is.
    if (expect.readId < doc.answered) return false;
    if (doc.model.getAlternativeVersionId() !== expect.versionId) return false;
    doc.answered = expect.readId;
    // Reload from Disk reads the file itself rather than through reconcile(), so this
    // may be the first time what it found is recorded at all.
    this.observe(doc, text);
    doc.model.setValue(text);
    doc.savedVersionId = doc.model.getAlternativeVersionId();
    doc.diskText = text;
    doc.conflict = null;
    // Whatever the document was holding is gone, so an authorisation to write a revision
    // captured before this one is no longer an authorisation to write anything.
    doc.restored += 1;
    // What the file holds is now known from having just read it, so any older read
    // still in flight is answering a question this one has settled.
    doc.baselineId += 1;
    return true;
  }

  // Records `snap` as written to disk, and reports whether it still applies.
  //
  // False means the write landed on a document that is no longer here: it was
  // closed with the workspace, or re-created under this key on a different model
  // (a rename re-keys onto a new one). Either way the document now under `key`,
  // if any, has not been written by this save and must not be marked as if it had.
  //
  // Deliberately not scoped to the baseline the save was captured against, unlike a
  // read: this write HAPPENED, and the file holds its text whatever else has been
  // established meanwhile. It is the newest word on the subject rather than an
  // older one, so it supersedes the reads in flight rather than being refused by
  // them.
  completeSave(snap: SaveSnapshot<M>): boolean {
    const doc = this.docs.get(snap.key);
    if (doc === undefined || doc.model !== snap.model) return false;
    // The CAPTURED revision, not the model's current one. An edit made while the
    // write was in flight is not on disk, so it leaves the document dirty and the
    // next save writes it out.
    doc.savedVersionId = snap.versionId;
    // What is on disk is now known exactly, whatever was there before. A watcher
    // notification for this very write therefore reconciles to `none` rather than
    // to a conflict, and a conflict the user resolved by overwriting is over.
    doc.diskText = snap.text;
    doc.conflict = null;
    // What the file was last seen to hold moves with it, or the version this write
    // replaced would go on standing as its contents and the next read would be counted
    // as news it is not. The count itself deliberately does not move: it exists to say
    // that somebody ELSE has been here since a write was authorised, and a write this
    // window performed itself is not that. Advancing it would have Quipu's own save
    // revoke the permission given for the mutation queued behind it.
    doc.observed = snap.text;
    // And a read issued before this write knows nothing about it. Its answer
    // describes the file as it was BEFORE the save, so applying it would reload the
    // document with the text this save replaced, or restore a `missing` conflict
    // this save has just put a file back for.
    doc.baselineId += 1;
    return true;
  }
}
