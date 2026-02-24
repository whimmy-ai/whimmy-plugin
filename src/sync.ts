import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { OpenClawConfig } from 'openclaw/plugin-sdk';
import { getWhimmyRuntime } from './runtime';
import type { AgentConfig, Logger, MemoryFileEntry } from './types';

/** In-memory cache: agentId → hash of full synced config. */
const hashCache = new Map<string, string>();

function computeHash(agentConfig: AgentConfig): string {
  const data = JSON.stringify({
    model: agentConfig.model,
    systemPrompt: agentConfig.systemPrompt ?? '',
    skills: agentConfig.skills ?? null,
    skillEntries: agentConfig.skillEntries ?? null,
    approvals: agentConfig.approvals ?? null,
    askUserQuestion: agentConfig.askUserQuestion ?? null,
  });
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Ensure the Whimmy agent exists in OpenClaw's config with the correct
 * model, system prompt, and skills.  Uses an in-memory hash cache to skip
 * redundant disk writes when nothing changed.
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

  // Set per-agent skill allowlist.
  if (agentConfig.skills !== undefined) {
    entry!.skills = agentConfig.skills;
    log?.info?.(`[Whimmy] Agent ${agentId} skills: [${agentConfig.skills.join(', ')}]`);
  }

  // Sync global skill entries (enable/disable, API keys, env vars).
  if (agentConfig.skillEntries && Object.keys(agentConfig.skillEntries).length > 0) {
    if (!cfg.skills) {
      (cfg as any).skills = {};
    }
    if (!cfg.skills!.entries) {
      cfg.skills!.entries = {};
    }

    for (const [skillName, skillConfig] of Object.entries(agentConfig.skillEntries)) {
      cfg.skills!.entries![skillName] = {
        ...cfg.skills!.entries![skillName],
        ...skillConfig,
      };
    }

    const names = Object.keys(agentConfig.skillEntries);
    log?.info?.(`[Whimmy] Synced skill entries: [${names.join(', ')}]`);
  }

  // When Whimmy handles approvals, disable framework-level exec prompting
  // so the two systems don't race. See: ExecApprovalManager / ask modes.
  if (agentConfig.approvals?.enabled) {
    const tools = agentConfig.approvals.tools ?? ['*'];
    log?.info?.(`[Whimmy] Approvals enabled: mode=${agentConfig.approvals.mode ?? 'always'} tools=[${tools.join(', ')}]`);

    (entry as any).tools = {
      ...((entry as any).tools ?? {}),
      exec: {
        ...(((entry as any).tools ?? {}).exec ?? {}),
        ask: 'off',
      },
    };
    log?.info?.(`[Whimmy] Set exec ask=off for ${agentId} (Whimmy is sole approval surface)`);
  }

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

// ============ Memory File Sync ============

/** In-memory hash cache for memory files: "agentId:filename" → SHA256 hash. */
const memoryHashCache = new Map<string, string>();

/** Top-level memory files to scan (excludes framework files like SOUL.md, BOOTSTRAP.md, AGENTS.md). */
const MEMORY_FILES = ['USER.md', 'IDENTITY.md', 'TOOLS.md', 'HEARTBEAT.md'];

/** Max number of files from memory/ subdir. */
const MEMORY_SUBDIR_MAX_FILES = 10;

/** Max total size in bytes for all memory files. */
const MEMORY_MAX_TOTAL_BYTES = 100 * 1024; // 100KB

/**
 * Collect memory files that have changed since the last sync.
 * Returns a record of changed files, or null if nothing changed.
 */
export function collectChangedMemoryFiles(
  agentId: string,
  agentDir: string,
  log?: Logger,
): Record<string, MemoryFileEntry> | null {
  const changed: Record<string, MemoryFileEntry> = {};
  let totalBytes = 0;

  function tryFile(filename: string, filePath: string): void {
    if (!existsSync(filePath)) return;

    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      return;
    }

    if (!content.trim()) return;

    const bytes = Buffer.byteLength(content, 'utf-8');
    if (totalBytes + bytes > MEMORY_MAX_TOTAL_BYTES) {
      log?.debug?.(`[Whimmy] Memory sync: skipping ${filename} (would exceed 100KB cap)`);
      return;
    }

    const hash = createHash('sha256').update(content).digest('hex');
    const cacheKey = `${agentId}:${filename}`;

    if (memoryHashCache.get(cacheKey) === hash) return;

    totalBytes += bytes;
    changed[filename] = { content, hash };
    memoryHashCache.set(cacheKey, hash);
  }

  // Scan top-level memory files.
  for (const filename of MEMORY_FILES) {
    tryFile(filename, join(agentDir, filename));
  }

  // Scan memory/ subdir for *.md files.
  const memoryDir = join(agentDir, 'memory');
  if (existsSync(memoryDir)) {
    try {
      const entries = readdirSync(memoryDir)
        .filter(f => f.endsWith('.md'))
        .slice(0, MEMORY_SUBDIR_MAX_FILES);

      for (const entry of entries) {
        const filename = `memory/${entry}`;
        tryFile(filename, join(memoryDir, entry));
      }
    } catch {
      // memory/ dir may not be readable — ignore.
    }
  }

  if (Object.keys(changed).length === 0) return null;

  return changed;
}
