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
  type ListSessionsRequest,
  type ListSessionsResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
} from "@agentclientprotocol/sdk";
import { SessionManager } from "../core/session-manager";

export class AcpAgent implements Agent {
  private readonly connection: AgentSideConnection;
  private readonly sessionManager: SessionManager;

  constructor(connection: AgentSideConnection, sessionManager: SessionManager) {
    this.connection = connection;
    this.sessionManager = sessionManager;
    this.sessionManager.setEmitter((params) => void this.connection.sessionUpdate(params));
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: true,
        },
        mcpCapabilities: { http: false, sse: false },
        sessionCapabilities: {
          list: {},
          resume: {},
        },
      },
      agentInfo: {
        name: "pi-acp",
        title: "Pi ACP",
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
    const { sessionId, models, configOptions } = await this.sessionManager.createSession(
      params.cwd,
      params.mcpServers ?? []
    );
    return {
      sessionId,
      modes: null,
      models,
      configOptions,
    };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    if (!params?.sessionId || !params?.cwd) {
      throw new Error("Missing required params: sessionId, cwd");
    }
    const { models, configOptions } = await this.sessionManager.loadSession(params.sessionId, params.cwd);
    return { modes: null, models, configOptions };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
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

  async unstable_listSessions(_params: ListSessionsRequest): Promise<ListSessionsResponse> {
    const sessions = this.sessionManager.listSessions();
    return {
      sessions: sessions.map((session) => ({
        sessionId: session.sessionId,
        cwd: session.cwd,
      })),
    };
  }

  async unstable_resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    if (!params?.sessionId || !params?.cwd) {
      throw new Error("Missing required params: sessionId, cwd");
    }
    const { models, configOptions } = await this.sessionManager.resumeSession(params.sessionId, params.cwd);
    return { modes: null, models, configOptions };
  }
}
