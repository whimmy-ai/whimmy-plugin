import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { whimmyPlugin, registerWhimmyHooks, setApprovalManager, broadcastApprovalRequest } from './src/channel';
import { setWhimmyRuntime } from './src/runtime';
import { registerWhimmyCli } from './src/setup';

/**
 * Connect to the local gateway, call whimmy.approval.init to capture the
 * ExecApprovalManager, then disconnect. Minimal handshake — no retries.
 */
function captureApprovalManager(port: number, token: string | undefined): void {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  let done = false;
  const connectId = randomUUID();
  const initId = randomUUID();

  const cleanup = () => {
    if (done) return;
    done = true;
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(1000, 'init done');
    }
  };

  // Timeout if the whole flow takes too long.
  const timer = setTimeout(cleanup, 5_000);

  ws.on('open', () => {
    // Send the connect handshake.
    ws.send(JSON.stringify({
      type: 'req',
      id: connectId,
      method: 'connect',
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: 'gateway-client',
          displayName: 'Whimmy Approval Init',
          version: 'dev',
          platform: process.platform,
          mode: 'backend',
        },
        scopes: ['operator.approvals'],
        ...(token ? { auth: { token } } : {}),
      },
    }));
  });

  ws.on('message', (data: WebSocket.Data) => {
    if (done) return;
    let frame: any;
    try { frame = JSON.parse(data.toString()); } catch { return; }

    // Response frames: { type: "res", id, ok, payload? }
    if (frame.type === 'res' && frame.id === connectId && frame.ok) {
      // hello_ok received — now send the init request.
      ws.send(JSON.stringify({
        type: 'req',
        id: initId,
        method: 'whimmy.approval.init',
        params: {},
      }));
    } else if (frame.type === 'res' && frame.id === initId) {
      // Manager captured, we're done.
      clearTimeout(timer);
      cleanup();
    }
  });

  ws.on('error', () => { clearTimeout(timer); cleanup(); });
  ws.on('close', () => { clearTimeout(timer); done = true; });
}

const plugin = {
  id: 'whimmy',
  name: 'Whimmy Channel',
  description: 'Whimmy multi-agent messenger channel via WebSocket',
  configSchema: { schema: { type: 'object', properties: {}, additionalProperties: true } },
  register(api: OpenClawPluginApi): void {
    setWhimmyRuntime(api.runtime);
    api.registerChannel({ plugin: whimmyPlugin });
    registerWhimmyCli(api);
    registerWhimmyHooks(api);

    // Register a gateway method that captures the ExecApprovalManager reference.
    // The manager is only accessible via GatewayRequestHandlerOptions.context,
    // so we use this method as the capture point.
    api.registerGatewayMethod('whimmy.approval.init', (opts) => {
      const manager = opts.context.execApprovalManager;
      if (manager) {
        setApprovalManager(manager);
      }
      opts.respond(true, { ok: true });
    });

    // Self-initialize: connect to the local gateway and call whimmy.approval.init
    // to capture the ExecApprovalManager as soon as the gateway is ready.
    api.on('gateway_start', (event) => {
      const cfg = api.runtime.config.loadConfig();
      const token = (cfg as any).gateway?.auth?.token as string | undefined;
      captureApprovalManager(event.port, token);
    });
  },
};

export default plugin;
