import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { whimmyPlugin, registerWhimmyHooks, setApprovalManager, broadcastApprovalRequest } from './src/channel';
import { setWhimmyRuntime } from './src/runtime';
import { registerWhimmyCli } from './src/setup';

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

    // Once the gateway starts, the approval manager will be available
    // after the first gateway method invocation.
    api.on('gateway_start', () => {
      // ExecApprovalManager is captured on the first whimmy.approval.init call.
    });
  },
};

export default plugin;
