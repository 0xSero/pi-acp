import { logWarn } from "../logger";
import { PiProcess } from "../pi/process";
import { PiResponse } from "../pi/types";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { SessionConfigResult, SessionState, PiModel } from "./types";
import { THINKING_LEVELS_WITH_XHIGH, XHIGH_MODELS, THINKING_LEVELS } from "./session-consts";

export function createSessionState(id: string, cwd: string, pi: PiProcess): SessionState {
  return {
    id,
    cwd,
    pi,
    toolCallSnapshots: new Map(),
    modelMap: new Map(),
  };
}

export async function refreshSessionConfig(session: SessionState): Promise<SessionConfigResult> {
  const [stateResponse, modelsResponse] = await Promise.all([
    safePiRequest(session, { type: "get_state" }),
    safePiRequest(session, { type: "get_available_models" }),
  ]);

  const stateData = extractStateData(stateResponse);
  const availableModels = extractAvailableModels(modelsResponse);

  const currentModel = stateData?.model ?? null;
  if (
    currentModel &&
    !availableModels.some(
      (model) => model.id === currentModel.id && model.provider === currentModel.provider
    )
  ) {
    availableModels.unshift(currentModel);
  }

  session.modelMap.clear();
  for (const model of availableModels) {
    session.modelMap.set(encodeModelId(model), model);
  }

  const currentModelId = currentModel
    ? encodeModelId(currentModel)
    : availableModels[0]
      ? encodeModelId(availableModels[0])
      : undefined;

  session.currentModelId = currentModelId;
  session.thinkingLevel = stateData?.thinkingLevel ?? session.thinkingLevel ?? "off";
  session.steeringMode = stateData?.steeringMode ?? session.steeringMode ?? "all";
  session.followUpMode = stateData?.followUpMode ?? session.followUpMode ?? "one-at-a-time";
  session.autoCompactionEnabled =
    stateData?.autoCompactionEnabled ?? session.autoCompactionEnabled ?? false;
  session.autoRetryEnabled = stateData?.autoRetryEnabled ?? session.autoRetryEnabled ?? false;

  const models = currentModelId
    ? {
        currentModelId,
        availableModels: availableModels.map((model) => ({
          modelId: encodeModelId(model),
          name: model.name,
          description: `${model.provider}/${model.id}`,
        })),
      }
    : null;

  const configOptions = buildConfigOptions(
    session,
    currentModel ?? (currentModelId ? session.modelMap.get(currentModelId) ?? null : null)
  );
  session.configOptions = configOptions ?? undefined;

  return { models, configOptions: configOptions ?? null };
}

export function resolveModelId(session: SessionState, modelId: string): PiModel | null {
  const direct = session.modelMap.get(modelId);
  if (direct) {
    return direct;
  }

  const colonParts = modelId.split(":");
  if (colonParts.length >= 2) {
    const provider = colonParts[0];
    const id = colonParts.slice(1).join(":");
    return { id, provider, name: id };
  }

  const slashParts = modelId.split("/");
  if (slashParts.length >= 2) {
    const provider = slashParts[0];
    const id = slashParts.slice(1).join("/");
    return { id, provider, name: id };
  }

  for (const model of session.modelMap.values()) {
    if (model.id === modelId) {
      return model;
    }
  }

  return null;
}

function buildConfigOptions(session: SessionState, model: PiModel | null): SessionConfigOption[] | null {
  const options: SessionConfigOption[] = [];

  if (model?.reasoning) {
    const availableLevels = XHIGH_MODELS.has(model.id) ? THINKING_LEVELS_WITH_XHIGH : THINKING_LEVELS;
    const currentLevel = normalizeThinkingLevel(session.thinkingLevel, availableLevels);

    const normalizedLevel = currentLevel ?? availableLevels[0];
    session.thinkingLevel = normalizedLevel;

    options.push({
      type: "select",
      id: "reasoning_effort",
      name: "Reasoning Effort",
      description: "Choose how much reasoning to apply",
      category: "thought_level",
      currentValue: normalizedLevel,
      options: availableLevels.map((level) => ({ value: level, name: formatThinkingLevel(level) })),
    });
  }

  options.push({
    type: "select",
    id: "steering_mode",
    name: "Steering Mode",
    description: "How to deliver steering messages",
    category: "other",
    currentValue: session.steeringMode ?? "all",
    options: [
      { value: "all", name: "All at once" },
      { value: "one-at-a-time", name: "One at a time" },
    ],
  });

  options.push({
    type: "select",
    id: "follow_up_mode",
    name: "Follow-up Mode",
    description: "How to deliver follow-up messages",
    category: "other",
    currentValue: session.followUpMode ?? "one-at-a-time",
    options: [
      { value: "all", name: "All at once" },
      { value: "one-at-a-time", name: "One at a time" },
    ],
  });

  options.push({
    type: "select",
    id: "auto_compaction",
    name: "Auto Compaction",
    description: "Automatically compact when context is full",
    category: "other",
    currentValue: session.autoCompactionEnabled ? "on" : "off",
    options: [
      { value: "on", name: "On" },
      { value: "off", name: "Off" },
    ],
  });

  options.push({
    type: "select",
    id: "auto_retry",
    name: "Auto Retry",
    description: "Automatically retry on transient errors",
    category: "other",
    currentValue: session.autoRetryEnabled ? "on" : "off",
    options: [
      { value: "on", name: "On" },
      { value: "off", name: "Off" },
    ],
  });

  return options.length > 0 ? options : null;
}

function normalizeThinkingLevel(level: string | undefined, availableLevels: readonly string[]): string | undefined {
  if (!level) {
    return undefined;
  }
  return availableLevels.includes(level) ? level : undefined;
}

export function formatThinkingLevel(level: string): string {
  if (level === "xhigh") {
    return "Extra High";
  }
  return level.charAt(0).toUpperCase() + level.slice(1);
}

function encodeModelId(model: PiModel): string {
  return `${model.provider}:${model.id}`;
}

function extractStateData(
  response: PiResponse | null
): {
  model: PiModel | null;
  thinkingLevel?: string;
  steeringMode?: "all" | "one-at-a-time";
  followUpMode?: "all" | "one-at-a-time";
  autoCompactionEnabled?: boolean;
  autoRetryEnabled?: boolean;
} | null {
  if (!response?.success || !response.data || typeof response.data !== "object") {
    return null;
  }
  const data = response.data as {
    model?: PiModel | null;
    thinkingLevel?: string;
    steeringMode?: "all" | "one-at-a-time";
    followUpMode?: "all" | "one-at-a-time";
    autoCompactionEnabled?: boolean;
    autoRetryEnabled?: boolean;
  };
  return {
    model: data.model ?? null,
    thinkingLevel: data.thinkingLevel,
    steeringMode: data.steeringMode,
    followUpMode: data.followUpMode,
    autoCompactionEnabled: data.autoCompactionEnabled,
    autoRetryEnabled: data.autoRetryEnabled,
  };
}

function extractAvailableModels(response: PiResponse | null): PiModel[] {
  if (!response?.success || !response.data || typeof response.data !== "object") {
    return [];
  }
  const data = response.data as { models?: PiModel[] };
  return Array.isArray(data.models) ? data.models : [];
}

async function safePiRequest(
  session: SessionState,
  command: Parameters<PiProcess["request"]>[0]
): Promise<PiResponse | null> {
  try {
    return await session.pi.request(command);
  } catch (error) {
    logWarn(`pi request failed (${command.type}): ${(error as Error).message}`);
    return null;
  }
}
