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

/** HistoryMessage represents a message in the conversation history. */
export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
  agentName?: string;
  agentId?: string;
}

/** AgentInfo describes an agent available for orchestrator delegation. */
export interface AgentInfo {
  id: string;
  name: string;
  description: string;
  emoji?: string;
}

/** HookAgentRequest — backend sends this when a user sends a message. */
export interface HookAgentRequest {
  message: string;
  agentId: string;
  sessionKey: string;
  channel: string;
  agentConfig: AgentConfig;
  attachments?: HookAttachment[];
  history?: HistoryMessage[];
  availableAgents?: AgentInfo[];
  isOrchestrator?: boolean;
}

/** AgentToolCallPayload — sent by plugin when orchestrator calls ask_agent. */
export interface AgentToolCallPayload {
  sessionKey: string;
  agentId: string;
  targetAgentId: string;
  prompt: string;
  callId: string;
}

/** ToolResultPayload — sent by backend with the sub-agent's response. */
export interface ToolResultPayload {
  sessionKey: string;
  callId: string;
  content: string;
  agentName: string;
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
  messageId?: string;
  tokenCount?: number;
  cost?: number;
}

/** ChatMediaPayload — file or voice message sent back to backend. */
export interface ChatMediaPayload {
  sessionKey: string;
  agentId: string;
  mediaUrl: string;
  mimeType: string;
  fileName: string;
  audioAsVoice: boolean;
}

/** ChatReactPayload — reaction to a message sent back to backend. */
export interface ChatReactPayload {
  sessionKey: string;
  agentId: string;
  messageId: string;
  emoji: string;
}

/** ChatEditPayload — edit a previously sent message. */
export interface ChatEditPayload {
  sessionKey: string;
  agentId: string;
  messageId: string;
  content: string;
}

/** ChatDeletePayload — delete a previously sent message. */
export interface ChatDeletePayload {
  sessionKey: string;
  agentId: string;
  messageId: string;
}

/** ChatReadPayload — mark messages as read. */
export interface ChatReadPayload {
  sessionKey: string;
  agentId: string;
  messageId?: string;
}

/** ChatPresencePayload — typing indicator / presence status. */
export interface ChatPresencePayload {
  sessionKey: string;
  agentId: string;
  status: 'typing' | 'idle' | 'thinking';
}

/** HookReactRequest — backend sends this when a user reacts to a message. */
export interface HookReactRequest {
  sessionKey: string;
  agentId: string;
  messageId: string;
  emoji: string;
}

/** HookReadRequest — backend sends this when a user reads messages. */
export interface HookReadRequest {
  sessionKey: string;
  agentId: string;
  messageId?: string;
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
