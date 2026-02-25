import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { OpenClawConfig, OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { getWhimmyRuntime } from './runtime';
import { resolveConnection, resolveConnectionAsync, buildWsUrl, isConfigured as isConfiguredUtil, uploadFile } from './utils';
import { ensureWhimmyAgent, collectChangedMemoryFiles } from './sync';
import type {
  WhimmyConfig,
  WhimmyChannelPlugin,
  WSEnvelope,
  HookAgentRequest,
  HookApprovalRequest,
  HookReactRequest,
  HookReadRequest,
  HookAskUserAnswerRequest,
  ChatChunkPayload,
  ChatMediaPayload,
  ChatPresencePayload,
  ChatReactPayload,
  ChatEditPayload,
  ChatDeletePayload,
  ToolLifecyclePayload,
  ExecApprovalRequestedPayload,
  AskUserQuestionPayload,
  AskUserQuestion,
  WebhookEvent,
  ResolvedAccount,
  GatewayStartContext,
  GatewayStopResult,
  Logger,
  ConnectionInfo,
  AgentToolCallPayload,
  ToolResultPayload,
  HistoryMessage,
  AgentInfo,
  AgentConfig,
  AgentMemorySyncPayload,
} from './types';

// ============ Per-Agent Config Cache ============

/** Stores the latest AgentConfig per agentId so hooks can read it. */
const agentConfigCache = new Map<string, AgentConfig>();

/** Get the cached agent config for a given agentId. */
export function getAgentConfig(agentId: string): AgentConfig | undefined {
  return agentConfigCache.get(agentId);
}

// ============ Config Helpers ============

function getConfig(cfg: OpenClawConfig, accountId?: string): WhimmyConfig {
  const whimmyCfg = cfg?.channels?.whimmy as WhimmyConfig | undefined;
  if (!whimmyCfg) return {} as WhimmyConfig;
  if (accountId && whimmyCfg.accounts?.[accountId]) {
    return whimmyCfg.accounts[accountId];
  }
  return whimmyCfg;
}

function isConfigured(config: WhimmyConfig): boolean {
  return isConfiguredUtil(config);
}

// ============ WebSocket Helpers ============

function sendEnvelope(ws: WebSocket, envelope: WSEnvelope): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(envelope));
    return true;
  } catch {
    return false;
  }
}

function sendEvent(ws: WebSocket, event: string, payload: unknown): boolean {
  const webhookEvent: WebhookEvent = { event, payload };
  return sendEnvelope(ws, { type: 'event', payload: webhookEvent });
}

// ============ Tool Result Waiters (Orchestrator Mode) ============

/** Pending tool call results: callId → resolve function */
const toolResultWaiters = new Map<string, (result: ToolResultPayload) => void>();

// ============ Approval Waiters ============

/** Pending approval decisions: executionId → resolve function */
const approvalWaiters = new Map<string, (approved: boolean) => void>();

/** Session-level approval memory: agentId → Set of already-approved tool names */
const sessionApprovals = new Map<string, Set<string>>();

// ============ AskUserQuestion Waiters ============

/** Pending user question answers: questionId → resolve function */
const askUserQuestionWaiters = new Map<string, (answers: Record<string, string>) => void>();

// ============ Cumulative Token Tracking ============

/** Tracks the last known cumulative totalTokens per session key so we can compute deltas. */
const lastCumulativeTokens = new Map<string, number>();

// ============ Model Context Limits ============

/** Resolve the max context window size for a given model identifier. */
function resolveMaxContextTokens(model: string): number {
  const m = model.toLowerCase();
  if (m.includes('opus')) return 200_000;
  if (m.includes('haiku')) return 200_000;
  if (m.includes('sonnet')) return 200_000;
  if (m.includes('gpt-4o')) return 128_000;
  if (m.includes('gpt-4')) return 128_000;
  if (m.includes('o1') || m.includes('o3') || m.includes('o4')) return 200_000;
  // Default fallback.
  return 200_000;
}

// ============ History Formatting ============

function formatHistoryForAgent(history: HistoryMessage[]): string {
  if (!history || history.length === 0) return '';
  const lines = history.map(m => {
    if (m.role === 'user') return `User: ${m.content}`;
    const name = m.agentName || 'Assistant';
    return `Assistant (${name}): ${m.content}`;
  });
  return `[Conversation History]\n${lines.join('\n')}\n[Current Message]\n`;
}

function buildOrchestratorSystemPromptSuffix(agents: AgentInfo[]): string {
  const agentList = agents.map(a => {
    const emoji = a.emoji ? `${a.emoji} ` : '';
    return `- ${emoji}${a.name} (id: ${a.id}): ${a.description}`;
  }).join('\n');

  return `\n\nYou are the orchestrator agent. You coordinate a team of specialist agents.\n` +
    `Available agents:\n${agentList}\n\n` +
    `To delegate a task to an agent, use the \`ask_agent\` tool with the agent's id and a prompt.\n` +
    `Synthesize the specialists' responses into a coherent final answer for the user.`;
}

function buildAskUserQuestionSuffix(): string {
  return `\n\n## AskUserQuestion Tool

You have access to the \`AskUserQuestion\` tool. Use it when you need the user to make a choice or confirm something before proceeding. The user will see a structured questionnaire in the app.

Call it with a JSON object containing a \`questions\` array:
\`\`\`json
{
  "questions": [
    {
      "question": "What kind of project are you building?",
      "header": "Project Type",
      "options": [
        { "label": "Web App", "description": "A browser-based application" },
        { "label": "CLI Tool", "description": "A command-line utility" },
        { "label": "API Service", "description": "A backend REST/GraphQL service" }
      ],
      "multiSelect": false
    }
  ]
}
\`\`\`

Guidelines:
- Use this for decisions with clear, discrete options (not open-ended questions)
- Keep options concise — 2-6 options per question is ideal
- Set \`multiSelect: true\` only when multiple selections make sense`;
}

// ============ Message Handler ============

async function handleHookAgent(
  ws: WebSocket,
  request: HookAgentRequest,
  cfg: OpenClawConfig,
  accountId: string,
  log?: Logger,
): Promise<void> {
  const rt = getWhimmyRuntime();

  log?.info?.(`[Whimmy] Inbound: agent=${request.agentId} session=${request.sessionKey} text="${request.message.slice(0, 80)}..."`);

  // Cache agent config so hooks can read it later.
  agentConfigCache.set(request.agentId, request.agentConfig);

  // Sync Whimmy agent config into OpenClaw (model + system prompt).
  const syncedCfg = await ensureWhimmyAgent(request.agentId, request.agentConfig, log);

  // Construct session key directly — no need for resolveAgentRoute.
  const agentId = request.agentId;
  const sessionKey = `agent:${agentId}:direct:${request.sessionKey}`.toLowerCase();
  const mainSessionKey = `agent:${agentId}:main`.toLowerCase();
  const storePath = rt.channel.session.resolveStorePath(syncedCfg.session?.store, { agentId });

  // Build media fields from attachments (following MS Teams / BlueBubbles pattern).
  const attachments = request.attachments ?? [];
  const mediaPaths = attachments.map(a => a.filePath);
  const mediaUrls = attachments.map(a => a.fileUrl || a.filePath);
  const mediaTypes = attachments.map(a => a.mimeType);

  // Prepend conversation history to the message body if provided.
  const historyPrefix = formatHistoryForAgent(request.history ?? []);
  const bodyForAgent = historyPrefix ? `${historyPrefix}${request.message}` : request.message;

  // Append orchestrator instructions to system prompt if this is the orchestrator.
  if (request.isOrchestrator && request.availableAgents && request.availableAgents.length > 0) {
    const suffix = buildOrchestratorSystemPromptSuffix(request.availableAgents);
    request.agentConfig.systemPrompt = (request.agentConfig.systemPrompt || '') + suffix;
  }

  // Append AskUserQuestion tool instructions if enabled.
  if (request.agentConfig.askUserQuestion?.enabled !== false) {
    request.agentConfig.systemPrompt = (request.agentConfig.systemPrompt || '') +
      buildAskUserQuestionSuffix();
  }

  const ctx = rt.channel.reply.finalizeInboundContext({
    Body: request.message,
    BodyForAgent: bodyForAgent,
    RawBody: request.message,
    CommandBody: request.message,
    From: request.sessionKey,
    To: request.sessionKey,
    SessionKey: sessionKey,
    AccountId: accountId,
    ChatType: 'direct',
    ConversationLabel: `Whimmy ${request.agentId}`,
    SenderName: request.agentId,
    SenderId: request.sessionKey,
    Provider: 'whimmy',
    Surface: 'whimmy',
    MessageSid: randomUUID(),
    Timestamp: Date.now(),
    CommandAuthorized: true,
    OriginatingChannel: 'whimmy',
    OriginatingTo: request.sessionKey,
    ...(mediaPaths.length > 0 ? {
      MediaPath: mediaPaths[0],
      MediaPaths: mediaPaths,
      MediaUrl: mediaUrls[0],
      MediaUrls: mediaUrls,
      MediaType: mediaTypes[0],
      MediaTypes: mediaTypes,
    } : {}),
  });

  // Record session.
  await rt.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctx.SessionKey || sessionKey,
    ctx,
    updateLastRoute: {
      sessionKey: mainSessionKey,
      channel: 'whimmy',
      to: request.sessionKey,
      accountId,
    },
    onRecordError: (err: unknown) => {
      log?.error?.(`[Whimmy] Failed to record inbound session: ${String(err)}`);
    },
  });

  // Send typing indicator.
  const presenceTyping: ChatPresencePayload = {
    sessionKey: request.sessionKey,
    agentId: request.agentId,
    status: 'typing',
  };
  sendEvent(ws, 'chat.presence', presenceTyping);

  // Dispatch to OpenClaw agent and stream responses back.
  let lastPartialText = '';

  try {
    const { dispatcher, replyOptions, markDispatchIdle } =
      rt.channel.reply.createReplyDispatcherWithTyping({
        responsePrefix: '',
        deliver: async (payload: any) => {
          // Handle media attachments.
          const urls: string[] = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
          const connInfo = activeConnections.get(accountId)?.conn;
          for (let url of urls) {
            let fileName = url.split('/').pop()?.split('?')[0] || 'file';
            let mimeType = payload.mimeType || 'application/octet-stream';
            // Upload local files to the backend first.
            if (connInfo && url.startsWith('/')) {
              try {
                const uploaded = await uploadFile(url, connInfo);
                url = uploaded.url;
                fileName = uploaded.fileName;
                mimeType = uploaded.mimeType;
              } catch (err: any) {
                log?.error?.(`[Whimmy] Failed to upload file ${url}: ${err.message}`);
                continue;
              }
            }
            const media: ChatMediaPayload = {
              sessionKey: request.sessionKey,
              agentId: request.agentId,
              mediaUrl: url,
              mimeType,
              fileName,
              audioAsVoice: payload.audioAsVoice ?? false,
            };
            sendEvent(ws, 'chat.media', media);
          }
        },
        onIdle: () => {
          markDispatchIdle();
        },
      });

    await rt.channel.reply.dispatchReplyFromConfig({
      ctx,
      cfg: syncedCfg,
      dispatcher,
      replyOptions: {
        ...replyOptions,
        onPartialReply: (payload: any) => {
          const text = (payload.text || '').trimEnd();
          if (!text || text === lastPartialText) return;

          // Send only the new incremental content.
          const newContent = text.slice(lastPartialText.length);
          lastPartialText = text;

          if (!newContent) return;

          const chunk: ChatChunkPayload = {
            sessionKey: request.sessionKey,
            agentId: request.agentId,
            content: newContent,
            done: false,
          };
          sendEvent(ws, 'chat.chunk', chunk);
        },
      },
    });
  } catch (dispatchErr: any) {
    log?.error?.(`[Whimmy] dispatch error: ${dispatchErr.message}`);
  }

  // Sync changed memory files back to the backend (non-fatal).
  try {
    const workspace = syncedCfg.agents?.defaults?.workspace
      ?? join(homedir(), '.openclaw', 'workspace');
    const agentDir = join(workspace, 'agents', request.agentId);
    const changedFiles = collectChangedMemoryFiles(request.agentId, agentDir, log);

    if (changedFiles) {
      const memoryPayload: AgentMemorySyncPayload = {
        sessionKey: request.sessionKey,
        agentId: request.agentId,
        files: changedFiles,
      };
      sendEvent(ws, 'agent.memory_sync', memoryPayload);
      const fileNames = Object.keys(changedFiles).join(', ');
      log?.info?.(`[Whimmy] Sent memory sync for ${request.agentId}: ${fileNames}`);
    }
  } catch (memErr: any) {
    log?.debug?.(`[Whimmy] Memory sync failed (non-fatal): ${memErr.message}`);
  }

  // Clear typing indicator and send chat.done.
  const presenceIdle: ChatPresencePayload = {
    sessionKey: request.sessionKey,
    agentId: request.agentId,
    status: 'idle',
  };
  sendEvent(ws, 'chat.presence', presenceIdle);

  // Read token usage and context info from session store.
  let tokenCount: number | undefined;
  let cost: number | undefined;
  let context: ChatChunkPayload['context'];
  try {
    const raw = readFileSync(storePath, 'utf-8');
    const store = JSON.parse(raw) as Record<string, {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      contextTokens?: number;
      model?: string;
    }>;
    const storeKey = sessionKey in store ? sessionKey : mainSessionKey;
    const entry = store[storeKey];
    if (entry) {
      const cumulative = entry.totalTokens ?? ((entry.inputTokens ?? 0) + (entry.outputTokens ?? 0));
      const prev = lastCumulativeTokens.get(storeKey) ?? 0;
      const delta = cumulative - prev;
      if (cumulative > 0) lastCumulativeTokens.set(storeKey, cumulative);
      tokenCount = delta > 0 ? delta : undefined;

      if (entry.contextTokens && entry.contextTokens > 0) {
        const maxContext = resolveMaxContextTokens(entry.model ?? request.agentConfig.model);
        context = {
          used: entry.contextTokens,
          max: maxContext,
          percent: Math.round((entry.contextTokens / maxContext) * 100),
        };
      }
    }
  } catch {
    // Session store may not exist yet on first message — ignore.
  }

  const done: ChatChunkPayload = {
    sessionKey: request.sessionKey,
    agentId: request.agentId,
    content: '',
    done: true,
    tokenCount,
    cost,
    context,
  };
  sendEvent(ws, 'chat.done', done);
}

async function handleHookApproval(
  request: HookApprovalRequest,
  log?: Logger,
): Promise<void> {
  log?.info?.(`[Whimmy] Approval: execution=${request.executionId} approved=${request.approved}`);

  const waiter = approvalWaiters.get(request.executionId);
  if (waiter) {
    approvalWaiters.delete(request.executionId);
    waiter(request.approved);
    log?.info?.(`[Whimmy] Resolved approval waiter ${request.executionId} → ${request.approved}`);
  } else {
    log?.warn?.(`[Whimmy] No waiter for approval ${request.executionId} (expired or unknown)`);
  }
}

// ============ Inbound Event Handlers ============

function handleHookReact(
  request: HookReactRequest,
  log?: Logger,
): void {
  log?.info?.(`[Whimmy] Reaction: message=${request.messageId} emoji=${request.emoji}`);
  // Reactions from users are informational — no agent routing needed.
}

function handleHookRead(
  request: HookReadRequest,
  log?: Logger,
): void {
  log?.debug?.(`[Whimmy] Read receipt: session=${request.sessionKey} messageId=${request.messageId ?? 'latest'}`);
}

// ============ Broadcast Helper ============

/** Send an event to all active WebSocket connections. */
function broadcastEvent(event: string, payload: unknown): void {
  for (const { ws } of activeConnections.values()) {
    sendEvent(ws, event, payload);
  }
}

/** Forward an exec.approval.requested event to all connected Whimmy backends. */
export function broadcastApprovalRequest(payload: ExecApprovalRequestedPayload): void {
  broadcastEvent('exec.approval.requested', payload);
}

/**
 * Request approval from the user for a tool call.
 * Sends the request to the app and waits for a response.
 */
export function requestApproval(
  sessionKey: string,
  agentId: string,
  toolName: string,
  params: Record<string, unknown>,
  timeoutMs = 120_000,
): Promise<boolean> {
  const executionId = randomUUID();

  return new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => {
      approvalWaiters.delete(executionId);
      reject(new Error(`Approval timed out after ${timeoutMs}ms (executionId=${executionId})`));
    }, timeoutMs);

    approvalWaiters.set(executionId, (approved) => {
      clearTimeout(timer);
      resolve(approved);
    });

    broadcastApprovalRequest({
      sessionKey,
      agentId,
      executionId,
      toolName,
      action: `${toolName}(${JSON.stringify(params).slice(0, 200)})`,
      params,
    });
  });
}

/** Forward an ask_user_question event to all connected Whimmy backends. */
export function broadcastAskUserQuestion(payload: AskUserQuestionPayload): void {
  broadcastEvent('ask_user_question', payload);
}

/**
 * Send a question to the user and wait for their answer.
 * Returns the answers map keyed by question text → selected label(s).
 */
export function askUserQuestion(
  sessionKey: string,
  agentId: string,
  questions: AskUserQuestion[],
  timeoutMs = 120_000,
): Promise<Record<string, string>> {
  const questionId = randomUUID();

  return new Promise<Record<string, string>>((resolve, reject) => {
    const timer = setTimeout(() => {
      askUserQuestionWaiters.delete(questionId);
      reject(new Error(`AskUserQuestion timed out after ${timeoutMs}ms (questionId=${questionId})`));
    }, timeoutMs);

    askUserQuestionWaiters.set(questionId, (answers) => {
      clearTimeout(timer);
      resolve(answers);
    });

    const payload: AskUserQuestionPayload = {
      sessionKey,
      agentId,
      questionId,
      questions,
    };
    broadcastAskUserQuestion(payload);
  });
}

/** Handle inbound hook.ask_user_answer from the backend. */
function handleHookAskUserAnswer(
  request: HookAskUserAnswerRequest,
  log?: Logger,
): void {
  log?.info?.(`[Whimmy] AskUserAnswer: questionId=${request.questionId}`);

  const waiter = askUserQuestionWaiters.get(request.questionId);
  if (waiter) {
    waiter(request.answers);
    askUserQuestionWaiters.delete(request.questionId);
  } else {
    log?.warn?.(`[Whimmy] No waiter for ask_user_answer questionId=${request.questionId} (expired or unknown)`);
  }
}

// ============ Actions ============

function createWhimmyActions(ws: WebSocket, sessionKey: string, agentId: string) {
  return {
    react(messageId: string, emoji: string): boolean {
      const payload: ChatReactPayload = { sessionKey, agentId, messageId, emoji };
      return sendEvent(ws, 'chat.react', payload);
    },
    edit(messageId: string, content: string): boolean {
      const payload: ChatEditPayload = { sessionKey, agentId, messageId, content };
      return sendEvent(ws, 'chat.edit', payload);
    },
    delete(messageId: string): boolean {
      const payload: ChatDeletePayload = { sessionKey, agentId, messageId };
      return sendEvent(ws, 'chat.delete', payload);
    },
  };
}

// ============ Gateway Connection ============

// Track active connections per account to prevent duplicate connections
// when the framework retries startAccount.
const activeConnections = new Map<string, { ws: WebSocket; conn: ConnectionInfo; stopFn: () => void }>();

async function connectWebSocket(
  conn: ConnectionInfo,
  cfg: OpenClawConfig,
  accountId: string,
  ctx: GatewayStartContext,
): Promise<{ ws: WebSocket; stopFn: () => void }> {
  // If already connected for this account, return the existing connection.
  const existing = activeConnections.get(accountId);
  if (existing && existing.ws.readyState === WebSocket.OPEN) {
    ctx.log?.info?.(`[Whimmy][${accountId}] Already connected, reusing existing connection`);
    ctx.setStatus({
      ...ctx.getStatus(),
      running: true,
      lastError: null,
    });
    return existing;
  }

  const url = buildWsUrl(conn);
  const log = ctx.log;
  let stopped = false;

  log?.info?.(`[Whimmy][${accountId}] Connecting to ${conn.host}...`);

  const ws = new WebSocket(url);

  // Wait for the connection to be established before returning.
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (err: Error) => reject(err));
  });

  log?.info?.(`[Whimmy][${accountId}] Connected`);
  ctx.setStatus({
    ...ctx.getStatus(),
    running: true,
    lastStartAt: Date.now(),
    lastError: null,
  });

  sendEnvelope(ws, { type: 'health' });

  // Send available models to the backend so the mobile app can discover them.
  (async () => {
    try {
      const { execSync } = await import('node:child_process');
      const raw = execSync('openclaw models list --json', { timeout: 5000, encoding: 'utf-8' });
      const parsed = JSON.parse(raw);
      if (parsed.models) {
        sendEvent(ws, 'models.sync', { models: parsed.models });
        log?.info?.(`[Whimmy][${accountId}] Synced ${parsed.models.length} model(s)`);
      }
    } catch (e) {
      log?.debug?.(`[Whimmy][${accountId}] Failed to sync models: ${e}`);
    }
  })();

  ws.on('message', async (data: WebSocket.Data) => {
    if (stopped) return;

    let env: WSEnvelope;
    try {
      env = JSON.parse(data.toString());
    } catch {
      log?.debug?.(`[Whimmy][${accountId}] Bad message: ${data.toString().slice(0, 200)}`);
      return;
    }

    switch (env.type) {
      case 'hook.agent': {
        const request = env.payload as HookAgentRequest;
        try {
          await handleHookAgent(ws, request, cfg, accountId, log);
        } catch (err: any) {
          log?.error?.(`[Whimmy][${accountId}] Error handling hook.agent: ${err.message}`);
          sendEvent(ws, 'chat.done', {
            sessionKey: request.sessionKey,
            agentId: request.agentId,
            content: `Error: ${err.message}`,
            done: true,
          });
        }
        break;
      }
      case 'hook.approval': {
        const request = env.payload as HookApprovalRequest;
        try {
          await handleHookApproval(request, log);
        } catch (err: any) {
          log?.error?.(`[Whimmy][${accountId}] Error handling hook.approval: ${err.message}`);
        }
        break;
      }
      case 'hook.react': {
        const request = env.payload as HookReactRequest;
        handleHookReact(request, log);
        break;
      }
      case 'hook.read': {
        const request = env.payload as HookReadRequest;
        handleHookRead(request, log);
        break;
      }
      case 'hook.ask_user_answer': {
        const request = env.payload as HookAskUserAnswerRequest;
        handleHookAskUserAnswer(request, log);
        break;
      }
      case 'tool.result': {
        const result = env.payload as ToolResultPayload;
        const waiter = toolResultWaiters.get(result.callId);
        if (waiter) {
          waiter(result);
          toolResultWaiters.delete(result.callId);
        } else {
          log?.debug?.(`[Whimmy][${accountId}] No waiter for tool.result callId=${result.callId}`);
        }
        break;
      }
      case 'ping': {
        sendEnvelope(ws, { type: 'pong' });
        break;
      }
      default:
        log?.debug?.(`[Whimmy][${accountId}] Unknown message type: ${env.type}`);
    }
  });

  ws.on('close', (code, reason) => {
    if (stopped) return;

    const reasonStr = reason?.toString() || 'unknown';
    log?.info?.(`[Whimmy][${accountId}] Disconnected: code=${code} reason=${reasonStr}`);

    // Remove from active connections so the next startAccount call creates a fresh one.
    activeConnections.delete(accountId);

    // "replaced" means a newer connection took over — don't signal failure.
    if (reasonStr !== 'replaced') {
      ctx.setStatus({
        ...ctx.getStatus(),
        running: false,
        lastError: `Disconnected: ${code} ${reasonStr}`,
      });
    }
  });

  ws.on('error', (err: Error) => {
    log?.error?.(`[Whimmy][${accountId}] WebSocket error: ${err.message}`);
  });

  const stopFn = () => {
    stopped = true;
    activeConnections.delete(accountId);
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(1000, 'plugin stopping');
    }
    ctx.setStatus({
      ...ctx.getStatus(),
      running: false,
      lastStopAt: Date.now(),
    });
    log?.info?.(`[Whimmy][${accountId}] Stopped`);
  };

  const result = { ws, conn, stopFn };
  activeConnections.set(accountId, result);
  return result;
}

// ============ Channel Plugin Definition ============

export const whimmyPlugin: WhimmyChannelPlugin = {
  id: 'whimmy',
  meta: {
    id: 'whimmy',
    label: 'Whimmy',
    selectionLabel: 'Whimmy',
    docsPath: '/channels/whimmy',
    blurb: 'Whimmy multi-agent messenger channel via WebSocket.',
    aliases: [],
  },
  configSchema: {
    schema: {
      type: 'object',
      properties: {
        connectionUri: { type: 'string', description: 'Connection URI: whimmy://{token}@{host}' },
        host: { type: 'string', description: 'Backend host (default: api.whimmy.ai)' },
        token: { type: 'string', description: 'Connection token (alternative to connectionUri)' },
        pairingCode: { type: 'string', description: '6-digit pairing code from Whimmy mobile app' },
        tls: { type: 'boolean', description: 'Use TLS (default: true)' },
        name: { type: 'string', description: 'Display name for this account' },
        enabled: { type: 'boolean', description: 'Enable/disable this account' },
      },
      additionalProperties: true,
    },
  },
  capabilities: {
    chatTypes: ['direct'] as Array<'direct'>,
    reactions: true,
    edit: true,
    unsend: true,
    threads: false,
    media: true,
    nativeCommands: false,
    blockStreaming: false,
  },
  messaging: {
    targetResolver: {
      looksLikeId: (raw: string) => {
        // Whimmy session keys are 32-char hex strings, optionally followed by "-agentId".
        // Accept anything that starts with a 32+ char hex prefix.
        const trimmed = raw.trim();
        return /^[0-9a-f]{32}/i.test(trimmed);
      },
      hint: 'Use the session key shown in the Whimmy app (32-char hex string).',
    },
  },
  reload: { configPrefixes: ['channels.whimmy'] },
  config: {
    listAccountIds: (cfg: OpenClawConfig): string[] => {
      const config = getConfig(cfg);
      if (config.accounts && Object.keys(config.accounts).length > 0) {
        return Object.keys(config.accounts);
      }
      return isConfigured(config) ? ['default'] : [];
    },
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => {
      const id = accountId || 'default';
      const config = getConfig(cfg, id);
      return {
        accountId: id,
        config,
        enabled: config.enabled !== false,
        configured: isConfigured(config),
        name: config.name || null,
      };
    },
    defaultAccountId: (): string => 'default',
    isConfigured: (account: ResolvedAccount): boolean => isConfigured(account.config),
    describeAccount: (account: ResolvedAccount) => ({
      accountId: account.accountId,
      name: account.name || 'Whimmy',
      enabled: account.enabled,
      configured: account.configured,
    }),
  },
  security: {
    resolveDmPolicy: () => ({
      policy: 'open' as const,
      allowFrom: [],
      policyPath: 'channels.whimmy.dmPolicy',
      allowFromPath: 'channels.whimmy.allowFrom',
      approveHint: 'All Whimmy connections are authenticated via pairing.',
    }),
  },
  actions: {
    listActions: () => ['send', 'sendAttachment', 'react', 'edit', 'unsend'] as any[],
    supportsAction: ({ action }: any) =>
      ['send', 'sendAttachment', 'react', 'edit', 'unsend'].includes(action),
    handleAction: async ({ action, params, cfg, accountId }: any) => {
      const id = accountId ?? 'default';
      const conn = activeConnections.get(id);
      if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
        return { ok: false, error: 'Whimmy not connected' };
      }
      const sessionKey = typeof params.to === 'string' ? params.to : '';
      const agentId = typeof params.agentId === 'string' ? params.agentId : 'default';
      const actions = createWhimmyActions(conn.ws, sessionKey, agentId);

      switch (action) {
        case 'send': {
          const text = typeof params.text === 'string' ? params.text : '';
          if (!text) return { ok: false, error: 'Missing text' };
          const chunk: ChatChunkPayload = {
            sessionKey,
            agentId,
            content: text,
            done: true,
          };
          sendEvent(conn.ws, 'chat.done', chunk);
          return { ok: true };
        }
        case 'react': {
          const messageId = typeof params.messageId === 'string' ? params.messageId : '';
          const emoji = typeof params.emoji === 'string' ? params.emoji : '';
          if (!messageId || !emoji) return { ok: false, error: 'Missing messageId or emoji' };
          actions.react(messageId, emoji);
          return { ok: true };
        }
        case 'edit': {
          const messageId = typeof params.messageId === 'string' ? params.messageId : '';
          const content = typeof params.text === 'string' ? params.text : '';
          if (!messageId || !content) return { ok: false, error: 'Missing messageId or text' };
          actions.edit(messageId, content);
          return { ok: true };
        }
        case 'unsend': {
          const messageId = typeof params.messageId === 'string' ? params.messageId : '';
          if (!messageId) return { ok: false, error: 'Missing messageId' };
          actions.delete(messageId);
          return { ok: true };
        }
        case 'sendAttachment': {
          let mediaUrl = typeof params.mediaUrl === 'string' ? params.mediaUrl : '';
          let fileName = typeof params.fileName === 'string' ? params.fileName : '';
          let mimeType = typeof params.mimeType === 'string' ? params.mimeType : '';
          const filePath = typeof params.filePath === 'string' ? params.filePath : '';

          // If a local file path is provided, upload it to the backend first.
          if (filePath && !mediaUrl) {
            try {
              const uploaded = await uploadFile(filePath, conn.conn);
              mediaUrl = uploaded.url;
              if (!fileName) fileName = uploaded.fileName;
              if (!mimeType) mimeType = uploaded.mimeType;
            } catch (uploadErr: any) {
              return { ok: false, error: `File upload failed: ${uploadErr.message}` };
            }
          }

          if (!mediaUrl) return { ok: false, error: 'Missing mediaUrl or filePath' };
          if (!fileName) fileName = mediaUrl.split('/').pop()?.split('?')[0] || 'file';
          if (!mimeType) mimeType = 'application/octet-stream';

          const media: ChatMediaPayload = {
            sessionKey,
            agentId,
            mediaUrl,
            mimeType,
            fileName,
            audioAsVoice: params.audioAsVoice === true,
          };
          sendEvent(conn.ws, 'chat.media', media);
          // Send caption as a follow-up text message if provided.
          if (typeof params.caption === 'string' && params.caption) {
            const caption: ChatChunkPayload = {
              sessionKey,
              agentId,
              content: params.caption,
              done: true,
            };
            sendEvent(conn.ws, 'chat.done', caption);
          }
          return { ok: true };
        }
        default:
          return { ok: false, error: `Unsupported action: ${action}` };
      }
    },
  } as any,
  outbound: {
    deliveryMode: 'direct' as const,
    resolveTarget: ({ to }: any) => {
      if (!to?.trim()) {
        return { ok: false as const, error: new Error('Whimmy message requires --to <sessionKey>') };
      }
      return { ok: true as const, to: to.trim() };
    },
    sendText: async ({ cfg, to, text, accountId, log }: any) => {
      const id = accountId ?? 'default';
      const conn = activeConnections.get(id);
      if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
        log?.warn?.(`[Whimmy] sendText: not connected (account=${id})`);
        return { channel: 'whimmy', messageId: randomUUID() };
      }
      const chunk: ChatChunkPayload = {
        sessionKey: to,
        agentId: 'default',
        content: text,
        done: true,
      };
      sendEvent(conn.ws, 'chat.done', chunk);
      log?.debug?.(`[Whimmy] sendText: to=${to} text=${text.slice(0, 80)}`);
      return {
        channel: 'whimmy',
        messageId: randomUUID(),
      };
    },
    sendMedia: async (ctx: any) => {
      const { to, accountId, text, mediaUrl } = ctx;
      const log = ctx.log ?? ctx.deps?.log;
      const id = accountId ?? 'default';
      const conn = activeConnections.get(id);
      if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
        log?.warn?.(`[Whimmy] sendMedia: not connected (account=${id})`);
        return { channel: 'whimmy', messageId: randomUUID() };
      }

      let url = mediaUrl || '';
      let fileName = url.split('/').pop()?.split('?')[0] || 'file';
      let mimeType = 'application/octet-stream';

      if (!url) {
        log?.warn?.('[Whimmy] sendMedia: no mediaUrl provided');
        return { channel: 'whimmy', messageId: randomUUID() };
      }

      // Upload local files to the backend first (same pattern as inbound deliver).
      if (url.startsWith('/')) {
        try {
          const uploaded = await uploadFile(url, conn.conn);
          url = uploaded.url;
          fileName = uploaded.fileName;
          mimeType = uploaded.mimeType;
          log?.debug?.(`[Whimmy] sendMedia: uploaded local file → ${url}`);
        } catch (err: any) {
          log?.error?.(`[Whimmy] sendMedia: upload failed for ${mediaUrl}: ${err.message}`);
          return { channel: 'whimmy', messageId: randomUUID() };
        }
      }

      const media: ChatMediaPayload = {
        sessionKey: to,
        agentId: 'default',
        mediaUrl: url,
        mimeType,
        fileName,
        audioAsVoice: false,
      };
      sendEvent(conn.ws, 'chat.media', media);
      log?.debug?.(`[Whimmy] sendMedia: to=${to} file=${fileName}`);

      // Framework passes caption as `text`.
      if (typeof text === 'string' && text.trim()) {
        const chunk: ChatChunkPayload = {
          sessionKey: to,
          agentId: 'default',
          content: text,
          done: true,
        };
        sendEvent(conn.ws, 'chat.done', chunk);
      }

      return {
        channel: 'whimmy',
        messageId: randomUUID(),
      };
    },
  },
  gateway: {
    startAccount: async (ctx: GatewayStartContext): Promise<GatewayStopResult> => {
      const { account, cfg, abortSignal } = ctx;
      const config = account.config;

      const conn = await resolveConnectionAsync(config, ctx.log);
      if (!conn) {
        throw new Error(
          'Whimmy not configured. Set pairingCode (from mobile app), ' +
          'connectionUri (whimmy://{token}@{host}), or host + token.',
        );
      }

      // If we just exchanged a pairing code, persist the token so subsequent
      // restarts don't need the (now-expired) pairing code again.
      if (config.pairingCode && conn.token) {
        try {
          const rt = getWhimmyRuntime();
          const liveCfg = rt.config.loadConfig();
          const whimmyCfg = (liveCfg.channels?.whimmy ?? {}) as WhimmyConfig;

          if (account.accountId !== 'default' && whimmyCfg.accounts?.[account.accountId]) {
            const acct = whimmyCfg.accounts[account.accountId];
            acct.host = conn.host;
            acct.token = conn.token;
            acct.tls = conn.tls;
            delete acct.pairingCode;
          } else {
            (whimmyCfg as any).host = conn.host;
            (whimmyCfg as any).token = conn.token;
            (whimmyCfg as any).tls = conn.tls;
            delete (whimmyCfg as any).pairingCode;
          }

          await rt.config.writeConfigFile(liveCfg);
          ctx.log?.info?.(`[Whimmy] Pairing successful — token persisted to config`);
        } catch (err: any) {
          ctx.log?.warn?.(`[Whimmy] Failed to persist token after pairing: ${err.message}`);
        }
      }

      const { ws, stopFn } = await connectWebSocket(conn, cfg, account.accountId, ctx);

      // Wire up abort signal.
      if (abortSignal) {
        if (abortSignal.aborted) {
          stopFn();
          throw new Error('Connection aborted before start');
        }
        abortSignal.addEventListener('abort', stopFn);
      }

      // Keep alive: wait for the WebSocket to close before returning.
      // This tells the gateway the channel is "running" until disconnection,
      // which enables proper auto-restart on server downtime.
      await new Promise<void>((resolve) => {
        ws.once('close', () => resolve());
      });

      return { stop: stopFn };
    },
  },
  status: {
    defaultRuntime: { accountId: 'default', running: false, lastStartAt: null, lastStopAt: null, lastError: null },
    collectStatusIssues: (accounts: any[]) => {
      return accounts.flatMap((account) => {
        if (!account.configured) {
          return [{
            channel: 'whimmy',
            accountId: account.accountId,
            kind: 'config' as const,
            message: 'Account not configured (set pairingCode, connectionUri, or host+token)',
          }];
        }
        return [];
      });
    },
    buildChannelSummary: ({ snapshot }: any) => ({
      configured: snapshot?.configured ?? false,
      running: snapshot?.running ?? false,
      lastStartAt: snapshot?.lastStartAt ?? null,
      lastStopAt: snapshot?.lastStopAt ?? null,
      lastError: snapshot?.lastError ?? null,
    }),
    probeAccount: async ({ account }: any) => {
      if (!account.configured) {
        return { ok: false, error: 'Not configured' };
      }
      const conn = resolveConnection(account.config);
      if (!conn) {
        return { ok: false, error: 'Invalid connection config' };
      }
      // Just validate that we can resolve connection info — actual WS probe would be heavy.
      return { ok: true, details: { host: conn.host } };
    },
    buildAccountSnapshot: ({ account, runtime, snapshot, probe }: any) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      host: resolveConnection(account.config)?.host ?? null,
      running: runtime?.running ?? snapshot?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? snapshot?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? snapshot?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? snapshot?.lastError ?? null,
      probe,
    }),
  },
};

// ============ Tool Name Aliases ============

/**
 * Map framework-internal tool names to user-facing names used in approval config.
 * The backend sends tools like ["Bash","Write","Edit"], but the framework
 * fires before_tool_call with internal names like "exec".
 */
const TOOL_APPROVAL_ALIASES: Record<string, string> = {
  exec: 'Bash',
};

function toolMatchesApprovalList(toolName: string, toolList: string[]): boolean {
  if (toolList.includes('*')) return true;
  if (toolList.includes(toolName)) return true;
  const alias = TOOL_APPROVAL_ALIASES[toolName];
  if (alias && toolList.includes(alias)) return true;
  return false;
}

// ============ Tool Lifecycle Hooks ============

/**
 * Register plugin hooks that forward tool lifecycle events to the backend.
 * Called from index.ts during plugin registration.
 */
export function registerWhimmyHooks(api: OpenClawPluginApi): void {
  api.on('before_tool_call', async (event, ctx) => {
    api.logger?.debug?.(`[Whimmy] before_tool_call: tool=${event.toolName}`);
    if (!ctx.sessionKey) return;

    // Intercept AskUserQuestion: forward to Whimmy UI and wait for answer.
    if (event.toolName === 'AskUserQuestion' || event.toolName === 'ask_user_question') {
      const agentCfg = agentConfigCache.get(ctx.agentId || 'default');
      const auqConfig = agentCfg?.askUserQuestion;

      // Skip if explicitly disabled.
      if (auqConfig?.enabled === false) return;

      const questions = (event.params?.questions ?? []) as AskUserQuestion[];
      if (questions.length === 0) return;

      // Extract sessionKey — strip the "agent:{agentId}:direct:" prefix to get
      // the original Whimmy session key.
      const parts = ctx.sessionKey.split(':');
      const whimmySessionKey = parts.length >= 4 ? parts.slice(3).join(':') : ctx.sessionKey;

      const timeoutMs = auqConfig?.timeoutMs ?? 120_000;

      try {
        const answers = await askUserQuestion(
          whimmySessionKey,
          ctx.agentId || 'default',
          questions,
          timeoutMs,
        );

        // Return modified params with the user's answers filled in.
        return {
          params: {
            ...event.params,
            answers,
          },
        };
      } catch (err: any) {
        api.logger?.warn?.(`[Whimmy] AskUserQuestion failed: ${err.message}`);
        return {
          block: true,
          blockReason: `User did not respond: ${err.message}`,
        };
      }
    }

    // Approval interception: check if this tool requires user approval.
    const agentId = ctx.agentId || 'default';
    const agentCfg = agentConfigCache.get(agentId);
    const approvalCfg = agentCfg?.approvals;

    if (approvalCfg?.enabled) {
      const toolList = approvalCfg.tools ?? ['*'];
      const needsApproval = toolMatchesApprovalList(event.toolName, toolList);

      if (needsApproval) {
        // Session mode: skip if already approved for this tool in this session.
        if (approvalCfg.mode === 'session') {
          const approved = sessionApprovals.get(agentId);
          if (approved?.has(event.toolName)) {
            // Already approved this session — fall through to lifecycle broadcast.
          } else {
            // Need to ask.
            const parts = ctx.sessionKey.split(':');
            const whimmySessionKey = parts.length >= 4 ? parts.slice(3).join(':') : ctx.sessionKey;
            const timeoutMs = approvalCfg.timeoutMs ?? 120_000;

            try {
              const allowed = await requestApproval(
                whimmySessionKey,
                agentId,
                event.toolName,
                (event.params ?? {}) as Record<string, unknown>,
                timeoutMs,
              );

              if (allowed) {
                // Remember for session mode.
                if (!sessionApprovals.has(agentId)) sessionApprovals.set(agentId, new Set());
                sessionApprovals.get(agentId)!.add(event.toolName);
              } else {
                return { block: true, blockReason: `User denied ${event.toolName}` };
              }
            } catch (err: any) {
              api.logger?.warn?.(`[Whimmy] Approval request failed: ${err.message}`);
              return { block: true, blockReason: `Approval timed out for ${event.toolName}` };
            }
          }
        } else {
          // 'always' mode: ask every time.
          const parts = ctx.sessionKey.split(':');
          const whimmySessionKey = parts.length >= 4 ? parts.slice(3).join(':') : ctx.sessionKey;
          const timeoutMs = approvalCfg.timeoutMs ?? 120_000;

          try {
            const allowed = await requestApproval(
              whimmySessionKey,
              agentId,
              event.toolName,
              (event.params ?? {}) as Record<string, unknown>,
              timeoutMs,
            );

            if (!allowed) {
              return { block: true, blockReason: `User denied ${event.toolName}` };
            }
          } catch (err: any) {
            api.logger?.warn?.(`[Whimmy] Approval request failed: ${err.message}`);
            return { block: true, blockReason: `Approval timed out for ${event.toolName}` };
          }
        }
      }
    }

    // Default: broadcast tool.start lifecycle event.
    const executionId = randomUUID();
    const payload: ToolLifecyclePayload = {
      sessionKey: ctx.sessionKey,
      agentId: agentId,
      executionId,
      toolName: event.toolName,
      status: 'running',
    };
    broadcastEvent('tool.start', payload);
  });

  api.on('after_tool_call', (event, ctx) => {
    if (!ctx.sessionKey) return;
    // Skip lifecycle events for AskUserQuestion — already handled.
    if (event.toolName === 'AskUserQuestion' || event.toolName === 'ask_user_question') return;

    const eventName = event.error ? 'tool.error' : 'tool.done';
    const payload: ToolLifecyclePayload = {
      sessionKey: ctx.sessionKey,
      agentId: ctx.agentId || 'default',
      executionId: '',
      toolName: event.toolName,
      status: event.error ? 'failed' : 'completed',
    };
    broadcastEvent(eventName, payload);
  });
}
