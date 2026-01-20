import { scanSessions } from "../session/metadata";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { SessionState } from "../session/types";

type EmitUpdate = (sessionId: string, update: SessionUpdate) => void;

export async function handleSessionsCommand(session: SessionState, emitUpdate: EmitUpdate): Promise<void> {
  const { sessions } = await scanSessions({ cwd: null });

  if (sessions.length === 0) {
    emitUpdate(session.id, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "No sessions found." },
    });
    return;
  }

  const sortedSessions = sessions
    .sort((a, b) => b.modifiedMs - a.modifiedMs)
    .slice(0, 20);

  const header = [`## Sessions`, `Showing last ${sortedSessions.length} session${sortedSessions.length === 1 ? "" : "s"}:\n`].join("\n");
  const tableHeader = `| # | ID | Updated | Title |\n| --- | --- | --- | --- |`;
  const items = sortedSessions.map((s, idx) => {
    const title = s.title?.trim() || "(no title)";
    const date = s.updatedAt ? formatDate(s.updatedAt) : "(unknown)";
    const num = idx + 1;
    const shortId = s.sessionId.slice(0, 8);
    const titleTruncated = truncate(title, 70);
    return `| ${num} | \`${shortId}\` | ${date} | ${titleTruncated} |`;
  }).join("\n");

  const footer = `\n**Tip:** Use \`/load <num>\` to load a session (e.g., \`/load 1\`).`;

  emitUpdate(session.id, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: `${header}\n${tableHeader}\n${items}${footer}` },
  });
}

export async function handleLoadCommand(session: SessionState, args: string, emitUpdate: EmitUpdate): Promise<void> {
  const trimmed = args.trim();
  if (!trimmed) {
    emitUpdate(session.id, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Usage: `/load <number>`\n\nUse `/sessions` to see available sessions." },
    });
    return;
  }

  const { sessions } = await scanSessions({ cwd: null });
  const sortedSessions = sessions.sort((a, b) => b.modifiedMs - a.modifiedMs);

  let targetSession: {
    sessionId: string;
    title?: string | null;
    cwd?: string;
    filePath: string;
    updatedAt?: string;
    messageCount?: number;
  } | null = null;

  const num = parseInt(trimmed, 10);
  if (!isNaN(num) && num >= 1 && num <= sortedSessions.length) {
    targetSession = sortedSessions[num - 1];
  } else {
    targetSession = sessions.find((s) =>
      s.sessionId.startsWith(trimmed) || s.sessionId === trimmed
    ) ?? null;
  }

  if (!targetSession) {
    emitUpdate(session.id, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `Session not found: \`${trimmed}\`\n\nUse \`/sessions\` to see available sessions.` },
    });
    return;
  }

  const title = targetSession.title?.trim() || "(no title)";
  const sessionPath = targetSession.filePath ?? "";
  if (!sessionPath) {
    emitUpdate(session.id, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `Session file path not available.` },
    });
    return;
  }

  // Send immediate feedback
  emitUpdate(session.id, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: `Loading session: \`${targetSession.sessionId.slice(0, 8)}\`…\n` },
  });

  const response = await session.pi.request({
    type: "switch_session",
    sessionPath,
  }, 30000);

  if (!response.success) {
    emitUpdate(session.id, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `Failed to load session: ${response.error ?? "unknown error"}` },
    });
    return;
  }

  const updated = targetSession.updatedAt ? formatDate(targetSession.updatedAt) : "(unknown)";
  const messageCount = typeof targetSession.messageCount === "number" ? targetSession.messageCount : 0;
  emitUpdate(session.id, {
    sessionUpdate: "agent_message_chunk",
    content: {
      type: "text",
      text: [
        `✓ Loaded session: \`${targetSession.sessionId.slice(0, 8)}\``,
        `Title: ${truncate(title, 80)}`,
        `Updated: ${updated}`,
        `Messages: ${messageCount}`,
      ].join("\n"),
    },
  });
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 1).trimEnd() + "…";
}

function formatDate(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  const localeDate = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (date.getFullYear() === now.getFullYear()) return localeDate;
  return `${localeDate}, ${date.getFullYear()}`;
}
