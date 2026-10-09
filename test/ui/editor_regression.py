#!/usr/bin/env python3
"""Exercise Quipu's real editor/LSP adapter in a production Vite bundle.

Requires Python Playwright and Chromium. The fixture replaces only native IPC;
native WebKitGTK and the actual YARA server are covered by desktop smoke tests.
"""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import time

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
CSP = json.loads((ROOT / "app/src-tauri/tauri.conf.json").read_text())["app"]["security"]["csp"]


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Content-Security-Policy", CSP)
        super().end_headers()

    def log_message(self, *_args):
        pass


def wait_for(page, expression):
    # Poll through the debugger: Playwright's in-page polling uses eval, which
    # the real application CSP intentionally forbids.
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if page.evaluate(expression):
            return
        page.wait_for_timeout(50)
    raise AssertionError(f"Timed out: {expression}")


def exercise(page):
    wait_for(page, "window.fixture !== undefined")
    expect(page.locator("#editor .view-lines")).to_contain_text("rule sample")
    assert page.evaluate("fixture.monaco.languages.getLanguages().map(l => l.id).sort()") == ["plaintext", "yara"]
    # Registration is insufficient: the editor must actually call our provider.
    wait_for(page, "fixture.requests.some(r => r.method === 'textDocument/semanticTokens/full')")
    assert "keyword" in page.evaluate("fixture.monaco.editor.tokenize('rule sample {}', 'yara')[0][0].type")

    page.evaluate("fixture.editor.setPosition({lineNumber: 5, column: 1}); fixture.editor.focus()")
    page.keyboard.press("Control+Space")
    expect(page.locator(".suggest-widget.visible")).to_contain_text("filesize")
    page.keyboard.press("Escape")
    page.evaluate("fixture.editor.setPosition({lineNumber: 3, column: 10}); fixture.editor.trigger('test', 'editor.action.showHover', {})")
    expect(page.locator(".monaco-hover").filter(has_text="YARA hover documentation")).to_be_visible()
    page.keyboard.press("Escape")

    # Real typing, undo and find, rather than a fake text model.
    page.evaluate("fixture.editor.setPosition({lineNumber: 5, column: 1}); fixture.editor.focus()")
    page.keyboard.type("edited")
    assert page.evaluate("fixture.workspace.needsSaving('/workspace/a.yar')")
    wait_for(page, "fixture.requests.some(r => r.method === 'textDocument/didChange' && r.params.contentChanges[0].text.includes('edited'))")
    page.keyboard.press("Control+z")
    assert not page.evaluate("fixture.workspace.needsSaving('/workspace/a.yar')"), page.evaluate("fixture.workspace.activeModel().getValue()")
    page.keyboard.press("Control+f")
    page.keyboard.type("sample")
    expect(page.locator(".find-widget")).to_contain_text("1 of 1")
    page.keyboard.press("Escape")

    page.evaluate("fixture.diagnostics()")
    wait_for(page, "fixture.monaco.editor.getModelMarkers({owner: 'yara-lsp'}).some(m => m.message === 'Fixture diagnostic')")
    expect(page.locator("#editor .squiggly-error").first).to_be_visible()

    page.evaluate("""() => {
        const {workspace: ws, editor} = fixture;
        editor.setPosition({lineNumber: 5, column: 1});
        editor.trigger('test', 'type', {text: '// retained'});
        ws.openFile('/workspace/b.yar', 'rule other { condition: false }');
        ws.activate('/workspace/a.yar');
    }""")
    assert page.evaluate("fixture.workspace.activeModel().getValue().endsWith('// retained')")
    assert page.evaluate("fixture.workspace.needsSaving('/workspace/a.yar')")
    page.evaluate("fixture.workspace.renameDoc('/workspace/a.yar', '/workspace/renamed.yar')")
    assert page.evaluate("fixture.workspace.activeKey()") == "/workspace/renamed.yar"
    assert page.evaluate("fixture.workspace.needsSaving('/workspace/renamed.yar')")
    page.evaluate("fixture.workspace.openScratch('scratch'); fixture.workspace.closeFiles()")
    assert page.evaluate("fixture.workspace.openKeys()") == [""]
    expect(page.locator("#editor .view-lines")).to_contain_text("scratch")

    # Diff computation makes a round trip to the base editor worker. Fail on
    # worker fallback warnings too, so computing on the main thread cannot pass.
    wait_for(page, "fixture.diff.getLineChanges()?.length === 1")
    assert page.workers, "Editor worker never started"


def main():
    with tempfile.TemporaryDirectory(prefix="quipu-editor-test-") as tmp:
        subprocess.run([
            "node", "--input-type=module", "-e",
            "import {build} from 'vite'; await build({configFile: false, "
            "root: 'test/editor', build: {target: 'esnext', "
            "outDir: process.argv[1], emptyOutDir: true, chunkSizeWarningLimit: 5000}})",
            tmp,
        ], cwd=ROOT / "app", check=True)
        server = ThreadingHTTPServer(("127.0.0.1", 0), partial(Handler, directory=tmp))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch()
                page = browser.new_page(viewport={"width": 1100, "height": 800})
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.on("console", lambda msg: errors.append(msg.text)
                        if msg.type in ("error", "warning") else None)
                page.goto(f"http://127.0.0.1:{server.server_port}/")
                try:
                    exercise(page)
                    assert not errors, errors
                except Exception:
                    page.screenshot(path="/tmp/quipu-editor-regression-failure.png")
                    print("Browser errors:", errors)
                    raise
                finally:
                    browser.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
    print("PASS: editor rendering, YARA tokens, completion, hover, diagnostics, "
          "typing/undo/find, document lifecycle and worker under app CSP")


if __name__ == "__main__":
    main()
