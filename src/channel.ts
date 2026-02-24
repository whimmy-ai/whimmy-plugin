import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import type { OpenClawConfig, OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { getWhimmyRuntime } from './runtime';
import { resolveConnection, resolveConnectionAsync, buildWsUrl, isConfigured as isConfiguredUtil, uploadFile } from './utils';
import { ensureWhimmyAgent } from './sync';
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
} from './types';

// ============ Exec Approval Manager Singleton ============

/**
 * Minimal interface matching ExecApprovalManager.resolve().
 * The full class isn't exported from openclaw/plugin-sdk's barrel,
 * so we type just the method we need.
 */
interface ApprovalManagerLike {
  resolve(recordId: string, decision: 'allow-once' | 'allow-always' | 'deny', resolvedBy?: string | null): boolean;
}

let approvalManager: ApprovalManagerLike | null = null;

export function setApprovalManager(manager: ApprovalManagerLike): void {
  approvalManager = manager;
}

export function getApprovalManager(): ApprovalManagerLike | null {
  return approvalManager;
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

// ============ AskUserQuestion Waiters ============

/** Pending user question answers: questionId → resolve function */
const askUserQuestionWaiters = new Map<string, (answers: Record<string, string>) => void>();

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

  // Clear typing indicator and send chat.done.
  const presenceIdle: ChatPresencePayload = {
    sessionKey: request.sessionKey,
    agentId: request.agentId,
    status: 'idle',
  };
  sendEvent(ws, 'chat.presence', presenceIdle);

  const done: ChatChunkPayload = {
    sessionKey: request.sessionKey,
    agentId: request.agentId,
    content: '',
    done: true,
  };
  sendEvent(ws, 'chat.done', done);
}

async function handleHookApproval(
  request: HookApprovalRequest,
  log?: Logger,
): Promise<void> {
  log?.info?.(`[Whimmy] Approval: execution=${request.executionId} approved=${request.approved}`);

  const manager = getApprovalManager();
  if (!manager) {
    log?.warn?.(`[Whimmy] ExecApprovalManager not yet captured — cannot resolve execution ${request.executionId}`);
    return;
  }

  const decision = request.approved ? 'allow-once' as const : 'deny' as const;
  const resolved = manager.resolve(request.executionId, decision, 'whimmy');

  if (resolved) {
    log?.info?.(`[Whimmy] Resolved execution ${request.executionId} → ${decision}`);
  } else {
    log?.warn?.(`[Whimmy] Failed to resolve execution ${request.executionId} (expired or unknown)`);
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

      const { stopFn } = await connectWebSocket(conn, cfg, account.accountId, ctx);

      // Wire up abort signal.
      if (abortSignal) {
        if (abortSignal.aborted) {
          stopFn();
          throw new Error('Connection aborted before start');
        }
        abortSignal.addEventListener('abort', stopFn);
      }

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

// ============ Tool Lifecycle Hooks ============

/**
 * Register plugin hooks that forward tool lifecycle events to the backend.
 * Called from index.ts during plugin registration.
 */
export function registerWhimmyHooks(api: OpenClawPluginApi): void {
  api.on('before_tool_call', async (event, ctx) => {
    if (!ctx.sessionKey) return;

    // Intercept AskUserQuestion: forward to Whimmy UI and wait for answer.
    if (event.toolName === 'AskUserQuestion' || event.toolName === 'ask_user_question') {
      const questions = (event.params?.questions ?? []) as AskUserQuestion[];
      if (questions.length === 0) return;

      // Extract sessionKey — strip the "agent:{agentId}:direct:" prefix to get
      // the original Whimmy session key.
      const parts = ctx.sessionKey.split(':');
      const whimmySessionKey = parts.length >= 4 ? parts.slice(3).join(':') : ctx.sessionKey;

      try {
        const answers = await askUserQuestion(
          whimmySessionKey,
          ctx.agentId || 'default',
          questions,
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

    // Default: broadcast tool.start lifecycle event.
    const executionId = randomUUID();
    const payload: ToolLifecyclePayload = {
      sessionKey: ctx.sessionKey,
      agentId: ctx.agentId || 'default',
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
