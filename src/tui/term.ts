// Terminal program: alt-screen, raw-mode input decoding (keys, SGR mouse,
// resize) and the message loop driving the Elm-style model.

export interface KeyMsg {
  t: "key";
  type: string; // "runes" | "enter" | "esc" | "tab" | "up" | "down" | "left" | "right" | "pgup" | "pgdown" | "backspace" | "delete" | "home" | "end" | "ctrl+c" | "space" | ...
  runes: string[];
  str: string;
}

export interface MouseWheelMsg {
  t: "mouseWheel";
  dy: number;
}

export interface ResizeMsg {
  t: "resize";
  width: number;
  height: number;
}

export interface QuitMsg {
  t: "quit";
}

export type ProgMsg = KeyMsg | MouseWheelMsg | ResizeMsg | QuitMsg;

/** Cmd resolves to the next message (or null for nothing). */
export type Cmd = Promise<unknown> | null;

export interface Model {
  update(msg: unknown): Cmd[] | Cmd | null;
  view(): string;
}

export function keyMsg(type: string, runes: string[] = [], str?: string): KeyMsg {
  return { t: "key", type, runes, str: str ?? type };
}

function runeStr(runes: string[]): string {
  return runes.join("");
}

const isFinalByte = (b: number): boolean => b >= 0x40 && b <= 0x7e;

/** decodeKeys turns raw stdin bytes into key/mouse messages. */
export function decodeKeys(chunk: Uint8Array, push: (m: ProgMsg) => void, buf: { s: string }): void {
  buf.s += new TextDecoder("utf-8", { fatal: false }).decode(chunk);
  const s = buf.s;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i]!;
    const code = c.codePointAt(0) ?? 0;
    if (c === "\x1b") {
      // incomplete escape at the buffer tail: wait for more bytes
      if (i === n - 1) break;
      const next = s[i + 1]!;
      if (next === "[") {
        // CSI: consume through the final byte
        let j = i + 2;
        while (j < n && !isFinalByte(s.charCodeAt(j))) j++;
        if (j >= n) break; // incomplete
        const body = s.slice(i + 2, j); // params + final
        i = j + 1;
        decodeCSI(body, push);
        continue;
      }
      if (next === "]") {
        // OSC: consume through BEL or ST
        let j = i + 2;
        let done = false;
        while (j < n) {
          const ch = s[j]!;
          if (ch === "\x07") {
            j++;
            done = true;
            break;
          }
          if (ch === "\x1b" && s[j + 1] === "\\") {
            j += 2;
            done = true;
            break;
          }
          j++;
        }
        if (!done) break; // incomplete
        i = j;
        continue; // ignore OSC replies
      }
      // alt + key
      i++;
      const alt = decodeSimple(next);
      if (alt) {
        if (alt.type === "runes") push({ t: "key", type: "runes", runes: alt.runes ?? [], str: runeStr(alt.runes ?? []) });
        else push(keyMsg(alt.type));
      }
      continue;
    }
    const simple = decodeSimple(c);
    i += c.length;
    if (simple) {
      if (simple.type === "runes") push({ t: "key", type: "runes", runes: simple.runes ?? [], str: runeStr(simple.runes ?? []) });
      else push(keyMsg(simple.type));
    }
  }
  buf.s = s.slice(i);
}

function decodeSimple(c: string): { type: string; runes?: string[] } | null {
  const code = c.codePointAt(0) ?? 0;
  switch (c) {
    case "\r":
    case "\n":
      return { type: "enter" };
    case "\t":
      return { type: "tab" };
    case "\x7f":
      return { type: "backspace" };
    case " ":
      return { type: "runes", runes: [" "] };
  }
  if (code >= 1 && code <= 26 && c !== "\x1b") {
    return { type: "ctrl+" + String.fromCharCode(0x60 + code) };
  }
  if (code >= 0x20) {
    return { type: "runes", runes: Array.from(c) };
  }
  return null;
}

function decodeCSI(body: string, push: (m: ProgMsg) => void): void {
  // SGR mouse: <params M|m  (64=wheel up, 65=wheel down)
  if (body.startsWith("<")) {
    const m = /^<(\d+);(\d+);(\d+)[Mm]$/.exec(body);
    if (m) {
      const btn = parseInt(m[1]!, 10);
      if (btn === 64) push({ t: "mouseWheel", dy: -3 });
      else if (btn === 65) push({ t: "mouseWheel", dy: 3 });
    }
    return;
  }
  switch (body) {
    case "A":
      push(keyMsg("up"));
      return;
    case "B":
      push(keyMsg("down"));
      return;
    case "C":
      push(keyMsg("right"));
      return;
    case "D":
      push(keyMsg("left"));
      return;
    case "H":
      push(keyMsg("home"));
      return;
    case "F":
      push(keyMsg("end"));
      return;
    case "1~":
      push(keyMsg("home"));
      return;
    case "4~":
      push(keyMsg("end"));
      return;
    case "3~":
      push(keyMsg("delete"));
      return;
    case "5~":
      push(keyMsg("pgup"));
      return;
    case "6~":
      push(keyMsg("pgdown"));
      return;
    default:
      return; // unrecognized sequence: ignore
  }
}

/** Program drives a Model inside the live terminal. */
export class Program {
  private model: Model;
  private queue: unknown[] = [];
  private waiting: (() => void) | null = null;
  private running = true;
  private lastFrame = "";
  private renderPending = false;
  private keyBuf = { s: "" };

  constructor(model: Model) {
    this.model = model;
  }

  /** send enqueues a message into the loop. */
  send(m: unknown): void {
    if (m == null || !this.running) return;
    this.queue.push(m);
    const w = this.waiting;
    this.waiting = null;
    w?.();
  }

  quit(): void {
    this.send({ t: "quit" });
  }

  async run(): Promise<void> {
    const stdin = process.stdin;
    const stdout = process.stdout;

    stdout.write("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h");
    const restore = (): void => {
      stdout.write("\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l");
    };

    try {
      stdin.setRawMode(true);
    } catch {
      // stdin may not be a TTY; keys won't work
    }
    stdin.resume();

    const onData = (chunk: Uint8Array): void => {
      decodeKeys(new Uint8Array(chunk), (m) => this.send(m), this.keyBuf);
    };
    const onResize = (): void => {
      this.send({ t: "resize", width: stdout.columns ?? 80, height: stdout.rows ?? 24 } satisfies ResizeMsg);
    };
    const onSIGINT = (): void => {
      this.send({ t: "key", type: "ctrl+c", runes: [], str: "ctrl+c" });
    };
    stdin.on("data", onData);
    process.stdout.on("resize", onResize);
    process.on("SIGINT", onSIGINT);

    // initial size
    this.send({ t: "resize", width: stdout.columns ?? 80, height: stdout.rows ?? 24 });

    try {
      while (this.running) {
        const msg = await this.dequeue();
        if ((msg as QuitMsg).t === "quit") break;
        const cmds = this.model.update(msg);
        this.fireCmds(cmds);
        this.scheduleRender();
      }
    } finally {
      this.running = false;
      stdin.off("data", onData);
      process.stdout.off("resize", onResize);
      process.off("SIGINT", onSIGINT);
      try {
        stdin.setRawMode(false);
      } catch {
        // ignore
      }
      stdin.pause();
      restore();
    }
  }

  private fireCmds(cmds: Cmd[] | Cmd | null): void {
    const list = Array.isArray(cmds) ? cmds : cmds ? [cmds] : [];
    for (const cmd of list) {
      if (!cmd) continue;
      void cmd
        .then((m) => this.send(m))
        .catch((err) => this.send({ t: "actionDone", err: err instanceof Error ? err : new Error(String(err)) }));
    }
  }

  private scheduleRender(): void {
    if (this.renderPending) return;
    this.renderPending = true;
    queueMicrotask(() => {
      this.renderPending = false;
      if (!this.running) return;
      const frame = this.model.view();
      if (frame === this.lastFrame) return;
      this.lastFrame = frame;
      process.stdout.write("\x1b[H" + frame + "\x1b[0J");
    });
  }

  private dequeue(): Promise<unknown> {
    const m = this.queue.shift();
    if (m !== undefined) return Promise.resolve(m);
    return new Promise((resolve) => {
      this.waiting = () => resolve(this.queue.shift());
    });
  }
}
