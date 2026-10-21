// Line diff used to render file edits back into the transcript.

/** unifiedDiff renders a line diff between old and new content. */
export function unifiedDiff(name: string, oldText: string, newText: string): string {
  const a = oldText.replace(/\n$/, "").split("\n");
  const b = newText.replace(/\n$/, "").split("\n");
  const out: string[] = [];
  for (const ln of lcsDiff(a, b)) {
    if (ln.op === "-") out.push("- " + ln.text);
    else if (ln.op === "+") out.push("+ " + ln.text);
  }
  if (out.length === 0) return name + " 변경 없음";
  return `--- ${name}\n+++ ${name}\n` + out.join("\n");
}

interface DiffLine {
  op: "-" | "+" | " ";
  text: string;
}

/** lcsDiff computes a line-level diff via LCS dynamic programming. */
export function lcsDiff(a: string[], b: string[]): DiffLine[] {
  const n = a.length, m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) lcs[i]![j] = lcs[i + 1]![j + 1]! + 1;
      else lcs[i]![j] = Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++; j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ op: "-", text: a[i++]! });
    } else {
      out.push({ op: "+", text: b[j++]! });
    }
  }
  for (; i < n; i++) out.push({ op: "-", text: a[i]! });
  for (; j < m; j++) out.push({ op: "+", text: b[j]! });
  return out;
}
