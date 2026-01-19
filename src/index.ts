import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { AcpAgent } from "./acp/agent";
import { SessionManager } from "./core/session-manager";

const sessionManager = new SessionManager();

const input = Writable.toWeb(process.stdout);
const output = Readable.toWeb(process.stdin);
const stream = ndJsonStream(input, output);

new AgentSideConnection(
  (connection) => new AcpAgent(connection, sessionManager),
  stream,
);
