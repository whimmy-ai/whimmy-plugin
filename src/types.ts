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
  /** Per-agent skill allowlist. Omit = all skills; empty array = none. */
  skills?: string[];
  /** Global skill entries to sync (enable/disable, API keys, env vars). */
  skillEntries?: Record<string, SkillEntryConfig>;
  /** Approval settings — controls whether exec commands require user approval via Whimmy. */
  approvals?: ApprovalConfig;
  /** AskUserQuestion settings — controls interactive question forwarding to Whimmy. */
  askUserQuestion?: AskUserQuestionConfig;
}

/** SkillEntryConfig — per-skill configuration synced from Whimmy. */
export interface SkillEntryConfig {
  enabled?: boolean;
  apiKey?: string;
  env?: Record<string, string>;
  config?: Record<string, unknown>;
}

/** ApprovalConfig — controls tool approval forwarding to Whimmy. */
export interface ApprovalConfig {
  /** Enable approval flow. Default: false. */
  enabled?: boolean;
  /** 'always' = every matched tool call needs approval, 'session' = approve once per session. */
  mode?: 'session' | 'always';
  /** Tool names that require approval. Omit or ['*'] = all tools. */
  tools?: string[];
  /** Timeout in ms before auto-denying. Default: 120000 (2 min). */
  timeoutMs?: number;
}

/** AskUserQuestionConfig — controls AskUserQuestion interception. */
export interface AskUserQuestionConfig {
  enabled?: boolean;
  /** Timeout in milliseconds before auto-blocking. Default: 120000 (2 min). */
  timeoutMs?: number;
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
  /** Context window usage stats (only on chat.done). */
  context?: ContextUsage;
}

/** ContextUsage — how full the agent's context window is. */
export interface ContextUsage {
  /** Current context tokens used. */
  used: number;
  /** Max context tokens for the model. */
  max: number;
  /** Percentage of context used (0-100). */
  percent: number;
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

// ============ AskUserQuestion Protocol ============

/** Option in a multiple-choice question. */
export interface AskUserQuestionOption {
  label: string;
  description: string;
  markdown?: string;
}

/** A single question with options. */
export interface AskUserQuestion {
  question: string;
  header: string;
  options: AskUserQuestionOption[];
  multiSelect: boolean;
}

/** AskUserQuestionPayload — sent to backend when agent needs user input. */
export interface AskUserQuestionPayload {
  sessionKey: string;
  agentId: string;
  questionId: string;
  questions: AskUserQuestion[];
}

/** HookAskUserAnswerRequest — backend sends this with the user's answers. */
export interface HookAskUserAnswerRequest {
  questionId: string;
  answers: Record<string, string>;
}

/** ExecApprovalRequestedPayload — approval request sent back to backend. */
export interface ExecApprovalRequestedPayload {
  sessionKey: string;
  agentId: string;
  executionId: string;
  toolName: string;
  action: string;
  /** Tool call parameters — so the app can show what exactly is being requested. */
  params?: Record<string, unknown>;
}

/** MemoryFileEntry — a single memory file with content and hash. */
export interface MemoryFileEntry {
  content: string;
  hash: string;
}

/** AgentMemorySyncPayload — syncs changed memory files to the backend. */
export interface AgentMemorySyncPayload {
  sessionKey: string;
  agentId: string;
  files: Record<string, MemoryFileEntry>;
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
