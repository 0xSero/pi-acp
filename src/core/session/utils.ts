import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_TITLE_LENGTH = 160;

export function normalizeCwd(value?: string | null): string | null {
  if (!value) {
    return null;
  }
  let normalized = value.trim();
  if (!normalized) {
    return null;
  }
  if (normalized.startsWith("file://")) {
    try {
      normalized = fileURLToPath(normalized);
    } catch {
      // Ignore invalid file URLs
    }
  }
  normalized = path.resolve(normalized);
  normalized = normalized.replace(/[\\/]+$/, "");
  return normalized;
}

export function normalizeTitle(value?: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  return truncateTitle(normalized, MAX_TITLE_LENGTH);
}

export function extractMessageText(content: unknown): string | undefined {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const type = (block as { type?: string }).type;
    if (type !== "text") {
      continue;
    }
    const text = (block as { text?: string }).text;
    if (typeof text === "string" && text.trim().length > 0) {
      parts.push(text.trim());
    }
  }

  if (parts.length === 0) {
    return undefined;
  }

  return parts.join(" ").trim();
}

export function safeJsonParse(line: string): unknown | null {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return null;
  }
}

export function expandHome(input: string): string {
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function truncateTitle(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}
