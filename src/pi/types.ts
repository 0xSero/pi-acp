export type PiCommand =
  | {
      type: "prompt";
      message: string;
      images?: PiImageContent[];
      streamingBehavior?: "steer" | "followUp";
    }
  | { type: "steer"; message: string }
  | { type: "follow_up"; message: string }
  | { type: "abort" }
  | { type: "new_session"; parentSession?: string }
  | { type: "get_state" }
  | { type: "get_messages" }
  | { type: "set_model"; provider: string; modelId: string }
  | { type: "cycle_model" }
  | { type: "get_available_models" }
  | {
      type: "set_thinking_level";
      level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
    }
  | { type: "cycle_thinking_level" }
  | { type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
  | { type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }
  | { type: "compact"; customInstructions?: string }
  | { type: "set_auto_compaction"; enabled: boolean }
  | { type: "set_auto_retry"; enabled: boolean }
  | { type: "abort_retry" }
  | { type: "bash"; command: string }
  | { type: "abort_bash" }
  | { type: "get_session_stats" }
  | { type: "export_html"; outputPath?: string }
  | { type: "switch_session"; sessionPath: string }
  | { type: "fork"; entryId: string }
  | { type: "get_fork_messages" }
  | { type: "get_last_assistant_text" };

export type PiCommandWithId = PiCommand & { id?: string };

export interface PiImageContent {
  type: "image";
  source: {
    type: "base64" | "url";
    mediaType: string;
    data: string;
  };
}

export interface PiResponse {
  type: "response";
  command: string;
  success: boolean;
  id?: string;
  data?: unknown;
  error?: string;
}

export type PiEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages?: unknown[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message?: unknown; toolResults?: unknown[] }
  | { type: "message_start"; message?: unknown }
  | {
      type: "message_update";
      message?: PiAssistantMessage;
      assistantMessageEvent?: PiAssistantMessageEvent;
    }
  | { type: "message_end"; message?: PiAssistantMessage }
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args: unknown;
      partialResult?: PiToolResult;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: PiToolResult;
      isError: boolean;
    }
  | { type: "auto_compaction_start"; reason: "threshold" | "overflow" }
  | {
      type: "auto_compaction_end";
      result?: unknown;
      aborted?: boolean;
      willRetry?: boolean;
      errorMessage?: string;
    }
  | {
      type: "auto_retry_start";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage?: string;
    }
  | {
      type: "auto_retry_end";
      success: boolean;
      attempt: number;
      finalError?: string;
    }
  | {
      type: "extension_error";
      extensionPath: string;
      event: string;
      error: string;
    };

export interface PiAssistantMessage {
  role?: string;
  content?: PiAssistantMessageContent[];
  stopReason?: string;
}

export type PiAssistantMessageContent =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: unknown };

export type PiAssistantMessageEvent =
  | { type: "start" }
  | { type: "text_start"; contentIndex: number; partial: unknown }
  | {
      type: "text_delta";
      contentIndex: number;
      delta: string;
      partial: unknown;
    }
  | {
      type: "text_end";
      contentIndex: number;
      content: string;
      partial: unknown;
    }
  | { type: "thinking_start"; contentIndex: number; partial: unknown }
  | {
      type: "thinking_delta";
      contentIndex: number;
      delta: string;
      partial: unknown;
    }
  | {
      type: "thinking_end";
      contentIndex: number;
      content: string;
      partial: unknown;
    }
  | { type: "toolcall_start"; contentIndex: number; partial: unknown }
  | {
      type: "toolcall_delta";
      contentIndex: number;
      delta: string;
      partial: unknown;
    }
  | {
      type: "toolcall_end";
      contentIndex: number;
      toolCall: unknown;
      partial: unknown;
    }
  | { type: "done"; reason: string }
  | { type: "error"; reason: string };

export interface PiToolResult {
  content?: { type: "text"; text: string }[];
  details?: Record<string, unknown>;
}

export type PiLine = PiEvent | PiResponse;

export interface PendingRequest {
  resolve: (response: PiResponse) => void;
  reject: (error: Error) => void;
  timeoutId: NodeJS.Timeout;
}

export interface PiProcessOptions {
  cwd: string;
  piExecutable?: string;
  env?: NodeJS.ProcessEnv;
  args?: string[];
}
