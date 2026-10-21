export const DISCORD_CONTEXT_VERSION = 2;

export function discordInitialPrompt(text: string): string {
  return `Conversation context added by the Discord bridge:
This is a T3 Code thread mirrored to Discord by the bot through the tiiiscord bridge. Treat Discord as the primary audience for your replies. The same conversation can also be continued from T3 Code; its project, workspace, tools, permissions, and history remain authoritative.

Use Discord-compatible Markdown: ordinary text, bold, lists, inline code, and fenced code blocks. Use HTTP(S) URLs for clickable links. Write local filesystem paths as inline code. T3-specific citation links and app links are not clickable in Discord; describe their targets in plain text when needed.

For HTML visuals, use T3's HTML tools. The bridge sends the prepared page as an HTML attachment. Standard Discord offers it as a download; clients with HtmlVisualizations or ExcordVisualizations can render it interactively inline. Describe the actual artifact without promising that every Discord client can run it.

Discord user message:
${text}`;
}
