import { mkdir, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expandHome, normalizeCwd } from "./utils";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

export function getAgentDir(): string {
  const envDir = process.env[AGENT_DIR_ENV];
  if (envDir) {
    return expandHome(envDir);
  }
  return path.join(os.homedir(), ".pi", "agent");
}

export function getSessionsDir(): string {
  return path.join(getAgentDir(), "sessions");
}

export async function getSessionDirForCwd(cwd: string): Promise<string> {
  const normalizedCwd = normalizeCwd(cwd) ?? cwd;
  const safePath = `--${normalizedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = path.join(getSessionsDir(), safePath);
  await mkdir(sessionDir, { recursive: true });
  return sessionDir;
}

export async function listSessionFiles(): Promise<string[]> {
  const sessionsDir = getSessionsDir();
  let dirEntries: Array<import("node:fs").Dirent> = [];
  try {
    dirEntries = await readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  const candidateDirs = dirEntries.filter((entry) => entry.isDirectory()).map((entry) => path.join(sessionsDir, entry.name));

  for (const dir of candidateDirs) {
    try {
      const sessionEntries = await readdir(dir, { withFileTypes: true });
      for (const entry of sessionEntries) {
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          files.push(path.join(dir, entry.name));
        }
      }
    } catch {
      continue;
    }
  }

  return files;
}
