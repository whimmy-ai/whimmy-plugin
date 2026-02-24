# Skills — Backend Implementation Guide

Skills in OpenClaw are pre-built capabilities (coding agents, GitHub integration, PDF handling, etc.) that ship with the platform. The Whimmy plugin allows the app to control which skills are available to each agent and configure them with API keys and environment variables.

## How Skills Work in OpenClaw

Skills are `SKILL.md` files that live in OpenClaw's bundled skills directory. They are **not installed per-agent** — they're always present. You control them through two mechanisms:

1. **Per-agent allowlist** — which skills a specific agent can use
2. **Global entries** — enable/disable skills, set API keys and env vars

Both are synced via the existing `agentConfig` field in `hook.agent` — no new events needed.

## AgentConfig Fields

The `agentConfig` object in `HookAgentRequest` now supports two new optional fields:

```json
{
  "message": "hello",
  "agentId": "my-agent",
  "sessionKey": "user-42",
  "channel": "whimmy",
  "agentConfig": {
    "model": "anthropic/claude-sonnet-4-20250514",
    "temperature": 0.7,
    "maxTokens": 4096,
    "systemPrompt": "You are a helpful assistant.",

    "skills": ["coding-agent", "github", "nano-pdf"],

    "skillEntries": {
      "github": {
        "enabled": true,
        "env": { "GITHUB_TOKEN": "ghp_xxx" }
      },
      "openai-image-gen": {
        "enabled": true,
        "apiKey": "sk-xxx"
      },
      "discord": {
        "enabled": false
      }
    }
  }
}
```

### `skills` — Per-Agent Allowlist

| Value | Behavior |
|---|---|
| `undefined` (omitted) | Agent can use **all** enabled skills |
| `[]` (empty array) | Agent can use **no** skills |
| `["coding-agent", "github"]` | Agent can only use these specific skills |

This maps directly to `agents.list[].skills` in OpenClaw config.

### `skillEntries` — Global Skill Configuration

A map of skill name to configuration. Each entry can set:

| Field | Type | Description |
|---|---|---|
| `enabled` | `boolean?` | Enable or disable this skill globally |
| `apiKey` | `string?` | API key for skills that need one (e.g. OpenAI image gen) |
| `env` | `Record<string, string>?` | Environment variables the skill needs |
| `config` | `Record<string, unknown>?` | Arbitrary skill-specific configuration |

This maps to `skills.entries` in OpenClaw config. Entries are **merged** — setting `github.enabled = true` won't clear an existing `github.env`.

## Go Structs

```go
type AgentConfig struct {
    Model        string                       `json:"model"`
    Temperature  float64                      `json:"temperature"`
    MaxTokens    int                          `json:"maxTokens"`
    SystemPrompt *string                      `json:"systemPrompt,omitempty"`
    McpTools     []string                     `json:"mcpTools,omitempty"`
    Proactivity  *string                      `json:"proactivity,omitempty"`
    Skills       []string                     `json:"skills,omitempty"`
    SkillEntries map[string]SkillEntryConfig  `json:"skillEntries,omitempty"`
}

type SkillEntryConfig struct {
    Enabled *bool                  `json:"enabled,omitempty"`
    APIKey  *string                `json:"apiKey,omitempty"`
    Env     map[string]string      `json:"env,omitempty"`
    Config  map[string]interface{} `json:"config,omitempty"`
}
```

## Sync Behavior

Skills are synced as part of the existing agent config sync that happens on every `hook.agent` message. The plugin:

1. Hashes the full config (model + systemPrompt + skills + skillEntries)
2. Skips the write if nothing changed (fast path)
3. Writes `agents.list[].skills` for the per-agent allowlist
4. Merges `skills.entries` for global skill configuration
5. Persists to `openclaw.json`

Changes take effect on the **next agent dispatch** (next message from the user). OpenClaw doesn't hot-reload skills mid-session.

## Available Bundled Skills

These are the skills that ship with OpenClaw (the user's instance may have more or fewer depending on version):

| Skill | Description |
|---|---|
| `coding-agent` | Delegate coding tasks to Claude Code, Codex, etc. |
| `github` / `gh-issues` | GitHub integration |
| `discord` | Discord integration |
| `nano-pdf` | PDF handling |
| `openai-image-gen` | Image generation via OpenAI |
| `openai-whisper` | Audio transcription |
| `gemini` | Google Gemini integration |
| `notion` | Notion integration |
| `obsidian` | Obsidian notes integration |
| `apple-notes` | Apple Notes integration |
| `bear-notes` | Bear notes integration |
| `canvas` | Canvas/drawing |
| `himalaya` | Email via Himalaya |
| `1password` | 1Password integration |
| `peekaboo` | Screenshot capture |
| `session-logs` | Session log access |
| `model-usage` | Model usage stats |

Skills may require binaries or env vars to function. The `requires` field in each skill's metadata specifies what's needed (e.g. `coding-agent` requires one of `claude`, `codex`, `opencode`, or `pi` binaries).

## Example: Enable GitHub for an Agent

```json
{
  "agentConfig": {
    "model": "anthropic/claude-sonnet-4-20250514",
    "temperature": 0.7,
    "maxTokens": 4096,
    "skills": ["github", "coding-agent"],
    "skillEntries": {
      "github": {
        "enabled": true,
        "env": {
          "GITHUB_TOKEN": "ghp_xxxxxxxxxxxx"
        }
      }
    }
  }
}
```

## Example: Disable All Skills

```json
{
  "agentConfig": {
    "model": "anthropic/claude-sonnet-4-20250514",
    "temperature": 0.7,
    "maxTokens": 4096,
    "skills": []
  }
}
```

## Example: Allow All Skills (default)

Simply omit the `skills` field:

```json
{
  "agentConfig": {
    "model": "anthropic/claude-sonnet-4-20250514",
    "temperature": 0.7,
    "maxTokens": 4096
  }
}
```
