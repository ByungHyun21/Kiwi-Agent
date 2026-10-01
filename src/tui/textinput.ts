// Minimal text input widget (port of the bubbles/textinput subset used).

import { displayWidth } from "./ansi.ts";
import type { KeyMsg } from "./term.ts";
import { mutedStyle } from "./styles.ts";

export class TextInput {
  value = "";
  cursor = 0; // rune index
  placeholder = "";
  prompt = "> ";
  charLimit = 0;
  width = 0;
  focused = true;

  runes(): string[] {
    return Array.from(this.value);
  }

  setValue(v: string): void {
    if (this.charLimit > 0 && Array.from(v).length > this.charLimit) {
      v = Array.from(v).slice(0, this.charLimit).join("");
    }
    this.value = v;
    this.cursor = this.runes().length;
  }

  getValue(): string {
    return this.value;
  }

  focus(): void {
    this.focused = true;
  }

  update(msg: KeyMsg): void {
    if (!this.focused) return;
    const runes = this.runes();
    switch (msg.type) {
      case "runes": {
        if (this.charLimit > 0 && runes.length >= this.charLimit) return;
        const insert = msg.runes.join("");
        const before = runes.slice(0, this.cursor).join("");
        const after = runes.slice(this.cursor).join("");
        let next = before + insert + after;
        if (this.charLimit > 0 && Array.from(next).length > this.charLimit) {
          next = Array.from(next).slice(0, this.charLimit).join("");
        }
        this.value = next;
        this.cursor += Array.from(insert).length;
        return;
      }
      case "space": {
        this.update({ t: "key", type: "runes", runes: [" "], str: " " });
        return;
      }
      case "backspace": {
        if (this.cursor > 0) {
          const before = runes.slice(0, this.cursor - 1).join("");
          const after = runes.slice(this.cursor).join("");
          this.value = before + after;
          this.cursor--;
        }
        return;
      }
      case "delete": {
        if (this.cursor < runes.length) {
          const before = runes.slice(0, this.cursor).join("");
          const after = runes.slice(this.cursor + 1).join("");
          this.value = before + after;
        }
        return;
      }
      case "left": {
        if (this.cursor > 0) this.cursor--;
        return;
      }
      case "right": {
        if (this.cursor < runes.length) this.cursor++;
        return;
      }
      case "home":
        this.cursor = 0;
        return;
      case "end":
        this.cursor = runes.length;
        return;
      case "ctrl+u":
        this.value = runes.slice(this.cursor).join("");
        this.cursor = 0;
        return;
      case "ctrl+k":
        this.value = runes.slice(0, this.cursor).join("");
        return;
      case "ctrl+w": {
        // delete the word before the cursor
        const before = runes.slice(0, this.cursor);
        let i = before.length;
        while (i > 0 && before[i - 1] === " ") i--;
        while (i > 0 && before[i - 1] !== " ") i--;
        this.value = [...before.slice(0, i), ...runes.slice(this.cursor)].join("");
        this.cursor = i;
        return;
      }
      default:
        return;
    }
  }

  view(): string {
    if (this.value === "" && this.placeholder !== "") {
      let ph = this.placeholder;
      if (this.width > 0 && displayWidth(ph) > this.width - displayWidth(this.prompt)) {
        ph = ph.slice(0, Math.max(0, this.width - displayWidth(this.prompt)));
      }
      return this.prompt + mutedStyle.render(ph);
    }
    const runes = this.runes();
    const promptW = displayWidth(this.prompt);
    let start = 0;
    let end = runes.length;
    if (this.width > 0 && runes.length + promptW > this.width) {
      const avail = Math.max(4, this.width - promptW);
      start = Math.max(0, this.cursor - avail + 1);
      end = start + avail;
      if (end > runes.length) {
        end = runes.length;
        start = Math.max(0, end - avail);
      }
    }
    const before = runes.slice(start, this.cursor).join("");
    const at = this.cursor < runes.length ? runes[this.cursor]! : " ";
    const after = runes.slice(Math.min(this.cursor + 1, end)).join("");
    const cursorCell = "\x1b[7m" + at + "\x1b[0m";
    return this.prompt + before + cursorCell + after;
  }
}
