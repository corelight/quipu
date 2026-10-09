// Monaco 0.56+ separates the typed editor API from feature registration.
// Both are needed: providers alone do not install the controllers that query
// them for hover, completion and semantic highlighting. Keep all editor features
// (as edcore.main did), without loading the bundled language modes or LSP client.
import "monaco-editor/features/register.all";
// In 0.57 register.all only includes viewport/range semantic tokens. Our LSP
// supplies full-document tokens, whose controller must be registered separately.
import "monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens";
import editorWorker from "monaco-editor/editor/editor.worker?worker";

// Only the base editor worker is needed; YARA language services run in Rust.
self.MonacoEnvironment = {
  getWorker() {
    return new editorWorker();
  },
};

export * from "monaco-editor/editor";
