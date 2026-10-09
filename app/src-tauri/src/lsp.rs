//! In-process LSP bridge.
//!
//! Embeds `yara-x-ls` (no child process, no stdio) and bridges its JSON-RPC
//! stream to the webview over Tauri IPC:
//!   - webview -> server: the `lsp_send` command pushes a JSON-RPC message,
//!     which we Content-Length frame and write to the server's input.
//!   - server -> webview: we read Content-Length framed messages from the
//!     server's output, strip the framing, and emit them as `lsp_recv` events.
//!
//! The server speaks LSP over an in-memory `tokio::io::duplex` pipe; framing
//! lives here so the frontend only ever handles raw JSON-RPC strings.

use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream, ReadHalf, WriteHalf};
use tokio::sync::mpsc;
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

#[cfg(test)]
mod tests;

/// Event channel name for server -> webview messages.
const EVENT_RECV: &str = "lsp_recv";

/// Managed state: the sender side of the webview -> server message channel.
pub struct LspHandle {
    to_server: mpsc::UnboundedSender<String>,
}

/// Webview -> server. The body is a complete JSON-RPC message (no framing).
#[tauri::command]
pub fn lsp_send(msg: String, state: State<'_, LspHandle>) {
    let _ = state.to_server.send(msg);
}

/// Starts the embedded server and its two bridge tasks. Returns the handle to
/// be stored as Tauri managed state.
pub fn start(app: AppHandle) -> LspHandle {
    // In-memory transport between the bridge (client_end) and server (server_end).
    let (server_end, client_end) = tokio::io::duplex(256 * 1024);

    // Embed the language server. tokio<->futures via split halves + compat
    // (the pattern proven in crates/ls-probe).
    let (sr, sw) = tokio::io::split(server_end);
    tauri::async_runtime::spawn(async move {
        if let Err(e) = yara_x_ls::serve(sr.compat(), sw.compat_write()).await {
            eprintln!("yara-x-ls server loop ended: {e}");
        }
    });

    let (client_read, client_write) = tokio::io::split(client_end);
    let (tx, rx) = mpsc::unbounded_channel::<String>();

    tauri::async_runtime::spawn(write_loop(client_write, rx));
    tauri::async_runtime::spawn(read_loop(client_read, app));

    LspHandle { to_server: tx }
}

/// Frames each outgoing JSON-RPC message and writes it to the server's input.
async fn write_loop(mut writer: WriteHalf<DuplexStream>, mut rx: mpsc::UnboundedReceiver<String>) {
    while let Some(body) = rx.recv().await {
        let framed = format!("Content-Length: {}\r\n\r\n{}", body.len(), body);
        if writer.write_all(framed.as_bytes()).await.is_err() {
            break;
        }
        if writer.flush().await.is_err() {
            break;
        }
    }
}

/// Reads Content-Length framed messages from the server and emits the bodies.
async fn read_loop(mut reader: ReadHalf<DuplexStream>, app: AppHandle) {
    loop {
        let len = match read_content_length(&mut reader).await {
            Some(len) => len,
            None => break, // stream closed or malformed header
        };
        let mut body = vec![0u8; len];
        if reader.read_exact(&mut body).await.is_err() {
            break;
        }
        match String::from_utf8(body) {
            Ok(text) => {
                let _ = app.emit(EVENT_RECV, text);
            }
            Err(_) => break,
        }
    }
}

/// Reads the LSP header block and returns the Content-Length value.
/// Returns None on EOF or a malformed/absent Content-Length.
async fn read_content_length(reader: &mut ReadHalf<DuplexStream>) -> Option<usize> {
    let mut headers = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        if reader.read_exact(&mut byte).await.is_err() {
            return None;
        }
        headers.push(byte[0]);
        if headers.ends_with(b"\r\n\r\n") {
            break;
        }
        // Guard against a runaway header with no terminator.
        if headers.len() > 8192 {
            return None;
        }
    }
    let headers = String::from_utf8(headers).ok()?;
    headers
        .lines()
        .find_map(|l| l.strip_prefix("Content-Length: "))
        .and_then(|v| v.trim().parse::<usize>().ok())
}
