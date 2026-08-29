# WeCom adapter

This fork adds a WeCom (Enterprise WeChat) entry point that reuses the existing Codex adapter, so Codex continues to authenticate with the local ChatGPT/Codex subscription rather than the OpenAI API.

## Architecture

```text
WeCom AI Bot (WebSocket)
        |
        v
wecom-channel-bridge
        |
        v
existing CodexAdapter
        |
        v
Codex CLI / ChatGPT subscription
```

The WeCom transport uses the official `@wecom/aibot-node-sdk` WebSocket client. No public callback URL is required.

## Requirements

- Node.js >= 20.12
- Codex CLI installed and already authenticated (`codex login`)
- A WeCom AI Bot with Bot ID and Secret

## Run

```bash
pnpm install
pnpm build

export WECOM_BOT_ID='your-bot-id'
export WECOM_SECRET='your-bot-secret'
export WECOM_WORKSPACE="$HOME/workspace"

node ./bin/wecom-channel-bridge.mjs
```

After npm publication/install, the binary is also exposed as:

```bash
wecom-channel-bridge
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `WECOM_BOT_ID` | required | WeCom AI Bot ID |
| `WECOM_SECRET` | required | WeCom AI Bot secret |
| `WECOM_WORKSPACE` | current directory | Codex working directory |
| `WECOM_STATE_DIR` | `~/.lark-channel/wecom` | local thread/session state |
| `WECOM_CODEX_SANDBOX` | `read-only` | `read-only`, `workspace-write`, or `danger-full-access` |
| `WECOM_CODEX_MODEL` | Codex default | optional Codex model override |
| `WECOM_STREAM_MAX_CHARS` | `15000` | maximum streamed reply length |
| `CODEX_BINARY` | `codex` | Codex executable path/name |

## Conversation mapping

- Single chat: `single:<userid>`
- Group chat: `group:<chatid>`

Each conversation keeps its own Codex `threadId` in `sessions.json`, so follow-up messages resume the same Codex thread.

## Commands

- `/new` or `/reset` — clear the stored Codex thread for this WeCom conversation
- `/status` — show current workspace, sandbox, thread, and running state
- `/stop` — stop the active Codex run for this conversation

## Current scope

The first adapter slice handles text messages and streamed text responses. Image/file ingress and generated-file egress should be added after the text/session path is validated against a real WeCom bot.
