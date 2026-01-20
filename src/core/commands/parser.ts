import type { ContentBlock } from "@agentclientprotocol/sdk";

export function extractCommandText(prompt: ContentBlock[]): string | null {
  const firstText = prompt.find((block): block is { type: "text"; text: string } => block.type === "text");
  if (!firstText) {
    return null;
  }
  const trimmed = firstText.text.trim();
  return trimmed.startsWith("/") ? trimmed : null;
}

export function parseCommand(text: string): { command: string; args: string } | null {
  const [commandRaw, ...rest] = text.slice(1).split(/\s+/u);
  if (!commandRaw) {
    return null;
  }
  return { command: commandRaw.toLowerCase(), args: rest.join(" ").trim() };
}
