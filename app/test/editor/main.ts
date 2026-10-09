// Real Workspace, LSP adapter, Monaco and worker. Only the native IPC/server
// boundary is replaced, with deterministic responses to actual LSP requests.
import { mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import * as monaco from "../../src/monaco";
import { Workspace } from "../../src/editor";
import { YaraLspClient } from "../../src/lsp/client";

const requests: Array<{ method: string; params: any }> = [];
mockIPC(async (cmd, args) => {
  if (cmd !== "lsp_send") throw new Error(`Unexpected IPC: ${cmd}`);
  const msg = JSON.parse(args!.msg as string);
  requests.push(msg);
  if (msg.id === undefined) return;
  let result: unknown;
  switch (msg.method) {
    case "initialize":
      result = { capabilities: {} };
      break;
    case "textDocument/hover":
      result = { contents: { kind: "markdown", value: "**YARA hover documentation**" } };
      break;
    case "textDocument/completion":
      result = [{ label: "filesize", detail: "YARA fixture completion" }];
      break;
    case "textDocument/semanticTokens/full":
      result = { data: [0, 0, 4, 0, 0] };
      break;
    default:
      throw new Error(`Unexpected LSP request: ${msg.method}`);
  }
  await emit("lsp_recv", JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
}, { shouldMockEvents: true });

async function start() {
  const lsp = new YaraLspClient();
  await lsp.start();
  const workspace = new Workspace(document.querySelector("#editor")!, lsp);
  workspace.openFile("/workspace/a.yar", "rule sample {\n    condition:\n        true\n}\n");
  const editor = monaco.editor.getEditors()[0];
  const diff = monaco.editor.createDiffEditor(document.querySelector("#diff")!);
  diff.setModel({
    original: monaco.editor.createModel("before\n", "plaintext"),
    modified: monaco.editor.createModel("after\n", "plaintext"),
  });
  Object.assign(window, {
    fixture: {
      monaco, workspace, editor, diff, requests,
      diagnostics: () => emit("lsp_recv", JSON.stringify({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: {
          uri: workspace.activeModel()!.uri.toString(),
          diagnostics: [{
            range: { start: { line: 2, character: 8 }, end: { line: 2, character: 12 } },
            severity: 1,
            message: "Fixture diagnostic",
          }],
        },
      })),
    },
  });
}

start().catch((error) => { setTimeout(() => { throw error; }); });
