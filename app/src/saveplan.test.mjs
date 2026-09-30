// Tests for the save-and-reanalyse fixpoint (saveplan.ts).
//
// Run with `npm test`. Node's built-in test runner and type stripping are used
// deliberately: this needs no dependency, no bundler and no browser, because the
// unit under test has none - the filesystem and the project analysis are behind
// SaveEnvironment, so a fake graph can be reshaped by a save exactly as the real
// one is.
//
// Written as .mjs rather than .ts so `npm run build`'s tsc pass, which is
// configured for the application's browser sources, is not asked to type-check a
// Node test.

import { test } from "node:test";
import assert from "node:assert/strict";

import { saveDirtyMembers } from "./saveplan.ts";

// A project whose include graph is whatever the files written so far say it is.
//
// `graph` maps a path to the paths it pulls in once *written*. That is the whole
// point: an include only becomes discoverable when the file declaring it is on
// disk, which is why deciding membership once cannot be correct.
function fakeProject({ explorer = [], graph = {}, superseded = () => false } = {}) {
  const written = [];
  const analyses = [];
  const env = {
    async members() {
      const reached = new Set(explorer);
      // Fixpoint over the *written* files, so a chain of new includes is found
      // the way a real re-analysis would find it.
      for (;;) {
        const before = reached.size;
        for (const path of [...reached]) {
          if (!written.includes(path)) continue;
          for (const pulled of graph[path] ?? []) reached.add(pulled);
        }
        if (reached.size === before) break;
      }
      analyses.push(new Set(reached));
      return reached;
    },
    // Written, and reported as written: the plan's own outcome type, because a write
    // that was skipped or refused must not be indistinguishable from one that landed.
    async save(key) {
      written.push(key);
      return { kind: "written" };
    },
    superseded,
  };
  return { env, written, analyses };
}

test("a dirty include's dirty dependency is saved too, from the graph the save created", async () => {
  // The scenario the fixpoint exists for. On disk, main.yar includes nothing.
  // The open, dirty main.yar adds `include "dep.yar"`; dep.yar is open and dirty
  // as well. Analysing membership before saving main.yar cannot see dep.yar, so
  // a single pass would leave it unwritten and the compile would read its stale
  // disk contents.
  const project = fakeProject({
    explorer: ["/p/main.yar"],
    graph: { "/p/main.yar": ["/p/dep.yar"] },
  });

  const plan = await saveDirtyMembers(["/p/main.yar", "/p/dep.yar"], new Set(["/p/main.yar"]), project.env);

  assert.deepEqual(plan, { written: ["/p/main.yar", "/p/dep.yar"], refused: null });
  assert.deepEqual(project.written, ["/p/main.yar", "/p/dep.yar"]);
  // dep.yar was written strictly after the analysis that discovered it, which is
  // what proves the second wave was driven by the new graph and not by luck.
  assert.ok(project.analyses.some((seen) => seen.has("/p/dep.yar")));
});

test("a chain of newly introduced includes is followed to a fixpoint", async () => {
  // main -> mid -> leaf, each include added by an unsaved edit. One extra wave
  // is not enough; the loop has to keep going while it is still making progress.
  const project = fakeProject({
    explorer: ["/p/main.yar"],
    graph: { "/p/main.yar": ["/p/mid.yar"], "/p/mid.yar": ["/p/leaf.yar"] },
  });

  const plan = await saveDirtyMembers(
    ["/p/main.yar", "/p/mid.yar", "/p/leaf.yar"],
    new Set(["/p/main.yar"]),
    project.env,
  );

  assert.deepEqual(plan.written, ["/p/main.yar", "/p/mid.yar", "/p/leaf.yar"]);
});

test("a document no wave ever brings into the project is not written", async () => {
  // A file left open from a folder the user has switched away from. It is dirty,
  // but it is not this compile's business, and the loop must stop rather than
  // spin waiting for a graph that will never mention it.
  const project = fakeProject({ explorer: ["/p/main.yar"] });

  const plan = await saveDirtyMembers(["/p/main.yar", "/other/stray.yar"], new Set(["/p/main.yar"]), project.env);

  assert.deepEqual(plan, { written: ["/p/main.yar"], refused: null });
});

test("every document is written at most once", async () => {
  // Two entrypoints both including the same dirty helper: it becomes a member
  // twice over, and must still be written once.
  const project = fakeProject({
    explorer: ["/p/a.yar", "/p/b.yar"],
    graph: { "/p/a.yar": ["/p/shared.yar"], "/p/b.yar": ["/p/shared.yar"] },
  });

  const plan = await saveDirtyMembers(
    ["/p/a.yar", "/p/b.yar", "/p/shared.yar"],
    new Set(["/p/a.yar", "/p/b.yar"]),
    project.env,
  );

  assert.deepEqual(plan.written, ["/p/a.yar", "/p/b.yar", "/p/shared.yar"]);
  assert.equal(new Set(plan.written).size, plan.written.length);
});

test("nothing is analysed when the explorer list already accounts for every dirty document", async () => {
  // The common case: no membership question to answer, so the compile pays for no
  // analysis at all.
  const project = fakeProject({ explorer: ["/p/a.yar"] });

  const plan = await saveDirtyMembers(["/p/a.yar"], new Set(["/p/a.yar"]), project.env);

  assert.deepEqual(plan.written, ["/p/a.yar"]);
  assert.equal(project.analyses.length, 0);
});

test("no dirty documents means no work and no analysis", async () => {
  const project = fakeProject({ explorer: ["/p/a.yar"] });

  assert.deepEqual(await saveDirtyMembers([], new Set(["/p/a.yar"]), project.env), {
    written: [],
    refused: null,
  });
  assert.equal(project.analyses.length, 0);
});

test("being superseded stops the remaining writes", async () => {
  // The user opens another folder mid-save. Whatever has been written stays
  // written - it was the user's own editor contents - but nothing further is
  // written on behalf of a project that is no longer open.
  let superseded = false;
  const project = fakeProject({
    explorer: ["/p/a.yar", "/p/b.yar"],
    superseded: () => superseded,
  });
  const save = project.env.save;
  project.env.save = async (key) => {
    const outcome = await save(key);
    superseded = true; // the folder changes while the first write is in flight
    return outcome;
  };

  const plan = await saveDirtyMembers(["/p/a.yar", "/p/b.yar"], new Set(["/p/a.yar", "/p/b.yar"]), project.env);

  // Stopped, not refused: an operation the user has moved past is cancelled quietly,
  // and there is nothing for the caller to report about it.
  assert.deepEqual(plan, { written: ["/p/a.yar"], refused: null });
});

test("a write that found itself superseded stops the plan quietly", async () => {
  // The other half of the same story. Deciding whether a document may be written takes
  // its own awaits - reading the file, asking the user - and being superseded during
  // them is something only the callback can see. It says so rather than writing, and
  // the plan ends there: b.yar is not the last of the wave, so carrying on would write
  // c.yar for an operation nobody is waiting for.
  const members = ["/p/a.yar", "/p/b.yar", "/p/c.yar"];
  const project = fakeProject({ explorer: members });
  const save = project.env.save;
  project.env.save = async (key) => (key === "/p/b.yar" ? { kind: "superseded" } : save(key));

  const plan = await saveDirtyMembers(members, new Set(members), project.env);

  // Nothing to report: unlike a refusal, an abandoned operation is not news.
  assert.deepEqual(plan, { written: ["/p/a.yar"], refused: null });
  assert.deepEqual(project.written, ["/p/a.yar"], "and nothing after it was written");
  assert.equal(project.analyses.length, 0, "nor was a further wave decided");
});

test("an analysis that fails outright is not treated as an empty project", async () => {
  // A rejected analyze_project is an infrastructure failure - a panicking backend
  // or IPC itself - because a user's broken configuration comes back as a
  // successful structured result. Answering "no members" to it would skip dirty
  // dependencies and compile their stale disk contents, so it propagates and the
  // compile takes its normal failure path.
  const project = fakeProject({ explorer: ["/p/main.yar"] });
  project.env.members = async () => {
    throw new Error("analysis task panicked");
  };

  await assert.rejects(
    () => saveDirtyMembers(["/p/deep/main.yar"], new Set(["/p/main.yar"]), project.env),
    /analysis task panicked/,
  );
  assert.deepEqual(project.written, [], "nothing is written on the strength of a guess");
});

test("an analysis that fails part-way through a fixpoint still propagates", async () => {
  // The first wave succeeded and wrote a file; the re-analysis that would decide
  // the second wave then failed. Stopping quietly here would be the same bug one
  // wave later - the dependency the new include introduced stays unwritten.
  const project = fakeProject({
    explorer: ["/p/main.yar"],
    graph: { "/p/main.yar": ["/p/dep.yar"] },
  });
  const members = project.env.members;
  let calls = 0;
  project.env.members = async () => {
    calls += 1;
    if (calls > 1) throw new Error("analysis task panicked");
    return members();
  };

  await assert.rejects(
    () => saveDirtyMembers(["/p/main.yar", "/p/dep.yar"], new Set(["/p/main.yar"]), project.env),
    /analysis task panicked/,
  );
  assert.deepEqual(project.written, ["/p/main.yar"]);
});

test("being superseded stops it before it re-analyses", async () => {
  const project = fakeProject({ explorer: ["/p/a.yar"], superseded: () => true });

  // A dirty document outside the explorer list would normally trigger an
  // analysis; superseded means not even that runs.
  const plan = await saveDirtyMembers(["/p/deep/a.yar"], new Set(["/p/a.yar"]), project.env);

  assert.deepEqual(plan, { written: [], refused: null });
  assert.equal(project.analyses.length, 0);
});

// ---- A write the plan was not allowed to make ----
//
// A save can be declined without anything failing: the file changed on disk after the
// user was asked about it, or the document has been closed or renamed away. The plan
// must not absorb that. Reporting it as written would have the caller compile whatever
// is on disk and call the result a compilation of the editor's text.

test("a refused write ends the plan, and says why", async () => {
  const project = fakeProject({
    explorer: ["/p/a.yar", "/p/b.yar"],
    graph: { "/p/a.yar": ["/p/dep.yar"] },
  });
  const save = project.env.save;
  project.env.save = async (key) =>
    key === "/p/b.yar" ? { kind: "refused", why: "b.yar changed on disk" } : save(key);

  const plan = await saveDirtyMembers(
    ["/p/a.yar", "/p/b.yar"],
    new Set(["/p/a.yar", "/p/b.yar"]),
    project.env,
  );

  assert.deepEqual(plan, { written: ["/p/a.yar"], refused: "b.yar changed on disk" });
  assert.deepEqual(project.written, ["/p/a.yar"], "and nothing after it was written");
  // Not even the analysis that would have decided the next wave: a plan that is going
  // to be reported as incomplete has nothing to find out.
  assert.equal(project.analyses.length, 0);
});

test("a document that needed no writing is neither a write nor a refusal", async () => {
  // The user's own Save, queued ahead of this plan, has already put b.yar on disk. The
  // plan has nothing to do for it and no reason to stop: the disk holds its text.
  const project = fakeProject({
    explorer: ["/p/a.yar", "/p/b.yar"],
  });
  const save = project.env.save;
  project.env.save = async (key) => (key === "/p/b.yar" ? { kind: "unchanged" } : save(key));

  const plan = await saveDirtyMembers(
    ["/p/a.yar", "/p/b.yar"],
    new Set(["/p/a.yar", "/p/b.yar"]),
    project.env,
  );

  assert.deepEqual(plan, { written: ["/p/a.yar"], refused: null });
  // Accounted for all the same, so the loop ends rather than asking a fresh analysis
  // about a document it has already dealt with.
  assert.equal(project.analyses.length, 0);
});
