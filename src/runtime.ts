import type { PluginRuntime } from 'openclaw/plugin-sdk';

let runtime: PluginRuntime | null = null;

export function setWhimmyRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getWhimmyRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error('Whimmy runtime not initialized');
  }
  return runtime;
}
