//! Exercise the actual embedded server through Quipu's framing, without Tauri.
use super::*;
use serde_json::{Value, json};
use std::time::Duration;

struct Client {
    tx: mpsc::UnboundedSender<String>,
    reader: ReadHalf<DuplexStream>,
}

impl Client {
    fn send(&self, message: Value) {
        self.tx.send(message.to_string()).unwrap();
    }

    async fn receive(&mut self, matches: impl Fn(&Value) -> bool) -> Value {
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let len = read_content_length(&mut self.reader)
                    .await
                    .expect("LSP header");
                let mut body = vec![0; len];
                self.reader.read_exact(&mut body).await.unwrap();
                let message: Value = serde_json::from_slice(&body).unwrap();
                // The server asks for workspace settings after initialization.
                if message["method"] == "workspace/configuration" {
                    self.send(json!({"jsonrpc": "2.0", "id": message["id"], "result": [{}]}));
                }
                if matches(&message) {
                    return message;
                }
            }
        })
        .await
        .expect("embedded LSP response timed out")
    }

    async fn request(&mut self, id: u32, method: &str, params: Value) -> Value {
        self.send(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}));
        let reply = self.receive(|message| message["id"] == id).await;
        assert!(reply.get("error").is_none(), "{reply}");
        reply["result"].clone()
    }
}

#[tokio::test]
async fn embedded_server_provides_editor_features_and_live_diagnostics() {
    let (server_end, client_end) = tokio::io::duplex(256 * 1024);
    let (sr, sw) = tokio::io::split(server_end);
    let server =
        tokio::spawn(async move { yara_x_ls::serve(sr.compat(), sw.compat_write()).await });
    let (reader, writer) = tokio::io::split(client_end);
    let (tx, rx) = mpsc::unbounded_channel();
    let writer = tokio::spawn(write_loop(writer, rx));
    let mut client = Client { tx, reader };

    // No pull-diagnostic capability: the frontend relies on pushed diagnostics.
    let initialized = client
        .request(
            1,
            "initialize",
            json!({
                "processId": null, "rootUri": null, "capabilities": {},
            }),
        )
        .await;
    assert_eq!(initialized["capabilities"]["hoverProvider"], true);
    client.send(json!({"jsonrpc": "2.0", "method": "initialized", "params": {}}));
    let uri = "inmemory://model/upgrade-smoke.yar";
    client.send(
        json!({"jsonrpc": "2.0", "method": "textDocument/didOpen", "params": {
            "textDocument": {"uri": uri, "languageId": "yara", "version": 1,
                "text": "rule sample {\n strings:\n  $a = \"needle\"\n condition:\n  $a\n}\n"}
        }}),
    );
    let diagnostic = client
        .receive(|m| m["method"] == "textDocument/publishDiagnostics")
        .await;
    assert_eq!(diagnostic["params"]["uri"], uri);
    assert_eq!(diagnostic["params"]["diagnostics"], json!([]));

    let position = json!({"textDocument": {"uri": uri}, "position": {"line": 4, "character": 3}});
    let hover = client
        .request(2, "textDocument/hover", position.clone())
        .await;
    assert!(hover["contents"].to_string().contains("needle"), "{hover}");
    let completion = client.request(3, "textDocument/completion", position).await;
    let items = completion
        .as_array()
        .or_else(|| completion["items"].as_array())
        .expect("completion items");
    assert!(
        items.iter().any(|item| item["label"] == "filesize"),
        "{completion}"
    );
    let tokens = client
        .request(
            4,
            "textDocument/semanticTokens/full",
            json!({"textDocument": {"uri": uri}}),
        )
        .await;
    assert!(
        !tokens["data"]
            .as_array()
            .expect("semantic tokens")
            .is_empty()
    );

    client.send(
        json!({"jsonrpc": "2.0", "method": "textDocument/didChange", "params": {
            "textDocument": {"uri": uri, "version": 2},
            "contentChanges": [{"text": "rule sample { condition: missing_identifier }"}]
        }}),
    );
    let diagnostic = client
        .receive(|m| m["method"] == "textDocument/publishDiagnostics")
        .await;
    assert_eq!(diagnostic["params"]["uri"], uri);
    assert!(
        diagnostic["params"]["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|d| d["severity"] == 1)
    );
    server.abort();
    writer.abort();
}
