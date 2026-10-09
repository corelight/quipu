import * as monaco from "../monaco";
// The "/browser" entry installs the Runtime Abstraction Layer that
// vscode-jsonrpc needs to schedule message handling. The bare "vscode-jsonrpc"
// entry installs no RAL, causing a "No runtime abstraction layer installed"
// throw inside the message handler — which silently breaks request correlation.
import {
  createMessageConnection,
  type MessageConnection,
} from "vscode-jsonrpc/browser";
import { createTauriTransport } from "./transport";
import { LANGUAGE_ID } from "../editor";
import { redactedException, trace } from "../trace";

// A deliberately small LSP client: it owns the initialize handshake, multi-
// document sync, and maps a focused set of LSP features onto Monaco's native
// provider APIs. No monaco-languageclient / vscode-api shim involved.
//
// Documents are keyed by their Monaco URI string; providers and diagnostics
// route per-URI so multiple open rule files each get their own state.

// LSP SemanticTokenTypes legend advertised by yara-x-ls (server.rs):
const TOKEN_TYPES = [
  "keyword", "string", "class", "variable", "number", "operator",
  "function", "regexp", "comment", "parameter", "macro",
];
const TOKEN_MODIFIERS = ["definition", "declaration"];

// Above this document size (bytes) we skip LSP semantic tokens (Monarch
// grammar still highlights). ~2MB is comfortably past normal rule files but
// well below the multi-MB aggregated feeds that cause lockups.
const SEMANTIC_TOKENS_MAX_BYTES = 2_000_000;

interface Position {
  line: number;
  character: number;
}
interface Range {
  start: Position;
  end: Position;
}

export class YaraLspClient {
  private conn!: MessageConnection;
  private ready = false;
  // Per-document monotonically increasing version, keyed by URI string.
  private versions = new Map<string, number>();

  async start(): Promise<void> {
    trace.event("lsp_start", {});
    try {
      // Await transport creation so the lsp_recv listener is attached before we
      // send initialize (see transport.ts).
      const { reader, writer } = await createTauriTransport();
      trace.event("lsp_transport_ready", {});
      this.conn = createMessageConnection(reader, writer);
      this.conn.listen();

      await this.conn.sendRequest("initialize", {
        processId: null,
        clientInfo: { name: "quipu" },
        rootUri: null,
        capabilities: {
          textDocument: {
            synchronization: { dynamicRegistration: false },
            // No `diagnostic` capability advertised -> server uses the PUSH model
            // (publishDiagnostics notifications), which we handle below.
            hover: { contentFormat: ["markdown", "plaintext"] },
            completion: { completionItem: { snippetSupport: false } },
            semanticTokens: {
              requests: { full: true, range: false },
              tokenTypes: TOKEN_TYPES,
              tokenModifiers: TOKEN_MODIFIERS,
              formats: ["relative"],
            },
          },
        },
      });
      this.conn.sendNotification("initialized", {});

      this.conn.onNotification("textDocument/publishDiagnostics", (params: any) =>
        this.applyDiagnostics(params),
      );

      this.registerProviders();
      this.ready = true;
      trace.event("lsp_ready", {});
    } catch (error) {
      trace.event("lsp_start_failed", redactedException(error));
      throw error;
    }
  }

  // Registers the document with the server (didOpen). Safe to call only after
  // start() resolves; the Workspace awaits start() before opening documents.
  openDocument(model: monaco.editor.ITextModel) {
    if (!this.ready) return;
    const uri = model.uri.toString();
    const document = trace.documentId(uri);
    this.versions.set(uri, 1);
    this.conn.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: LANGUAGE_ID,
        version: 1,
        text: model.getValue(),
      },
    });
    trace.event("lsp_document_opened", { document, characterCount: model.getValueLength() });
  }

  // Pushes a FULL-text change for an already-open document.
  changeDocument(model: monaco.editor.ITextModel) {
    if (!this.ready) return;
    const uri = model.uri.toString();
    const document = trace.documentId(uri);
    const version = (this.versions.get(uri) ?? 1) + 1;
    this.versions.set(uri, version);
    this.conn.sendNotification("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text: model.getValue() }],
    });
    trace.event("lsp_document_changed", {
      document,
      version,
      characterCount: model.getValueLength(),
    });
  }

  // Tells the server the document is gone (used when a rename forces the model
  // to be re-created under a new URI). Also drops any markers the server had
  // published against the old URI.
  closeDocument(model: monaco.editor.ITextModel) {
    if (!this.ready) return;
    const uri = model.uri.toString();
    const document = trace.forgetDocument(uri);
    this.versions.delete(uri);
    this.conn.sendNotification("textDocument/didClose", {
      textDocument: { uri },
    });
    trace.event("lsp_document_closed", { document });
  }

  private registerProviders() {
    monaco.languages.registerHoverProvider(LANGUAGE_ID, {
      provideHover: async (model, position) => {
        const res: any = await this.conn.sendRequest("textDocument/hover", {
          textDocument: { uri: model.uri.toString() },
          position: toLspPosition(position),
        });
        if (!res?.contents) return null;
        const value =
          typeof res.contents === "string"
            ? res.contents
            : res.contents.value ?? "";
        return { contents: [{ value }] };
      },
    });

    monaco.languages.registerCompletionItemProvider(LANGUAGE_ID, {
      triggerCharacters: [".", "!", "$", "@", "#"],
      provideCompletionItems: async (model, position) => {
        const res: any = await this.conn.sendRequest("textDocument/completion", {
          textDocument: { uri: model.uri.toString() },
          position: toLspPosition(position),
        });
        const items = Array.isArray(res) ? res : res?.items ?? [];
        const word = model.getWordUntilPosition(position);
        const range = new monaco.Range(
          position.lineNumber,
          word.startColumn,
          position.lineNumber,
          word.endColumn
        );
        return {
          suggestions: items.map((it: any) => ({
            label: it.label,
            kind: monaco.languages.CompletionItemKind.Property,
            insertText: it.insertText ?? it.label,
            detail: it.detail,
            documentation:
              typeof it.documentation === "string"
                ? it.documentation
                : it.documentation?.value,
            range,
          })),
        };
      },
    });

    monaco.languages.registerDocumentSemanticTokensProvider(LANGUAGE_ID, {
      getLegend: () => ({
        tokenTypes: TOKEN_TYPES,
        tokenModifiers: TOKEN_MODIFIERS,
      }),
      provideDocumentSemanticTokens: async (model) => {
        // Full-document semantic tokens are recomputed on every edit and the
        // payload scales with file size. On very large rule files (e.g. 20MB
        // aggregated feeds) this dominates latency; skip it and let the Monarch
        // grammar carry highlighting. Diagnostics + completion still work.
        if (model.getValueLength() > SEMANTIC_TOKENS_MAX_BYTES) return null;
        const res: any = await this.conn.sendRequest(
          "textDocument/semanticTokens/full",
          { textDocument: { uri: model.uri.toString() } }
        );
        if (!res?.data) return null;
        return { data: new Uint32Array(res.data), resultId: res.resultId };
      },
      releaseDocumentSemanticTokens: () => {},
    });
  }

  // PUSH-model diagnostics -> Monaco markers, routed to the model matching the
  // notification's URI. LSP positions are 0-based (UTF-16); Monaco is 1-based.
  private applyDiagnostics(params: { uri: string; diagnostics: any[] }) {
    const document = trace.documentId(params.uri);
    const model = monaco.editor.getModel(monaco.Uri.parse(params.uri));
    if (!model) {
      trace.event("lsp_diagnostics_received", {
        document,
        receivedCount: params.diagnostics.length,
        appliedCount: 0,
        modelPresent: false,
      });
      return;
    }
    // yara-x-ls emits some warnings twice in a single publish (observed:
    // `duplicate_import` warnings are doubled — total = base + one extra copy
    // of each duplicate_import; a one-shot yara-x compile does not reproduce
    // it, so it's stateful in the LS). Collapse byte-identical diagnostics so
    // the same problem doesn't show twice in a tooltip.
    const seen = new Set<string>();
    const markers: monaco.editor.IMarkerData[] = [];
    for (const d of params.diagnostics) {
      const key = `${d.code}|${d.severity}|${d.message}|${d.range.start.line}:${d.range.start.character}-${d.range.end.line}:${d.range.end.character}`;
      if (seen.has(key)) continue;
      seen.add(key);
      markers.push({
        severity: lspSeverityToMonaco(d.severity),
        message: d.message,
        startLineNumber: d.range.start.line + 1,
        startColumn: d.range.start.character + 1,
        endLineNumber: d.range.end.line + 1,
        endColumn: d.range.end.character + 1,
        code: d.code != null ? String(d.code) : undefined,
      });
    }
    monaco.editor.setModelMarkers(model, "yara-lsp", markers);
    trace.event("lsp_diagnostics_received", {
      document,
      receivedCount: params.diagnostics.length,
      appliedCount: markers.length,
      modelPresent: true,
    });
  }
}

function toLspPosition(p: monaco.IPosition): Position {
  return { line: p.lineNumber - 1, character: p.column - 1 };
}

function lspSeverityToMonaco(sev: number | undefined): monaco.MarkerSeverity {
  switch (sev) {
    case 1:
      return monaco.MarkerSeverity.Error;
    case 2:
      return monaco.MarkerSeverity.Warning;
    case 3:
      return monaco.MarkerSeverity.Info;
    default:
      return monaco.MarkerSeverity.Hint;
  }
}

export type { Range };
