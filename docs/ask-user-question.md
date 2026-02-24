# AskUserQuestion — Backend Implementation Guide

When an OpenClaw agent needs clarifying input from the user (e.g. "Which database should I use?"), it calls the `AskUserQuestion` tool. The Whimmy plugin intercepts this, forwards the question over WebSocket, and blocks until the backend sends back the user's answer.

This guide covers what the backend needs to handle.

## Wire Protocol

All messages use the existing `WSEnvelope` format:

```
WSEnvelope { type: string, payload?: unknown }
```

Outbound events from the plugin are wrapped as:

```json
{
  "type": "event",
  "payload": {
    "event": "<event_name>",
    "payload": { ... }
  }
}
```

Inbound messages from the backend use the `type` field directly:

```json
{
  "type": "hook.<event_name>",
  "payload": { ... }
}
```

## Flow Overview

```
Agent calls AskUserQuestion tool
    |
    v
Plugin intercepts via before_tool_call hook
    |
    v
Plugin sends "ask_user_question" event over WebSocket
    |
    v
Backend receives it, delivers questions to the user's device
    |
    v
User selects answers in the UI
    |
    v
Backend sends "hook.ask_user_answer" back over WebSocket
    |
    v
Plugin resolves the pending promise, injects answers into tool params
    |
    v
Agent continues with the user's choices
```

The plugin blocks for up to **120 seconds** waiting for an answer. If the user doesn't respond, the tool call is blocked and the agent is told the user didn't respond.

## Step 1: Handle the Inbound Event

When the plugin needs user input, it sends a WebSocket message with this shape:

```json
{
  "type": "event",
  "payload": {
    "event": "ask_user_question",
    "payload": {
      "sessionKey": "user-session-123",
      "agentId": "agent-abc",
      "questionId": "550e8400-e29b-41d4-a716-446655440000",
      "questions": [
        {
          "question": "Which database should I use for caching?",
          "header": "Database",
          "options": [
            { "label": "Redis", "description": "In-memory store, very fast" },
            { "label": "SQLite", "description": "File-based, no server needed" },
            { "label": "PostgreSQL", "description": "Full relational database" }
          ],
          "multiSelect": false
        }
      ]
    }
  }
}
```

### Field Reference

| Field | Type | Description |
|---|---|---|
| `sessionKey` | `string` | Identifies the conversation / chat session |
| `agentId` | `string` | The agent that's asking the question |
| `questionId` | `string` (UUID) | Unique ID for this question batch. **You must return this in the answer.** |
| `questions` | `Question[]` | 1-4 questions to present to the user |

Each **Question**:

| Field | Type | Description |
|---|---|---|
| `question` | `string` | Full question text to display |
| `header` | `string` | Short label (max 12 chars) — use as a tag/chip above the question |
| `options` | `Option[]` | 2-4 choices |
| `multiSelect` | `boolean` | If `true`, user can pick multiple options |

Each **Option**:

| Field | Type | Description |
|---|---|---|
| `label` | `string` | Short display text (1-5 words) |
| `description` | `string` | Explanation of what this option means |
| `markdown` | `string?` | Optional preview content (code snippet, ASCII mockup) |

### Go Structs

```go
type AskUserQuestionEvent struct {
    SessionKey string              `json:"sessionKey"`
    AgentID    string              `json:"agentId"`
    QuestionID string              `json:"questionId"`
    Questions  []AskUserQuestion   `json:"questions"`
}

type AskUserQuestion struct {
    Question    string                    `json:"question"`
    Header      string                    `json:"header"`
    Options     []AskUserQuestionOption   `json:"options"`
    MultiSelect bool                      `json:"multiSelect"`
}

type AskUserQuestionOption struct {
    Label       string  `json:"label"`
    Description string  `json:"description"`
    Markdown    *string `json:"markdown,omitempty"`
}
```

### What to do when you receive this event

1. Route the question to the correct user session using `sessionKey` and `agentId`.
2. Push the questions to the mobile client (via your existing push/notification mechanism).
3. Store the `questionId` — you'll need it when sending the answer back.

## Step 2: Render in the UI

Present the questions as interactive cards. Here's the recommended UX:

**Single-select (`multiSelect: false`):**
- Show the `header` as a small tag/chip
- Show the `question` as the main text
- Render each option as a tappable button/card with `label` as the title and `description` below it
- If an option has `markdown`, show it as a preview pane when focused
- Always include a free-text input ("Other") as a fallback — the user may want to type a custom answer

**Multi-select (`multiSelect: true`):**
- Same layout, but use checkboxes/toggles instead of radio buttons
- Allow selecting multiple options before confirming

**Multiple questions (1-4 per batch):**
- Render as a vertical list of question cards, or step through them one at a time

## Step 3: Send the Answer Back

When the user has answered, send a `hook.ask_user_answer` message back over the WebSocket:

```json
{
  "type": "hook.ask_user_answer",
  "payload": {
    "questionId": "550e8400-e29b-41d4-a716-446655440000",
    "answers": {
      "Which database should I use for caching?": "Redis"
    }
  }
}
```

### Answer Format

The `answers` field is a map where:
- **Key** = the exact `question` string from the original request
- **Value** = the selected `label` string

For **multi-select**, comma-separate the labels:

```json
{
  "answers": {
    "Which features should I enable?": "Dark mode, Notifications"
  }
}
```

For **free-text** (user typed a custom answer instead of picking an option):

```json
{
  "answers": {
    "Which database should I use for caching?": "DynamoDB — we already use AWS"
  }
}
```

### Go Struct

```go
type HookAskUserAnswer struct {
    QuestionID string            `json:"questionId"`
    Answers    map[string]string `json:"answers"`
}
```

### Sending it

```go
envelope := WSEnvelope{
    Type:    "hook.ask_user_answer",
    Payload: HookAskUserAnswer{
        QuestionID: questionID,
        Answers:    answers,
    },
}
conn.WriteJSON(envelope)
```

## Step 4: Handle Edge Cases

### Timeout

The plugin waits **120 seconds** by default. If the user doesn't answer in time:
- The plugin blocks the tool call and tells the agent "User did not respond"
- The agent will typically retry or adjust its approach
- You don't need to send anything — the plugin handles the timeout internally

If you want to indicate the user explicitly dismissed the question, send an empty answers map:

```json
{
  "type": "hook.ask_user_answer",
  "payload": {
    "questionId": "...",
    "answers": {}
  }
}
```

### Multiple questions in one batch

If the `questions` array has multiple entries, collect all answers before sending a single `hook.ask_user_answer` response. Every question's text should appear as a key in the `answers` map.

### Duplicate questionId

Each `questionId` is a UUID generated per request. The plugin only accepts the first answer for a given `questionId` — subsequent answers are logged as warnings and ignored.

## Comparison with Existing Approval Flow

This pattern mirrors `exec.approval.requested` / `hook.approval`:

| | Approval | AskUserQuestion |
|---|---|---|
| **Outbound event** | `exec.approval.requested` | `ask_user_question` |
| **Inbound message** | `hook.approval` | `hook.ask_user_answer` |
| **Correlation key** | `executionId` | `questionId` |
| **User action** | Approve / Deny | Select option(s) or type free-text |
| **Response shape** | `{ executionId, approved, reason? }` | `{ questionId, answers }` |

If you've already implemented the approval flow, adding AskUserQuestion follows the same routing and correlation pattern — just with richer payloads.

## Full Example Sequence

```
PLUGIN → BACKEND (WebSocket):
{
  "type": "event",
  "payload": {
    "event": "ask_user_question",
    "payload": {
      "sessionKey": "user-42",
      "agentId": "coding-agent",
      "questionId": "q-abc-123",
      "questions": [
        {
          "question": "Which testing framework should I use?",
          "header": "Testing",
          "options": [
            { "label": "Jest", "description": "Popular, good for React projects" },
            { "label": "Vitest", "description": "Fast, Vite-native" },
            { "label": "Mocha", "description": "Flexible, widely used" }
          ],
          "multiSelect": false
        }
      ]
    }
  }
}

--- user taps "Vitest" in the app ---

BACKEND → PLUGIN (WebSocket):
{
  "type": "hook.ask_user_answer",
  "payload": {
    "questionId": "q-abc-123",
    "answers": {
      "Which testing framework should I use?": "Vitest"
    }
  }
}
```

The agent then proceeds knowing the user chose Vitest.
