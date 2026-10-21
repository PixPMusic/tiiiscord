// Bound speculative scans of malformed links; ordinary messages need only a small inline grammar.
const MAX_LINK_LENGTH = 16_384;

function isWindowsPath(path: string): boolean {
  return /^(?:[a-z]:\\|\\|\.{1,2}\\)/i.test(path);
}

function unescapeMarkdown(text: string): string {
  return text.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1");
}

function codePath(path: string): string {
  let width = 1;
  for (const run of path.matchAll(/`+/g)) width = Math.max(width, run[0].length + 1);
  const delimiter = "`".repeat(width);
  const padding = /^[ `]|[ `]$/.test(path) ? " " : "";
  return `${delimiter}${padding}${path}${padding}${delimiter}`;
}

function renderLink(label: string, path: string): string {
  const code = codePath(path);
  let plainLabel = label.trim();
  const inlineCode = /^(`+)([\s\S]*?)\1$/.exec(plainLabel);
  if (inlineCode) {
    plainLabel = inlineCode[2]!;
    if (/^ .* $/.test(plainLabel) && plainLabel.trim()) plainLabel = plainLabel.slice(1, -1);
  }
  if (!inlineCode && !isWindowsPath(plainLabel)) plainLabel = unescapeMarkdown(plainLabel);
  const withoutLocation = path.replace(/(?:#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?|:\d+(?::\d+)?)$/, "");
  const basename = (value: string) => value.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1);
  if (!plainLabel || [path, withoutLocation, basename(path), basename(withoutLocation)].includes(plainLabel)) return code;

  // Removing a masked link can expose mentions. Preserve escapes and the visible label.
  const safeLabel = label.replace(/\\[\s\S]|@(?!\u200b)/g, part => part === "@" ? "@\u200b" : part);
  return `${safeLabel} (${code})`;
}

function readLink(text: string, start: number, codeEnds: Map<number, number>) {
  const limit = Math.min(text.length, start + MAX_LINK_LENGTH);
  let cursor = start + 1;
  let depth = 1;
  let nestedLink = false;
  for (; cursor < limit; cursor++) {
    const char = text[cursor];
    if (char === "\\") cursor++;
    else if (char === "`") {
      const end = codeEnds.get(cursor);
      if (!end || end > limit) return;
      cursor = end - 1;
    } else if (char === "[") depth++;
    else if (char === "]") {
      if (--depth === 0) break;
      if (text[cursor + 1] === "(") nestedLink = true;
    }
  }
  if (text[cursor] !== "]" || text[cursor + 1] !== "(") return;
  const label = text.slice(start + 1, cursor);
  cursor += 2;
  while (text[cursor] === " " || text[cursor] === "\t") cursor++;
  const angle = text[cursor] === "<";
  if (angle) cursor++;
  const destinationStart = cursor;
  const windows = isWindowsPath(text.slice(cursor, cursor + 4));
  depth = 0;

  const finish = (destinationEnd: number, end: number) => ({
    label,
    path: windows ? text.slice(destinationStart, destinationEnd) : unescapeMarkdown(text.slice(destinationStart, destinationEnd)),
    end,
    nestedLink,
  });

  const afterDestination = (destinationEnd: number, position: number) => {
    while (text[position] === " " || text[position] === "\t") position++;
    if (text[position] === ")") return finish(destinationEnd, position + 1);
    const quote = text[position];
    if (quote !== '"' && quote !== "'" && !(angle && quote === "(")) return;
    const close = quote === "(" ? ")" : quote;
    for (position++; position < limit; position++) {
      if (text[position] === "\n" || text[position] === "\r") return;
      if (text[position] === "\\") position++;
      else if (text[position] === close) {
        position++;
        while (text[position] === " " || text[position] === "\t") position++;
        if (text[position] === ")") return finish(destinationEnd, position + 1);
        return;
      }
    }
  };

  for (; cursor < limit; cursor++) {
    const char = text[cursor];
    if (char === "\n" || char === "\r") return;
    if (!windows && char === "\\") { cursor++; continue; }
    if (angle) {
      if (char === ">") return afterDestination(cursor, cursor + 1);
    } else {
      if (depth === 0 && (char === " " || char === "\t")) {
        const result = afterDestination(cursor, cursor);
        if (result) return result;
      }
      if (char === "(") depth++;
      else if (char === ")") {
        if (depth === 0) return finish(cursor, cursor + 1);
        depth--;
      }
    }
  }
}

function formatInline(text: string): string {
  // Index exact backtick runs once, including unmatched runs, to avoid repeated suffix scans.
  const codeEnds = new Map<number, number>();
  const previousRun = new Map<number, number>();
  for (const run of text.matchAll(/`+/g)) {
    const previous = previousRun.get(run[0].length);
    if (previous !== undefined) codeEnds.set(previous, run.index + run[0].length);
    previousRun.set(run[0].length, run.index);
  }
  const parts: string[] = [];
  let copied = 0;
  for (let cursor = 0; cursor < text.length; cursor++) {
    const char = text[cursor];
    if (char === "\\") { cursor++; continue; }
    if (char === "`") {
      const end = codeEnds.get(cursor);
      if (end) cursor = end - 1;
      else while (text[cursor + 1] === "`") cursor++;
      continue;
    }
    const image = char === "!" && text[cursor + 1] === "[";
    if (char !== "[" && !image) continue;
    const link = readLink(text, cursor + (image ? 1 : 0), codeEnds);
    if (!link) continue;
    if (!image && !link.nestedLink && /^(?:\/(?!\/)|\.{1,2}[\\/]|[a-z]:[\\/]|\\|file:\/\/)/i.test(link.path)) {
      parts.push(text.slice(copied, cursor), renderLink(link.label, link.path));
      copied = link.end;
    }
    cursor = link.end - 1;
  }
  parts.push(text.slice(copied));
  return parts.join("");
}

export function formatDiscordText(text: string): string {
  const parts: string[] = [];
  let copied = 0;
  let fence: { marker: string; width: number; start: number } | undefined;
  for (const line of text.matchAll(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)(?:\r?\n|$)/gm)) {
    const marker = line[1]!;
    const suffix = line[2]!;
    if (!fence) {
      if (marker[0] === "`" && suffix.includes("`")) continue;
      parts.push(formatInline(text.slice(copied, line.index)));
      fence = { marker: marker[0]!, width: marker.length, start: line.index };
    } else if (marker[0] === fence.marker && marker.length >= fence.width && /^[ \t]*$/.test(suffix)) {
      copied = line.index + line[0].length;
      parts.push(text.slice(fence.start, copied));
      fence = undefined;
    }
  }
  parts.push(fence ? text.slice(fence.start) : formatInline(text.slice(copied)));
  return parts.join("");
}
