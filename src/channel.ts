import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import type { OpenClawConfig, OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { getWhimmyRuntime } from './runtime';
import { resolveConnection, resolveConnectionAsync, buildWsUrl, isConfigured as isConfiguredUtil } from './utils';
import type {
  WhimmyConfig,
  WhimmyChannelPlugin,
  WSEnvelope,
  HookAgentRequest,
  HookApprovalRequest,
  HookReactRequest,
  HookReadRequest,
  ChatChunkPayload,
  ChatMediaPayload,
  ChatPresencePayload,
  ChatReactPayload,
  ChatEditPayload,
  ChatDeletePayload,
  ToolLifecyclePayload,
  ExecApprovalRequestedPayload,
  WebhookEvent,
  ResolvedAccount,
  GatewayStartContext,
  GatewayStopResult,
  Logger,
  ConnectionInfo,
} from './types';

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

  // Route to the correct OpenClaw agent.
  const route = rt.channel.routing.resolveAgentRoute({
    cfg,
    channel: 'whimmy',
    accountId,
    peer: { kind: 'direct', id: request.sessionKey },
  });

  const storePath = rt.channel.session.resolveStorePath(cfg.session?.store, { agentId: route.agentId });

  // Build media fields from attachments (following MS Teams / BlueBubbles pattern).
  const attachments = request.attachments ?? [];
  const mediaPaths = attachments.map(a => a.filePath);
  const mediaUrls = attachments.map(a => a.fileUrl || a.filePath);
  const mediaTypes = attachments.map(a => a.mimeType);

  const ctx = rt.channel.reply.finalizeInboundContext({
    Body: request.message,
    BodyForAgent: request.message,
    RawBody: request.message,
    CommandBody: request.message,
    From: request.sessionKey,
    To: request.sessionKey,
    SessionKey: request.sessionKey,
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
    sessionKey: ctx.SessionKey || route.sessionKey,
    ctx,
    updateLastRoute: {
      sessionKey: route.mainSessionKey,
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
  let dispatchResult: { queuedFinal: boolean; counts: Record<string, number> } | null = null;

  try {
    dispatchResult = await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx,
      cfg,
      dispatcherOptions: {
        responsePrefix: '',
        deliver: async (payload: any) => {
          // Handle media attachments.
          const urls: string[] = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
          for (const url of urls) {
            const fileName = url.split('/').pop()?.split('?')[0] || 'file';
            const media: ChatMediaPayload = {
              sessionKey: request.sessionKey,
              agentId: request.agentId,
              mediaUrl: url,
              mimeType: payload.mimeType || 'application/octet-stream',
              fileName,
              audioAsVoice: payload.audioAsVoice ?? false,
            };
            sendEvent(ws, 'chat.media', media);
          }

          // Handle text content.
          const text = (payload.markdown || payload.text || '').trimEnd();
          if (!text) return;

          const chunk: ChatChunkPayload = {
            sessionKey: request.sessionKey,
            agentId: request.agentId,
            content: text,
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
  const rt = getWhimmyRuntime();

  log?.info?.(`[Whimmy] Approval: execution=${request.executionId} approved=${request.approved}`);

  // TODO: Route approval resolution back into OpenClaw's execution engine.
  // This depends on how OpenClaw exposes approval resolution to channel plugins.
  // For now, log it — the exact API will depend on the OpenClaw SDK version.
  log?.debug?.(`[Whimmy] Approval resolution for ${request.executionId}: approved=${request.approved}, reason=${request.reason}`);
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
const activeConnections = new Map<string, { ws: WebSocket; stopFn: () => void }>();

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

  const result = { ws, stopFn };
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
    blockStreaming: true,
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
          const mediaUrl = typeof params.mediaUrl === 'string' ? params.mediaUrl : '';
          if (!mediaUrl) return { ok: false, error: 'Missing mediaUrl' };
          const fileName = typeof params.fileName === 'string' ? params.fileName : mediaUrl.split('/').pop()?.split('?')[0] || 'file';
          const media: ChatMediaPayload = {
            sessionKey,
            agentId,
            mediaUrl,
            mimeType: typeof params.mimeType === 'string' ? params.mimeType : 'application/octet-stream',
            fileName,
            audioAsVoice: params.audioAsVoice === true,
          };
          sendEvent(conn.ws, 'chat.media', media);
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
      // Outbound from OpenClaw CLI → send as chat.done through the WS.
      // This is handled by the gateway connection, not a standalone HTTP call.
      // For now, log it. The gateway dispatchReply handles the normal flow.
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
  api.on('before_tool_call', (event, ctx) => {
    if (!ctx.sessionKey) return;
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
