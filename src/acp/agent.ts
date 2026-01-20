import {
  Agent,
  AgentSideConnection,
  PROTOCOL_VERSION,
  type InitializeRequest,
  type InitializeResponse,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type CancelNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModelRequest,
  type SetSessionModelResponse,
  type ForkSessionRequest,
  type ForkSessionResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
} from "@agentclientprotocol/sdk";
import { SessionManager } from "../core/session/manager";
import { logInfo } from "../logger";

export class AcpAgent implements Agent {
  private readonly connection: AgentSideConnection;
  private readonly sessionManager: SessionManager;

  constructor(connection: AgentSideConnection, sessionManager: SessionManager) {
    this.connection = connection;
    this.sessionManager = sessionManager;
    this.sessionManager.setEmitter((params) => {
      if (params.update.sessionUpdate === "session_info_update") {
        const { title, updatedAt } = params.update;
        logInfo(
          `session_info_update id=${params.sessionId} title=${title ?? ""} updatedAt=${updatedAt ?? ""}`
        );
      }
      if (params.update.sessionUpdate === "available_commands_update") {
        logInfo(`available_commands_update id=${params.sessionId}`);
      }
      void this.connection.sessionUpdate(params);
    });
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    logInfo("initialize");
    return {
      protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: true,
        },
        mcpCapabilities: { http: true, sse: true },
        sessionCapabilities: {
          list: {},
          resume: {},
          fork: {},
        },
      },
      agentInfo: {
        name: "pi-rpc-acp",
        title: "Pi RPC ACP",
        version: "0.1.0",
        _meta: {
          icon: "@pi-rpc-acp-adapter/logo.svg",
        },
      },
      authMethods: [],
    };
  }

  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
    return {};
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    if (!params?.cwd) {
      throw new Error("Missing required param: cwd");
    }
    logInfo(`session/new cwd=${params.cwd}`);
    const { sessionId, models, configOptions } = await this.sessionManager.createSession(
      params.cwd,
      params.mcpServers ?? []
    );
    return {
      sessionId,
      modes: null,
      models,
      configOptions: configOptions ?? [],
    };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    if (!params?.sessionId || !params?.cwd) {
      throw new Error("Missing required params: sessionId, cwd");
    }
    logInfo(`session/load id=${params.sessionId} cwd=${params.cwd}`);
    const { models, configOptions } = await this.sessionManager.loadSession(
      params.sessionId,
      params.cwd,
      params.mcpServers ?? []
    );
    return { modes: null, models, configOptions: configOptions ?? [] };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    logInfo(`session/prompt id=${params.sessionId} blocks=${params.prompt?.length ?? 0}`);
    const stopReason = await this.sessionManager.prompt(params.sessionId, params.prompt);
    return { stopReason };
  }

  async cancel(params: CancelNotification): Promise<void> {
    await this.sessionManager.cancel(params.sessionId);
  }

  async unstable_setSessionModel(params: SetSessionModelRequest): Promise<SetSessionModelResponse> {
    await this.sessionManager.setModel(params.sessionId, params.modelId);
    return {};
  }

  async unstable_setSessionConfigOption(
    params: SetSessionConfigOptionRequest
  ): Promise<SetSessionConfigOptionResponse> {
    return await this.sessionManager.setConfigOption(params);
  }

  async unstable_listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    logInfo("session/list");
    const sessions = await this.sessionManager.listSessions(params);
    return { sessions };
  }

  async unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
    if (!params?.sessionId || !params?.cwd) {
      throw new Error("Missing required params: sessionId, cwd");
    }
    logInfo(`session/fork source=${params.sessionId} cwd=${params.cwd}`);
    const { sessionId, models, configOptions } = await this.sessionManager.forkSession(
      params.sessionId,
      params.cwd,
      params.mcpServers ?? []
    );
    return { sessionId, modes: null, models, configOptions: configOptions ?? [] };
  }

  async unstable_resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    if (!params?.sessionId || !params?.cwd) {
      throw new Error("Missing required params: sessionId, cwd");
    }
    logInfo(`session/resume id=${params.sessionId} cwd=${params.cwd}`);
    const { models, configOptions } = await this.sessionManager.resumeSession(
      params.sessionId,
      params.cwd,
      params.mcpServers ?? []
    );
    return { modes: null, models, configOptions: configOptions ?? [] };
  }
}
