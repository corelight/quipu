// `edcore.main` ships no type declarations. It re-exports everything from
// `editor.api` (plus it registers the editor feature contributions as a side
// effect). Declaring it with the same types lets us import the namespace from
// it — a genuine usage the bundler can't tree-shake, so the contributions load.
declare module "monaco-editor/esm/vs/editor/edcore.main" {
  export * from "monaco-editor/esm/vs/editor/editor.api";
}
