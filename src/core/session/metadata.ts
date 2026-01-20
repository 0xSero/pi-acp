import { randomUUID } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { getSessionDirForCwd, listSessionFiles } from "./paths";
import { extractMessageText, normalizeCwd, normalizeTitle, safeJsonParse } from "./utils";

export type SessionFileInfo = {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
  filePath: string;
  messageCount: number;
  modifiedMs: number;
};

export async function scanSessions(options?: { cwd?: string | null }): Promise<{
  sessions: SessionFileInfo[];
  map: Map<string, string>;
}> {
  const files = await listSessionFiles();
  const results = await Promise.all(files.map((file) => readSessionInfo(file)));

  const sessions: SessionFileInfo[] = [];
  const map = new Map<string, string>();
  const targetCwd = normalizeCwd(options?.cwd ?? null);

  for (const info of results) {
    if (!info) {
      continue;
    }
    if (targetCwd && normalizeCwd(info.cwd) !== targetCwd) {
      continue;
    }
    sessions.push(info);
    map.set(info.sessionId, info.filePath);
  }

  sessions.sort((a, b) => b.modifiedMs - a.modifiedMs);
  return { sessions, map };
}

export async function readSessionInfo(filePath: string): Promise<SessionFileInfo | null> {
  try {
    const content = await readFile(filePath, "utf8");
    const lines = content.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length === 0) {
      return null;
    }

    const header = safeJsonParse(lines[0]);
    if (!header || typeof header !== "object") {
      return null;
    }
    const headerObj = header as Record<string, unknown>;
    if (headerObj.type !== "session" || typeof headerObj.id !== "string") {
      return null;
    }

    const stats = await stat(filePath);
    const rawCwd = typeof headerObj.cwd === "string" ? headerObj.cwd : "";
    const cwd = normalizeCwd(rawCwd) ?? rawCwd;
    let title: string | undefined;
    let firstUserMessage: string | undefined;
    let updatedAt: string | undefined = typeof headerObj.timestamp === "string" ? headerObj.timestamp : undefined;
    let messageCount = 0;

    for (const line of lines.slice(1)) {
      const entry = safeJsonParse(line);
      if (!entry || typeof entry !== "object") {
        continue;
      }

      const entryObj = entry as Record<string, unknown>;
      if (typeof entryObj.timestamp === "string") {
        updatedAt = entryObj.timestamp;
      }

      if (entryObj.type === "session_info" && typeof entryObj.name === "string") {
        const name = normalizeTitle(entryObj.name);
        if (name) {
          title = name;
        }
      }

      if (entryObj.type !== "message" || !entryObj.message) {
        continue;
      }

      messageCount++;

      const messageObj = entryObj.message as Record<string, unknown>;
      const role = typeof messageObj.role === "string" ? messageObj.role : "";
      if (role !== "user") {
        continue;
      }

      if (!firstUserMessage) {
        const text = extractMessageText(messageObj.content);
        if (text) {
          firstUserMessage = text;
        }
      }
    }

    const resolvedTitle = title ?? normalizeTitle(firstUserMessage);
    const resolvedUpdatedAt = updatedAt ?? stats.mtime.toISOString();

    return {
      sessionId: headerObj.id,
      cwd,
      title: resolvedTitle,
      updatedAt: resolvedUpdatedAt,
      filePath,
      messageCount,
      modifiedMs: stats.mtimeMs,
    };
  } catch {
    return null;
  }
}

export async function createForkedSessionFile(
  sourcePath: string,
  targetCwd: string
): Promise<{ sessionId: string; filePath: string }> {
  const content = await readFile(sourcePath, "utf8");
  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    throw new Error(`Source session is empty: ${sourcePath}`);
  }

  const header = safeJsonParse(lines[0]);
  if (!header || typeof header !== "object") {
    throw new Error(`Invalid session header: ${sourcePath}`);
  }
  const headerObj = header as Record<string, unknown>;
  if (headerObj.type !== "session" || typeof headerObj.id !== "string") {
    throw new Error(`Invalid session header: ${sourcePath}`);
  }

  const sessionId = randomUUID();
  const timestamp = new Date().toISOString();
  const fileTimestamp = timestamp.replace(/[:.]/g, "-");
  const sessionDir = await getSessionDirForCwd(targetCwd);
  const filePath = path.join(sessionDir, `${fileTimestamp}_${sessionId}.jsonl`);

  const newHeader = {
    type: "session",
    version: typeof headerObj.version === "number" ? headerObj.version : 3,
    id: sessionId,
    timestamp,
    cwd: targetCwd,
    parentSession: sourcePath,
  };

  const output = [JSON.stringify(newHeader), ...lines.slice(1)].join("\n");
  await writeFile(filePath, `${output}\n`, "utf8");

  return { sessionId, filePath };
}
