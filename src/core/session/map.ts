import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type SessionMap = Record<string, { piSessionPath: string }>;

export class SessionMapStore {
  private readonly mapPath: string;

  constructor(mapPath: string) {
    this.mapPath = mapPath;
  }

  async get(sessionId: string): Promise<string | null> {
    const map = await this.read();
    return map[sessionId]?.piSessionPath ?? null;
  }

  async set(sessionId: string, piSessionPath: string): Promise<void> {
    const map = await this.read();
    map[sessionId] = { piSessionPath };
    await mkdir(path.dirname(this.mapPath), { recursive: true });
    await writeFile(this.mapPath, JSON.stringify(map, null, 2));
  }

  async getAll(): Promise<SessionMap> {
    return await this.read();
  }

  async setAll(map: SessionMap): Promise<void> {
    await mkdir(path.dirname(this.mapPath), { recursive: true });
    await writeFile(this.mapPath, JSON.stringify(map, null, 2));
  }

  async merge(entries: Record<string, string>): Promise<void> {
    const map = await this.read();
    let changed = false;
    for (const [sessionId, piSessionPath] of Object.entries(entries)) {
      if (map[sessionId]?.piSessionPath === piSessionPath) {
        continue;
      }
      map[sessionId] = { piSessionPath };
      changed = true;
    }
    if (!changed) {
      return;
    }
    await mkdir(path.dirname(this.mapPath), { recursive: true });
    await writeFile(this.mapPath, JSON.stringify(map, null, 2));
  }

  private async read(): Promise<SessionMap> {
    try {
      const raw = await readFile(this.mapPath, "utf8");
      const data = JSON.parse(raw) as SessionMap;
      return data ?? {};
    } catch {
      return {};
    }
  }
}
