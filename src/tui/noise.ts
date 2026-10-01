// UI noise filter: terminal replies that leak into the input as text
// (SGR mouse reports and OSC color-query responses).

const inputNoise =
  /(\x1b\][^\x07\x1b]*(\x07|\x1b\\))|(\x1b?\[<[0-9;]*[Mm])|(\]1[01];rgb:[0-9a-fA-F/]{7,})|(;rgb:[0-9a-fA-F/]{7,})/g;

/** needsSanitize mirrors the Go fast-path check. */
export function needsSanitize(v: string): boolean {
  return /[<;[]/.test(v) || v.includes("\x1b");
}

/** sanitizeInput strips leaked terminal control replies from the input. */
export function sanitizeInput(v: string): string {
  if (!needsSanitize(v)) return v;
  return v.replace(inputNoise, "");
}
