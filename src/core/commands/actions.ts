import { randomUUID } from "node:crypto";
import type { SessionUpdate, ContentBlock, ToolKind } from "@agentclientprotocol/sdk";
import { formatThinkingLevel, refreshSessionConfig, resolveModelId } from "../config/config";
import { THINKING_LEVELS, THINKING_LEVELS_WITH_XHIGH, XHIGH_MODELS } from "../config/consts";
import type { SessionState } from "../session/types";
import { fetchUrl, searchWeb } from "../tools/web-tools";
import { normalizeThinkingLevelInput, parseOnOff } from "./helpers";
import { formatBashResult, formatSessionStats, resolveForkEntryId, type BashResult, type SessionStats } from "./format";
import { handleSessionsCommand, handleLoadCommand } from "./slash";

type EmitUpdate = (sessionId: string, update: SessionUpdate) => void;

export type CommandAction = (session: SessionState, args: string, prompt?: ContentBlock[]) => Promise<void>;

export function createCommandActions(emitUpdate: EmitUpdate): Record<string, CommandAction> {
  const sendText = (session: SessionState, text: string) =>
    emitUpdate(session.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

  const refreshOptions = async (session: SessionState) => {
    const { configOptions } = await refreshSessionConfig(session);
    emitUpdate(session.id, { sessionUpdate: "config_option_update", configOptions: configOptions ?? [] });
  };

  const emitTool = (session: SessionState, title: string, kind: ToolKind, text: string, status: "completed" | "failed") => {
    const toolCallId = `${title}:${randomUUID()}`;
    emitUpdate(session.id, {
      sessionUpdate: "tool_call",
      toolCallId,
      title,
      kind,
      status,
      content: [{ type: "content", content: { type: "text", text } }],
    });
  };

  return {
    compact: async (session, args) => {
      const response = await session.pi.request({ type: "compact", customInstructions: args || undefined });
      sendText(session, response.success ? "Compaction complete." : `Compaction failed: ${response.error ?? "unknown"}`);
    },
    autocompact: async (session, args) =>
      handleToggle(session, args, {
        usage: "/autocompact on|off",
        requestType: "set_auto_compaction",
        successLabel: "Auto compaction",
        failureLabel: "Auto compaction",
      }),
    autoretry: async (session, args) =>
      handleToggle(session, args, {
        usage: "/autoretry on|off",
        requestType: "set_auto_retry",
        successLabel: "Auto retry",
        failureLabel: "Auto retry",
      }),
    export: async (session) => {
      const response = await session.pi.request({ type: "export_html" });
      const pathValue = response.success && response.data && typeof response.data === "object"
        ? (response.data as { path?: string }).path
        : undefined;
      sendText(session, response.success ? `Exported session to ${pathValue ?? "(unknown path)"}.` : `Export failed: ${response.error ?? "unknown"}`);
    },
    session: async (session) => {
      const response = await session.pi.request({ type: "get_session_stats" });
      if (!response.success) {
        sendText(session, `Session stats failed: ${response.error ?? "unknown"}`);
        return;
      }
      const data = response.data && typeof response.data === "object" ? (response.data as SessionStats) : {};
      sendText(session, formatSessionStats(data));
    },
    model: async (session, args) => {
      if (!args) {
        sendText(session, "Usage: /model <provider>:<model-id>");
        return;
      }
      const resolved = resolveModelId(session, args);
      if (!resolved) {
        sendText(session, `Unknown model: ${args}`);
        return;
      }
      const response = await session.pi.request({ type: "set_model", provider: resolved.provider, modelId: resolved.id });
      if (!response.success) {
        sendText(session, response.error ?? "Failed to set model.");
        return;
      }
      await refreshOptions(session);
      sendText(session, `Model set to ${resolved.provider}/${resolved.id}.`);
    },
    thinking: async (session, args) => {
      const currentModel = session.currentModelId ? session.modelMap.get(session.currentModelId) ?? null : null;
      if (!currentModel?.reasoning) {
        sendText(session, "Thinking levels are not available for the current model.");
        return;
      }
      const levels = XHIGH_MODELS.has(currentModel.id) ? THINKING_LEVELS_WITH_XHIGH : THINKING_LEVELS;
      const normalizedArgs = args.toLowerCase();
      if (!args || normalizedArgs === "cycle" || normalizedArgs === "next") {
        const response = await session.pi.request({ type: "cycle_thinking_level" });
        if (!response.success) {
          sendText(session, response.error ?? "Failed to cycle thinking level.");
          return;
        }
        await refreshOptions(session);
        const levelLabel = session.thinkingLevel ? formatThinkingLevel(session.thinkingLevel) : "(unknown)";
        sendText(session, `Thinking level set to ${levelLabel}.`);
        return;
      }
      const normalizedLevel = normalizeThinkingLevelInput(normalizedArgs, levels);
      if (!normalizedLevel) {
        sendText(session, `Usage: /thinking <${levels.join("|")}|cycle>`);
        return;
      }
      const response = await session.pi.request({
        type: "set_thinking_level",
        level: normalizedLevel as "off" | "minimal" | "low" | "medium" | "high" | "xhigh",
      });
      if (!response.success) {
        sendText(session, response.error ?? "Failed to set thinking level.");
        return;
      }
      await refreshOptions(session);
      sendText(session, `Thinking level set to ${formatThinkingLevel(normalizedLevel)}.`);
    },
    "cycle-model": async (session) => {
      const response = await session.pi.request({ type: "cycle_model" });
      if (!response.success) {
        sendText(session, response.error ?? "Failed to cycle model.");
        return;
      }
      const data = response.data as { model?: { provider?: string; id?: string } } | null;
      const modelLabel = data?.model?.provider && data.model.id ? `${data.model.provider}/${data.model.id}` : "(unknown model)";
      await refreshOptions(session);
      sendText(session, `Model set to ${modelLabel}.`);
    },
    bash: async (session, args) => {
      if (!args) {
        sendText(session, "Usage: /bash <command>");
        return;
      }
      const response = await session.pi.request({ type: "bash", command: args });
      if (!response.success) {
        sendText(session, response.error ?? "Bash command failed.");
        return;
      }
      sendText(session, formatBashResult(response.data as BashResult));
    },
    steer: async (session, args) => {
      if (!args) {
        sendText(session, "Usage: /steer <message>");
        return;
      }
      const response = await session.pi.request({ type: "steer", message: args });
      sendText(session, response.success ? "Steering message queued." : `Steer failed: ${response.error ?? "unknown"}`);
    },
    queue: async (session, args) => {
      if (!args) {
        sendText(session, "Usage: /queue <message>");
        return;
      }
      const response = await session.pi.request({ type: "follow_up", message: args });
      sendText(session, response.success ? "Follow-up message queued." : `Queue failed: ${response.error ?? "unknown"}`);
    },
    last: async (session) => {
      const response = await session.pi.request({ type: "get_last_assistant_text" });
      if (!response.success) {
        sendText(session, response.error ?? "Failed to fetch last message.");
        return;
      }
      const textValue = response.data && typeof response.data === "object" ? (response.data as { text?: string | null }).text : null;
      sendText(session, textValue ?? "(no assistant message yet)");
    },
    fork: async (session, args) => {
      const entryId = args || (await resolveForkEntryId(session, sendText));
      if (!entryId) {
        return;
      }
      const response = await session.pi.request({ type: "fork", entryId });
      if (!response.success) {
        sendText(session, response.error ?? "Failed to fork session.");
        return;
      }
      const data = response.data as { text?: string; cancelled?: boolean } | null;
      await refreshOptions(session);
      if (data?.cancelled) {
        sendText(session, "Fork cancelled.");
        return;
      }
      const snippet = data?.text ? data.text.replace(/\s+/g, " ").trim().slice(0, 160) : "";
      const suffix = snippet ? `\nFrom: ${snippet}${data?.text && data.text.length > 160 ? "…" : ""}` : "";
      sendText(session, `Forked session.${suffix}`);
    },
    new: async (session) => {
      const response = await session.pi.request({ type: "new_session" });
      if (!response.success) {
        sendText(session, response.error ?? "Failed to start new session.");
        return;
      }
      const data = response.data as { cancelled?: boolean } | null;
      await refreshOptions(session);
      sendText(session, data?.cancelled ? "New session cancelled." : "New session started.");
    },
    fetch: async (session, args) => {
      if (!args) {
        sendText(session, "Usage: /fetch <url>");
        return;
      }
      try {
        const { text, truncated } = await fetchUrl(args);
        emitTool(session, "fetch", "fetch", `${text}${truncated ? "\n\n(truncated)" : ""}`, "completed");
      } catch (error) {
        emitTool(session, "fetch", "fetch", `Fetch failed: ${(error as Error).message}`, "failed");
      }
    },
    search: async (session, args) => {
      if (!args) {
        sendText(session, "Usage: /search <query>");
        return;
      }
      try {
        const results = await searchWeb(args);
        emitTool(session, "search", "search", results, "completed");
      } catch (error) {
        emitTool(session, "search", "search", `Search failed: ${(error as Error).message}`, "failed");
      }
    },
    sessions: async (session) => {
      await handleSessionsCommand(session, emitUpdate);
    },
    load: async (session, args) => {
      await handleLoadCommand(session, args, emitUpdate);
    },
  };

  async function handleToggle(
    session: SessionState,
    args: string,
    options: {
      usage: string;
      requestType: "set_auto_compaction" | "set_auto_retry";
      successLabel: string;
      failureLabel: string;
    }
  ): Promise<void> {
    const enabled = parseOnOff(args);
    if (enabled === null) {
      sendText(session, `Usage: ${options.usage}`);
      return;
    }
    const response = await session.pi.request({ type: options.requestType, enabled });
    sendText(session, response.success ? `${options.successLabel} ${enabled ? "enabled" : "disabled"}.` : `${options.failureLabel} failed: ${response.error ?? "unknown"}`);
  }
}
