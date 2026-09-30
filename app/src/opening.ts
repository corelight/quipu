// Ordering the requests to open a project by the gesture that made them.
//
// Both ways into a project begin with an await that the current project must
// survive: Open Folder puts up the native directory picker, and Open Example
// materialises the packaged template into an editable working copy. Neither may
// touch the session before it has an answer - a project is not abandoned for a
// picker the user might dismiss, or for a copy that might fail - so between the
// gesture and the switch there is a window in which the user can make another
// one.
//
// Nothing about the answers themselves orders them. A directory picker dismissed
// after an example finished copying still returns a path; a slow first copy of a
// large example still returns a root long after the folder the user asked for
// next has opened. Whichever request landed last would then win, and the project
// the user chose last would silently lose to whichever piece of I/O happened to
// be slower.
//
// So a request is counted when the gesture is made, and only the newest one may
// go on to open anything. An older request that lands afterwards is dropped
// entirely: it opens nothing, and its failure is not reported either, because the
// Problems pane and the chooser both belong to what the user is doing now rather
// than to what they have already replaced.
//
// This is deliberately its own generation, not the compilation operation token
// and not navigation's gesture count. A pending open is not an operation on the
// ruleset - it has not yet decided to abandon anything - and superseding one must
// not supersede a compile of the project still open, nor be superseded by the
// user clicking around in the editor. The session's counted selection cannot
// serve either: advancing it to reserve a request would abandon the current
// project before the request had earned it.
//
// No DOM, no IPC and no session: what a request is for is the caller's business,
// so the ordering can be tested on its own (see opening.test.mjs).

/** A request to open a project, as counted when the user asked for it. */
export interface OpenRequest {
  serial: number;
}

export class OpenRequests {
  private serial = 0;

  // Claims the right to open a project, superseding any request still pending.
  //
  // Synchronous, and called before the picker is shown or the copy is started,
  // which is what makes the ordering the user's rather than the disk's.
  begin(): OpenRequest {
    this.serial += 1;
    return { serial: this.serial };
  }

  // Observes the ordering without claiming anything: the returned request is
  // current until somebody else's gesture makes one.
  //
  // For a command that has to be ordered against the pending opens without
  // superseding them, which is Close Workspace with its confirmation now awaited.
  // Its question must not cancel a folder picker the user is still looking at - a
  // cancelled close changes nothing - and its answer must not arrive after a newer
  // open gesture and cancel that instead. Claiming a request would do the first;
  // claiming nothing at all would do the second. `begin()` is still what an open
  // makes, and the close cancels the pending ones only once its answer is in.
  mark(): OpenRequest {
    return { serial: this.serial };
  }

  // True while `req` is still the request whose answer may open a project.
  //
  // Re-check it after every await, including before reporting a failure. Only
  // ever true for one request at a time, and never true again once it is false:
  // the serial only increases, so nothing can make a superseded request current.
  isCurrent(req: OpenRequest): boolean {
    return req.serial === this.serial;
  }

  // Abandons every pending request without making one.
  //
  // Close Workspace calls this once its confirmation has been accepted: the user
  // has said what they want the window to be showing, and an open they started
  // before that decision must not arrive afterwards and re-fill the workspace
  // they have just emptied.
  cancel(): void {
    this.serial += 1;
  }
}
