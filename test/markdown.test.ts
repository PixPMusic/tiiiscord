import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDiscordText } from "../src/markdown.ts";

const code = (value: string) => `\`${value}\``;

test("local project and basename links show the complete path without a redundant label", () => {
  for (const [input, path] of [
    ["[t3-discord](/Users/example/projects/t3-discord)", "/Users/example/projects/t3-discord"],
    ["[file.ts](./src/file.ts)", "./src/file.ts"],
    ["[file.ts](../src/file.ts)", "../src/file.ts"],
    ["[/tmp/file.ts](/tmp/file.ts)", "/tmp/file.ts"],
    ["[`file.ts`](/tmp/file.ts)", "/tmp/file.ts"],
    ["[file.ts](/tmp/file.ts:12:3)", "/tmp/file.ts:12:3"],
    ["[file.ts](/tmp/file.ts#L12-L20)", "/tmp/file.ts#L12-L20"],
    ["[project](/tmp/project/)", "/tmp/project/"],
    ["[](/tmp/project)", "/tmp/project"],
  ]) assert.equal(formatDiscordText(input!), code(path!));
});

test("meaningful labels and surrounding Markdown remain visible", () => {
  const text = "## Changes\n\n- **See [the implementation](/tmp/file.ts)** and [web](https://example.com).\n> [*my docs*](../docs/guide.md)\n";
  assert.equal(formatDiscordText(text), "## Changes\n\n- **See the implementation (`/tmp/file.ts`)** and [web](https://example.com).\n> *my docs* (`../docs/guide.md`)\n");
  assert.equal(formatDiscordText("[a [nested] label](/tmp/file)"), "a [nested] label (`/tmp/file`)");
  assert.equal(formatDiscordText("[**file.ts**](/tmp/file.ts)"), "**file.ts** (`/tmp/file.ts`)");
});

test("Windows drive, rooted, relative and UNC paths retain their backslashes", () => {
  for (const path of [
    String.raw`C:\Users\example\file.ts`, "D:/work/file.ts", String.raw`\\server\share\file.ts`,
    String.raw`\work\file.ts`, String.raw`.\src\file.ts`, String.raw`..\src\file.ts`,
    String.raw`C:\work\(copy)\file.ts`,
  ]) assert.equal(formatDiscordText(`[file.ts](${path})`), code(path));
  for (const path of [String.raw`\\server\share\file.ts`, String.raw`C:\(copy)\file.ts`])
    assert.equal(formatDiscordText(`[${path}](${path})`), code(path));
  assert.equal(formatDiscordText(String.raw`[open](C:\my project\file.ts)`), String.raw`open (` + code(String.raw`C:\my project\file.ts`) + ")");
});

test("file URLs are readable code and keep their original URL spelling", () => {
  for (const path of ["file:///Users/example/file.ts", "file:///C:/work/file.ts", "file://server/share/file.ts", "FILE:///tmp/file.ts", "file:///tmp/my%20file.ts"])
    assert.equal(formatDiscordText(`[open](${path})`), `open (${code(path)})`);
});

test("spaces, balanced parentheses, angle destinations and quoted titles preserve the path", () => {
  for (const [input, path] of [
    ['[open](/tmp/a(b(c)).ts "title (x)")', "/tmp/a(b(c)).ts"],
    ["[open](/tmp/my project/file.ts)", "/tmp/my project/file.ts"],
    ["[open](/tmp/my project (old)/file.ts)", "/tmp/my project (old)/file.ts"],
    ["[open](/tmp/my project (old))", "/tmp/my project (old)"],
    ["[open](</tmp/a b(1).ts> 'title')", "/tmp/a b(1).ts"],
    ["[open](</tmp/unbalanced(.ts>)", "/tmp/unbalanced(.ts"],
    ['[open]( /tmp/my project.ts "title" )', "/tmp/my project.ts"],
    [String.raw`[open](/tmp/a\(b\).ts)`, "/tmp/a(b).ts"],
    [String.raw`[open](</tmp/a\>b.ts>)`, "/tmp/a>b.ts"],
    [String.raw`[open](<C:\work\my file.ts> "title")`, String.raw`C:\work\my file.ts`],
  ]) assert.equal(formatDiscordText(input!), `open (${code(path!)})`);
});

test("normal links, images, references and escaped brackets stay byte-for-byte unchanged", () => {
  for (const text of [
    '[web](https://example.com/a(b)?q=x "title")', "[web](HTTP://example.com/file)",
    "[web](<https://example.com/a b> 'title')", "[web](//example.com/path)",
    "[mail](mailto:person@example.com)", "[anchor](#section)", "[relative](docs/file.ts)",
    "![image](/tmp/file.png)", String.raw`\[file](/tmp/file)`,
    String.raw`[a\](/tmp/file)`, "[file][local]\n\n[local]: /tmp/file",
    "[outer [inner](/tmp/inner)](https://example.com)",
    "[outer [inner](/tmp/inner)](/tmp/outer)",
  ]) assert.equal(formatDiscordText(text), text);
  assert.equal(formatDiscordText(String.raw`\\[file](/tmp/file)`), String.raw`\\` + code("/tmp/file"));
  assert.equal(formatDiscordText(String.raw`\![file](/tmp/file)`), String.raw`\!` + code("/tmp/file"));
});

test("inline-code examples and exact backtick run boundaries are preserved", () => {
  for (const example of [
    "`[file](/tmp/file)`", "``[file](/tmp/file) `x` ``", "``` [file](/tmp/file) `x` ```",
    "`first line\n[file](/tmp/file)`",
  ]) {
    assert.equal(formatDiscordText(`${example} [next](/tmp/next)`), `${example} ${code("/tmp/next")}`);
  }
  assert.equal(formatDiscordText("unmatched ` [file](/tmp/file)"), "unmatched ` " + code("/tmp/file"));
  assert.equal(formatDiscordText("\\` [file](/tmp/file)"), "\\` " + code("/tmp/file"));
});

test("fenced blocks, including longer fences and unclosed blocks, remain intact", () => {
  for (const fence of ["```ts\n[file](/tmp/file)\n```\n", "~~~~md\n[file](/tmp/file)\n~~~\n~~~~~\n", "  ````md\r\n```\r\n[file](/tmp/file)\r\n  ````\r\n"]) {
    assert.equal(formatDiscordText(`[before](/tmp/before)\n${fence}[after](/tmp/after)`), `${code("/tmp/before")}\n${fence}${code("/tmp/after")}`);
  }
  const unclosed = "```md\n[file](/tmp/file)\n";
  assert.equal(formatDiscordText(unclosed), unclosed);
});

test("paths containing backticks use a longer delimiter with boundary padding", () => {
  assert.equal(formatDiscordText("[open](/tmp/a`b.ts)"), "open (``/tmp/a`b.ts``)");
  assert.equal(formatDiscordText("[open](/tmp/a``b`c.ts)"), "open (```/tmp/a``b`c.ts```)");
  assert.equal(formatDiscordText("[open](/tmp/file`)"), "open (`` /tmp/file` ``)");
  assert.equal(formatDiscordText("[open](</tmp/file >)"), "open (` /tmp/file  `)");
});

test("exposed labels cannot generate mentions and paths keep literal mention text in code", () => {
  assert.equal(formatDiscordText("[@everyone](/tmp/file) [<@123>](/tmp/other)"), "@\u200beveryone (`/tmp/file`) <@\u200b123> (`/tmp/other`)");
  assert.equal(formatDiscordText(String.raw`[\@here](/tmp/file)`), String.raw`\@here (` + code("/tmp/file") + ")");
  assert.equal(formatDiscordText("[open](/tmp/@everyone/<@&123>)"), "open (`/tmp/@everyone/<@&123>`)");
  assert.equal(formatDiscordText("[web](https://example.com/@everyone) @here"), "[web](https://example.com/@everyone) @here");
});

test("malformed links are left alone and long bracket runs are bounded", () => {
  for (const text of ["[open](/tmp/unclosed", "[open](/tmp/a(b)", "[open](</tmp/file)", "[open](/tmp/line\nbreak)", "[open](</tmp/file> 'unclosed)", "[".repeat(20_000)]) {
    assert.equal(formatDiscordText(text), text);
  }
});

test("formatting is idempotent across mixed prose, code, escaped text and local links", () => {
  for (const text of [
    "[t3-discord](/Users/example/projects/t3-discord) [guide](./docs/guide.md) [web](https://example.com)",
    "[open](/tmp/a``b`c.ts) [next](/tmp/next)",
    "[@everyone](/tmp/file)\n```md\n[unchanged](/tmp/example)\n```\n[open](/tmp/file`)",
    String.raw`\[example](/tmp/example) [a \[label\]](../file)`,
    "[outer [inner](/tmp/inner)](/tmp/outer)",
  ]) {
    const formatted = formatDiscordText(text);
    assert.equal(formatDiscordText(formatted), formatted);
  }
});
