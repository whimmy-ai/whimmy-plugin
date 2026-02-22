import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { whimmyPlugin } from './src/channel';
import { setWhimmyRuntime } from './src/runtime';

const plugin = {
  id: 'whimmy',
  name: 'Whimmy Channel',
  description: 'Whimmy multi-agent messenger channel via WebSocket',
  configSchema: { schema: { type: 'object', properties: {}, additionalProperties: true } },
  register(api: OpenClawPluginApi): void {
    setWhimmyRuntime(api.runtime);
    api.registerChannel({ plugin: whimmyPlugin });
  },
};

export default plugin;
