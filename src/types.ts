import type {
  OpenClawConfig,
  ChannelLogSink as SDKChannelLogSink,
  ChannelAccountSnapshot as SDKChannelAccountSnapshot,
  ChannelGatewayContext as SDKChannelGatewayContext,
  ChannelPlugin as SDKChannelPlugin,
} from 'openclaw/plugin-sdk';

// ============ Plugin Config ============

export interface WhimmyConfig {
  /** Full connection URI: whimmy://{token}@{host} */
  connectionUri?: string;
  /** Explicit host (alternative to connectionUri) */
  host?: string;
  /** Explicit token (alternative to connectionUri) */
  token?: string;
  /** 6-digit pairing code (exchanged for token on first connect) */
  pairingCode?: string;
  /** Use TLS (wss://) — defaults to true */
  tls?: boolean;
  /** Display name for this account */
  name?: string;
  /** Enable/disable this account */
  enabled?: boolean;
  /** Multi-account support */
  accounts?: Record<string, WhimmyConfig>;
}

/** Parsed connection details */
export interface ConnectionInfo {
  host: string;
  token: string;
  tls: boolean;
}

// ============ Wire Protocol (matches Go backend) ============

/** WSEnvelope is the wire format for all WebSocket messages. */
export interface WSEnvelope {
  type: string;
  payload?: unknown;
}

/** AgentConfig carries the agent's settings to OpenClaw. */
export interface AgentConfig {
  model: string;
  temperature: number;
  maxTokens: number;
  systemPrompt?: string;
  mcpTools?: string[];
  proactivity?: string;
}

/** HookAttachment describes a file attached to a user message. */
export interface HookAttachment {
  filePath: string;
  fileUrl?: string;
  mimeType: string;
  fileName: string;
  sizeBytes: number;
}

/** HookAgentRequest — backend sends this when a user sends a message. */
export interface HookAgentRequest {
  message: string;
  agentId: string;
  sessionKey: string;
  channel: string;
  agentConfig: AgentConfig;
  attachments?: HookAttachment[];
}

/** HookApprovalRequest — backend sends this when a user approves/rejects. */
export interface HookApprovalRequest {
  executionId: string;
  approved: boolean;
  reason?: string;
}

/** WebhookEvent — plugin sends these back to the backend. */
export interface WebhookEvent {
  event: string;
  payload: unknown;
}

/** ChatChunkPayload — streaming response chunk sent back to backend. */
export interface ChatChunkPayload {
  sessionKey: string;
  agentId: string;
  content: string;
  done: boolean;
  tokenCount?: number;
  cost?: number;
}

/** ExecApprovalRequestedPayload — approval request sent back to backend. */
export interface ExecApprovalRequestedPayload {
  sessionKey: string;
  agentId: string;
  executionId: string;
  toolName: string;
  action: string;
}

/** ToolLifecyclePayload — tool start/done/error sent back to backend. */
export interface ToolLifecyclePayload {
  sessionKey: string;
  agentId: string;
  executionId: string;
  toolName: string;
  status: string;
}

// ============ Plugin Types ============

export type Logger = SDKChannelLogSink;

export interface ResolvedAccount {
  accountId: string;
  config: WhimmyConfig;
  enabled: boolean;
  configured: boolean;
  name: string | null;
}

export type GatewayStartContext = SDKChannelGatewayContext<ResolvedAccount>;

export interface GatewayStopResult {
  stop: () => void;
}

export type WhimmyChannelPlugin = SDKChannelPlugin<ResolvedAccount>;
