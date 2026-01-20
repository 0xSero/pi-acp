import type { SessionState } from "./types";
import type { SessionMapStore } from "./map";
import { scanSessions } from "./metadata";

export async function resolveSessionPath(
  sessions: Map<string, SessionState>,
  sessionMap: SessionMapStore,
  sessionId: string
): Promise<string | null> {
  const active = sessions.get(sessionId);
  if (active?.sessionFile) {
    return active.sessionFile;
  }

  const mapped = await sessionMap.get(sessionId);
  if (mapped) {
    return mapped;
  }

  const { map } = await scanSessions({ cwd: null });
  const resolved = map.get(sessionId) ?? null;
  const mapEntries = Object.fromEntries(map.entries());
  if (Object.keys(mapEntries).length > 0) {
    await sessionMap.merge(mapEntries);
  }
  return resolved;
}

export async function captureSessionFile(
  session: SessionState,
  sessionMap: SessionMapStore,
  logWarn: (message: string) => void
): Promise<void> {
  try {
    const response = await session.pi.request({ type: "get_state" });
    if (!response.success || !response.data || typeof response.data !== "object") {
      return;
    }
    const sessionFile = (response.data as { sessionFile?: unknown }).sessionFile;
    if (typeof sessionFile !== "string") {
      return;
    }
    session.sessionFile = sessionFile;
    await sessionMap.set(session.id, sessionFile);
  } catch (error) {
    logWarn(`session map update failed: ${(error as Error).message}`);
  }
}
