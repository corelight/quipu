import type { ScanResponse, RuleMatch, MatchSpan } from "./ipc";

// Renders scan results as a collapsible rule ▸ pattern ▸ match tree, and drives
// a full-width hex/context dock when a match is selected. The dock needs the
// scanned target bytes to show surrounding context, so we keep them here.

const HEX_CONTEXT = 64; // bytes shown before/after a match in the hex dump
const BYTES_PER_ROW = 16;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!
  );
}

export class ResultsView {
  private bytes: Uint8Array = new Uint8Array();
  // Stable index so a clicked match row can look its data back up.
  private matchIndex: Array<{ rule: RuleMatch; m: MatchSpan }> = [];

  constructor(
    private treeEl: HTMLElement,
    private hexDockEl: HTMLElement,
    private hexTitleEl: HTMLElement,
    private hexBodyEl: HTMLElement,
    hexCloseEl: HTMLElement,
    // Called with a rule name when the user clicks the rule TITLE (not the
    // twisty) — used to locate and focus that rule in the editor.
    private onRuleClick: (ruleName: string) => void,
    // Called with (ruleName, pattern) when the user clicks a match's pattern id
    // (e.g. "$s1") — focuses that string's definition within the rule.
    private onPatternClick: (ruleName: string, pattern: string) => void
  ) {
    hexCloseEl.addEventListener("click", () => this.hideHex());

    // Delegated clicks. Distinct targets: twisty toggles expand/collapse; rule
    // name focuses the rule; a match's pattern id focuses the string def; the
    // rest of a match row selects it (drives the hex view).
    this.treeEl.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;

      const twisty = target.closest<HTMLElement>(".twisty");
      if (twisty) {
        twisty.closest(".rule-node")!.classList.toggle("expanded");
        return;
      }

      const ruleName = target.closest<HTMLElement>(".rule-name");
      if (ruleName) {
        this.onRuleClick(ruleName.dataset.rule!);
        return;
      }

      const pat = target.closest<HTMLElement>(".pat");
      if (pat) {
        const idx = Number(pat.closest<HTMLElement>(".match-row")!.dataset.idx);
        const entry = this.matchIndex[idx];
        if (entry) this.onPatternClick(entry.rule.rule, entry.m.pattern);
        return;
      }

      const matchRow = target.closest<HTMLElement>(".match-row");
      if (matchRow) {
        const idx = Number(matchRow.dataset.idx);
        this.treeEl
          .querySelectorAll(".match-row.selected")
          .forEach((el) => el.classList.remove("selected"));
        matchRow.classList.add("selected");
        this.showHex(idx);
      }
    });
  }

  clear() {
    this.treeEl.innerHTML = "";
    this.matchIndex = [];
    this.hideHex();
  }

  render(res: ScanResponse, target: Uint8Array) {
    this.bytes = target;
    this.matchIndex = [];
    this.hideHex();

    if (res.matched.length === 0) {
      this.treeEl.innerHTML = `<div class="muted">Scanned ${res.scannedBytes} bytes — no matching rules.</div>`;
      return;
    }

    const blocks: string[] = [
      `<div class="muted">Scanned ${res.scannedBytes} bytes — ${res.matched.length} matching rule(s).</div>`,
    ];
    for (const rule of res.matched) {
      const matchCount = rule.matches.length;
      const tags = rule.tags
        .map((t) => `<span class="tag">${escapeHtml(t)}</span>`)
        .join("");
      const matchRows = rule.matches
        .map((m) => {
          const idx = this.matchIndex.push({ rule, m }) - 1;
          return `<div class="match-row" data-idx="${idx}">
            <code class="pat" title="Go to string definition">${escapeHtml(m.pattern)}</code>
            <span class="off">0x${m.start.toString(16)}</span>
            <span class="len">${m.length}B</span>
          </div>`;
        })
        .join("");
      blocks.push(`
        <div class="rule-node expanded">
          <div class="rule-head">
            <span class="twisty"></span>
            <strong class="rule-name" data-rule="${escapeHtml(rule.rule)}" title="Go to rule in editor">${escapeHtml(rule.rule)}</strong>
            <span class="ns">${escapeHtml(rule.namespace)}</span>
            ${tags}
            <span class="count">${matchCount} match${matchCount === 1 ? "" : "es"}</span>
          </div>
          <div class="match-list-tree">${matchRows}</div>
        </div>`);
    }
    this.treeEl.innerHTML = blocks.join("");
  }

  private showHex(idx: number) {
    const entry = this.matchIndex[idx];
    if (!entry) return;
    const { rule, m } = entry;
    this.hexTitleEl.textContent = `${rule.rule} · ${m.pattern} @ 0x${m.start.toString(16)} (${m.length} bytes)`;
    this.hexBodyEl.innerHTML = this.renderHex(m.start, m.end);
    this.hexDockEl.classList.remove("hidden");
  }

  hideHex() {
    this.hexDockEl.classList.add("hidden");
  }

  // Renders a hex dump around [matchStart, matchEnd), with context on either
  // side and the matched bytes highlighted. Rows are 16-byte aligned.
  private renderHex(matchStart: number, matchEnd: number): string {
    const from = Math.max(0, matchStart - HEX_CONTEXT);
    const to = Math.min(this.bytes.length, matchEnd + HEX_CONTEXT);
    // Align the first row to a 16-byte boundary for readable offsets.
    const rowStart = from - (from % BYTES_PER_ROW);

    const rows: string[] = [];
    for (let base = rowStart; base < to; base += BYTES_PER_ROW) {
      const offset = base.toString(16).padStart(8, "0");
      const hexCells: string[] = [];
      const asciiCells: string[] = [];
      for (let i = 0; i < BYTES_PER_ROW; i++) {
        const pos = base + i;
        if (pos < from || pos >= to) {
          hexCells.push(`<span class="hb pad">  </span>`);
          asciiCells.push(`<span class="ac pad"> </span>`);
          continue;
        }
        const byte = this.bytes[pos];
        const inMatch = pos >= matchStart && pos < matchEnd;
        const hex = byte.toString(16).padStart(2, "0");
        const ch = byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : ".";
        const cls = inMatch ? "hb hit" : "hb";
        const acls = inMatch ? "ac hit" : "ac";
        hexCells.push(`<span class="${cls}">${hex}</span>`);
        asciiCells.push(`<span class="${acls}">${escapeHtml(ch)}</span>`);
      }
      rows.push(
        `<div class="hex-row"><span class="hex-off">${offset}</span><span class="hex-bytes">${hexCells.join(" ")}</span><span class="hex-ascii">${asciiCells.join("")}</span></div>`
      );
    }
    return rows.join("");
  }
}
