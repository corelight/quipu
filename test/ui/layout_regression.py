#!/usr/bin/env python3
"""Check the app shell in Chromium, including the Windows scrollbar regression.

Requires Python Playwright and its Chromium browser. Uses the actual shell markup
and stylesheet without starting Tauri; native menus, IPC and Monaco are outside
this check. Run: python3 test/ui/layout_regression.py
"""
from pathlib import Path
import re

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]


def main() -> None:
    source = (ROOT / "app/src/main.ts").read_text()
    match = re.search(r'app\.innerHTML = `([\s\S]*?)`;', source)
    assert match, "cannot find the app shell"
    css = (ROOT / "app/src/styles.css").read_text()
    with sync_playwright() as p:
        browser = p.chromium.launch(ignore_default_args=["--hide-scrollbars"])
        page = browser.new_page()
        page.set_content(
            '<!doctype html><style>' + css + '</style><div id="app">'
            + match.group(1) + '</div>'
        )
        for width, height in [(1200, 800), (1600, 1000), (800, 600), (640, 400)]:
            page.set_viewport_size({"width": width, "height": height})
            for results in [False, True]:
                for explorer in [False, True]:
                    page.evaluate("""([results, explorer]) => {
                        document.querySelector('main').classList.toggle('results-open', results);
                        document.querySelector('#results-pane').classList.toggle('collapsed', !results);
                        document.querySelector('main').classList.toggle('explorer-hidden', !explorer);
                    }""", [results, explorer])
                    state = page.evaluate("""() => {
                        const root = document.documentElement;
                        const chevron = document.querySelector('.chevron').getBoundingClientRect();
                        return {
                            viewport: [innerWidth, innerHeight],
                            extent: [root.scrollWidth, root.scrollHeight],
                            chevron: [chevron.left, chevron.top, chevron.right, chevron.bottom],
                        };
                    }""")
                    context = f"{width}x{height}, results={results}, explorer={explorer}: {state}"
                    assert state['extent'] == state['viewport'], context
                    left, top, right, bottom = state['chevron']
                    assert 0 <= left < right <= width, context
                    assert 0 <= top < bottom <= height, context
        # Small windows must still let users reach content via the pane scrollbars.
        page.locator('.editor-pane').evaluate("""pane => {
            const content = document.createElement('div');
            content.style.cssText = 'height: 1500px; flex-shrink: 0';
            pane.append(content);
            pane.scrollTop = 1000;
        }""")
        assert page.locator('.editor-pane').evaluate('(pane) => pane.scrollTop') > 0
        assert page.evaluate('window.scrollY') == 0
        browser.close()
    print('PASS: shell fits 16 viewport/pane configurations; chevron reachable; pane scrolling retained')


if __name__ == '__main__':
    main()
