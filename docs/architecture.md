# Architecture

## Overview

OpenBubbles is a middleware service that bridges Apple's iMessage/SMS ecosystem with OpenClaw AI agents. It runs on the same Mac as Messages.app and requires no external dependencies beyond PostgreSQL.

```
┌─────────────────────────────────────────────────────────────────┐
│  macOS                                                          │
│                                                                 │
│  Messages.app ←──── AppleScript ────── OpenBubbles Sender      │
│       │                                        ↑               │
│       ↓                                        │               │
│  chat.db (SQLite, read-only)           /api/send               │
│       │                                        │               │
│       └──── poll every 2s ──→ OpenBubbles ─────┘               │
│                                    │                            │
│                              ┌─────┴──────┐                    │
│                              │  Postgres  │                    │
│                              │ - convos   │                    │
│                              │ - rules    │                    │
│                              │ - messages │                    │
│                              │ - attaches │                    │
│                              └─────┬──────┘                    │
│                                    │                            │
│                              HTTP API :3847                     │
│                                    │                            │
│  ┌─────────────────────────────────┼──────────────────────┐    │
│  │  OpenClaw Gateway               │                       │    │
│  │  ├── Bobby  ←───────────────────┤                       │    │
│  │  ├── Bernard ←──────────────────┤                       │    │
│  │  └── Patti  ←───────────────────┘                       │    │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Message flow

### Inbound (receiving a message)

1. **Poller** reads `chat.db` for messages with ROWID > last watermark
2. **Watcher** upserts the conversation into Postgres, stores the message
3. **Attachment pipeline** copies files out of Apple's sandboxed storage, converts HEIC → JPEG
4. **Router** evaluates routing rules in priority order, assigns a conversation to an agent
5. **OpenClaw client** delivers the message to the assigned agent via the gateway API
6. Message delivery status updated in Postgres (`delivered` / `failed`)

### Outbound (agent sends a reply)

1. OpenClaw agent calls `POST /api/send` with `chatGuid` + `text` (and optional `filePath`)
2. Bridge looks up the conversation's `chat_guid` in Postgres
3. **AppleScript sender** sends to `chat id "<guid>"` — works for DMs and groups identically
4. File attachments are staged to `~/Pictures/OpenClawBridgeOutbound/` first (imagent sandbox requirement)

## Why chat GUIDs?

Every conversation in `chat.db` has a stable GUID:

| Type | Format | Example |
|---|---|---|
| iMessage DM | `iMessage;-;<handle>` | `iMessage;-;+12025551234` |
| iMessage group | `iMessage;+;<chatId>` | `iMessage;+;chat928374651` |
| SMS DM | `SMS;-;<handle>` | `SMS;-;+12025551234` |
| MMS group | `SMS;+;<chatId>` | `SMS;+;chat123456789` |
| RCS | `RCS;-;<handle>` | `RCS;-;+12025551234` |

Using GUIDs means we never confuse two group chats that have the same participants, and outbound sends always land in exactly the right conversation.

## Why not write to chat.db?

`chat.db` is managed by Apple's `imagent` daemon. Writing to it directly would:
- Not actually send messages (`imagent` reads from the DB, it doesn't watch for inserts)
- Risk corrupting the database
- Potentially be blocked by System Integrity Protection

The only supported way to send is via AppleScript → Messages.app → `imagent`.

## Components

### `src/poller/`
- **`chat-db.ts`** — Read-only SQLite reader using `better-sqlite3`. Handles the full join across `message`, `handle`, `chat`, `attachment` tables. Does NOT filter on `cache_roomnames` (that was the bug in other implementations that broke group chats).
- **`entities.ts`** — TypeScript types matching Apple's chat.db schema, plus Apple epoch ↔ Unix timestamp conversion utilities.
- **`watcher.ts`** — Poll loop with persistent watermark. On startup, syncs all existing chats. Emits `ProcessedMessage[]` to the router.

### `src/router/`
- **`rules.ts`** — Priority-ordered rule evaluation engine. Rules cached in memory (5s TTL) to avoid hammering Postgres on every message. Supports 7 match types. Manual assignment always overrides automatic routing.

### `src/sender/`
- **`applescript.ts`** — Sends via `osascript`. Always uses `chat id` addressing. Stages file attachments to `~/Pictures/OpenClawBridgeOutbound/` for imagent sandbox compatibility.

### `src/attachments/`
- **`inbound.ts`** — Copies attachments from `~/Library/Messages/Attachments/` to `~/.openclaw/imessage-bridge/media/inbound/`. Converts HEIC → JPEG using `sips` (built-in macOS), falling back to ImageMagick.
- **`outbound.ts`** — Stages outbound files for Messages.app's sandbox. Auto-cleans files older than 24h.

### `src/openclaw/`
- **`client.ts`** — HTTP client for the OpenClaw gateway. Discovers agents, checks health, delivers inbound messages.

### `src/api/`
- **`routes.ts`** — Hono REST API. Serves the web UI and exposes endpoints for conversations, routing rules, agents, stats, and outbound sends.

### `src/db/`
- **`schema.ts`** — Drizzle ORM schema for all 7 Postgres tables.
- **`connection.ts`** — Singleton Postgres connection via `postgres.js` + Drizzle.
