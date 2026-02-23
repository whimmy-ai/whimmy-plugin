import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { OpenClawConfig } from 'openclaw/plugin-sdk';
import { getWhimmyRuntime } from './runtime';
import type { AgentConfig, Logger } from './types';

/** In-memory cache: agentId → hash of { model, systemPrompt }. */
const hashCache = new Map<string, string>();

function computeHash(agentConfig: AgentConfig): string {
  const data = JSON.stringify({
    model: agentConfig.model,
    systemPrompt: agentConfig.systemPrompt ?? '',
  });
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Ensure the Whimmy agent exists in OpenClaw's config with the correct
 * model and system prompt.  Uses an in-memory hash cache to skip redundant
 * disk writes when nothing changed.
 */
export async function ensureWhimmyAgent(
  agentId: string,
  agentConfig: AgentConfig,
  log?: Logger,
): Promise<OpenClawConfig> {
  const rt = getWhimmyRuntime();
  const hash = computeHash(agentConfig);

  // Fast path: nothing changed since last sync.
  if (hashCache.get(agentId) === hash) {
    log?.debug?.(`[Whimmy] Agent config unchanged for ${agentId}, skipping sync`);
    return rt.config.loadConfig();
  }

  log?.info?.(`[Whimmy] Syncing agent config for ${agentId}`);

  const cfg = rt.config.loadConfig();

  // Ensure agents.list exists.
  if (!cfg.agents) {
    (cfg as any).agents = {};
  }
  if (!cfg.agents!.list) {
    cfg.agents!.list = [];
  }

  // Find or create agent entry.
  let entry = cfg.agents!.list!.find((a) => a.id === agentId);
  if (!entry) {
    cfg.agents!.list!.push({ id: agentId });
    entry = cfg.agents!.list![cfg.agents!.list!.length - 1];
  }

  // Set model.
  entry!.model = agentConfig.model;

  // Resolve workspace dir and write SOUL.md.
  const workspace = cfg.agents?.defaults?.workspace
    ?? join(homedir(), '.openclaw', 'workspace');
  const agentDir = join(workspace, 'agents', agentId);

  mkdirSync(agentDir, { recursive: true });

  // Write SOUL.md with the system prompt (or empty to clear a previous one).
  writeFileSync(join(agentDir, 'SOUL.md'), agentConfig.systemPrompt ?? '', 'utf-8');

  // Write an empty BOOTSTRAP.md so the default workspace bootstrap isn't inherited.
  writeFileSync(join(agentDir, 'BOOTSTRAP.md'), '', 'utf-8');

  entry!.workspace = agentDir;
  entry!.agentDir = agentDir;

  // Persist config.
  await rt.config.writeConfigFile(cfg);

  // Update cache.
  hashCache.set(agentId, hash);

  log?.info?.(`[Whimmy] Agent ${agentId} synced: model=${agentConfig.model} agentDir=${agentDir}`);

  return cfg;
}
