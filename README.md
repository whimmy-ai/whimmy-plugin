# @whimmy-ai/whimmy

Whimmy channel plugin for [OpenClaw](https://openclaw.ai). Connects your OpenClaw agents to Whimmy via WebSocket.

## Quick Start

```bash
openclaw plugins install @whimmy-ai/whimmy && openclaw whimmy setup
```

This installs the plugin and walks you through pairing with a 6-digit code from the Whimmy app.

## Setup Options

**Interactive (default)** — prompts for a pairing code:

```bash
openclaw whimmy setup
```

**Custom host:**

```bash
openclaw whimmy setup --host api.example.com
```

**Non-interactive with pairing code:**

```bash
openclaw whimmy setup --pairing-code 123456
```

**Connection URI:**

```bash
openclaw whimmy setup --uri whimmy://{token}@{host}
```

**Manual credentials:**

```bash
openclaw whimmy setup --host api.whimmy.ai --token YOUR_TOKEN
```

After setup, restart the gateway to connect:

```bash
openclaw gateway restart
```

## Requirements

- OpenClaw >= 2026.2.13

## License

MIT
