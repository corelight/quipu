import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  AbstractMessageReader,
  AbstractMessageWriter,
  type DataCallback,
  type Message,
  type MessageReader,
  type MessageWriter,
} from "vscode-jsonrpc";

// Bridges vscode-jsonrpc to the Tauri IPC channel established in src-tauri/lsp.rs:
//   - writer: invoke("lsp_send", { msg }) with the serialized JSON-RPC message
//   - reader: listen("lsp_recv") events carry server -> client JSON-RPC strings
//
// The Rust side handles Content-Length framing, so here we exchange raw
// JSON-RPC message objects (parse/stringify only).

class TauriMessageReader extends AbstractMessageReader implements MessageReader {
  private callback: DataCallback | undefined;
  private buffered: Message[] = [];

  // `unlisten` is provided once the native Tauri listener is attached. We accept
  // it via the constructor so transport creation can AWAIT attachment — Tauri
  // does not buffer events emitted before a listener exists, so sending any LSP
  // message before this point would race and drop the server's reply.
  constructor(private unlisten: UnlistenFn) {
    super();
  }

  // Called by createTauriTransport from inside the event handler.
  push(payload: string) {
    let msg: Message;
    try {
      msg = JSON.parse(payload) as Message;
    } catch (e) {
      this.fireError(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    if (this.callback) this.callback(msg);
    else this.buffered.push(msg);
  }

  listen(callback: DataCallback): { dispose(): void } {
    this.callback = callback;
    // Flush anything that arrived before the client started listening.
    for (const msg of this.buffered) callback(msg);
    this.buffered = [];
    return {
      dispose: () => {
        this.callback = undefined;
        this.unlisten();
      },
    };
  }
}

class TauriMessageWriter extends AbstractMessageWriter implements MessageWriter {
  async write(msg: Message): Promise<void> {
    try {
      await invoke("lsp_send", { msg: JSON.stringify(msg) });
    } catch (e) {
      this.fireError(
        e instanceof Error ? e : new Error(String(e)),
        msg,
        undefined
      );
    }
  }

  end(): void {
    // Nothing to flush — invoke() resolves per message.
  }
}

// Async so the native `lsp_recv` listener is fully attached before the caller
// sends anything to the server (avoids the dropped-reply race described above).
export async function createTauriTransport(): Promise<{
  reader: MessageReader;
  writer: MessageWriter;
}> {
  let reader!: TauriMessageReader;
  const unlisten = await listen<string>("lsp_recv", (event) => {
    reader.push(event.payload);
  });
  reader = new TauriMessageReader(unlisten);
  return { reader, writer: new TauriMessageWriter() };
}
