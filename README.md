# OpenBubbles

> iMessage & SMS bridge for [OpenClaw](https://openclaw.ai) — route conversations to AI agents with a web UI.

OpenBubbles sits between Apple's Messages.app and OpenClaw, giving you full control over which agent handles which conversation — DMs, group chats, SMS, RCS, and more.

## What it does

- **Polls `chat.db`** (Apple's Messages database) for new messages every 2 seconds
- **Routes conversations** to OpenClaw agents (Bobby, Bernard, Patti, etc.) based on configurable rules
- **Sends replies** back through AppleScript using the exact chat GUID — so replies always land in the right group or DM
- **Handles attachments** — copies files out of Apple's sandboxed storage, converts HEIC → JPEG, tracks everything in Postgres
- **Web GUI** for managing routing rules, viewing conversations, and reassigning chats
- **Supports all message types**: iMessage (🔵), SMS (🟢), RCS (🟣), SatelliteSMS

## How it works

```
Messages.app ←→ chat.db (Apple's SQLite, read-only)
                    ↓ poll every 2s
            ┌─── OpenBubbles ───────────────┐
            │  Poller → Router → Delivery   │
            │           ↕                   │
            │        Postgres               │
            │  (conversations, rules,        │
            │   messages, attachments)      │
            └───────────┬───────────────────┘
                        ↓ HTTP
            ┌─── OpenClaw Gateway ──────────┐
            │  ├── Bobby                    │
            │  ├── Bernard                  │
            │  └── Patti                    │
            └───────────────────────────────┘
```

**Inbound:** chat.db → polled → routed → delivered to agent  
**Outbound:** agent → `POST /api/send` with `chatGuid` → AppleScript → Messages.app

## Requirements

- macOS (Messages.app must be set up)
- Node.js 20+
- PostgreSQL 14+
- Full Disk Access granted to Terminal/your Node process (for reading `chat.db`)
- Text Message Forwarding enabled on iPhone (for SMS/green bubbles)

## Quick start

```bash
git clone https://github.com/5whsdyqd88-art/openbubbles.git
cd openbubbles
npm install

# Copy and edit config
cp .env.example .env
# Edit .env with your Postgres URL, OpenClaw gateway URL, and default agent

# Push schema to Postgres
npm run db:push

# Start the bridge
npm run dev
```

Open **http://localhost:3847** for the web UI.

## Configuration

All config is via environment variables (or `.env` file):

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgresql://computer@localhost:5432/imessage_bridge` | Postgres connection string |
| `OPENCLAW_GATEWAY_URL` | `http://localhost:59679` | OpenClaw gateway URL |
| `OPENCLAW_GATEWAY_TOKEN` | _(empty)_ | Gateway API token (if auth enabled) |
| `BRIDGE_PORT` | `3847` | Port for the web UI and API |
| `POLL_INTERVAL_MS` | `2000` | How often to poll chat.db (ms) |
| `DEFAULT_AGENT` | `bobby` | Fallback agent when no rules match |
| `CHAT_DB_PATH` | `~/Library/Messages/chat.db` | Custom path to chat.db |

## Routing rules

Rules are evaluated in priority order (lower number = higher priority). The first matching rule wins.

| Match type | Description | Example value |
|---|---|---|
| `exact_handle` | Exact phone/email (DM only) | `+12025551234` |
| `handle_pattern` | Prefix wildcard | `+1860*` |
| `group_guid` | Specific group by GUID | `iMessage;+;chat123456` |
| `group_name` | Group display name (partial match) | `Family Chat` |
| `service` | Message service type | `SMS` or `iMessage` |
| `is_group` | All groups or all DMs | `true` or `false` |
| `default` | Catch-all | _(no value needed)_ |

Rules can be managed via the web UI or the REST API.

## REST API

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/conversations` | List all conversations |
| `GET` | `/api/conversations/:id` | Conversation detail + messages |
| `PUT` | `/api/conversations/:id/assign` | Manually assign to agent |
| `GET` | `/api/rules` | List routing rules |
| `POST` | `/api/rules` | Create a routing rule |
| `PUT` | `/api/rules/:id` | Update a rule |
| `DELETE` | `/api/rules/:id` | Delete a rule |
| `GET` | `/api/agents` | List OpenClaw agents (live + cached) |
| `GET` | `/api/stats` | Conversation + message counts |
| `POST` | `/api/send` | Send a message (by chatGuid) |

### Sending a message

```bash
curl -X POST http://localhost:3847/api/send \
  -H "Content-Type: application/json" \
  -d '{
    "chatGuid": "iMessage;+;chat928374651",
    "text": "Hello from OpenBubbles!"
  }'
```

### Creating a routing rule

```bash
curl -X POST http://localhost:3847/api/rules \
  -H "Content-Type: application/json" \
  -d '{
    "name": "SMS to Bobby",
    "matchType": "service",
    "matchValue": "SMS",
    "agentId": "bobby",
    "priority": 10
  }'
```

## Database schema

7 tables in Postgres:

- **`conversations`** — Every chat seen, with agent assignment and last message preview
- **`messages`** — Full message log with delivery status
- **`attachments`** — Attachment metadata, local copies, conversion status
- **`chat_participants`** — Group chat members
- **`routing_rules`** — Priority-ordered routing configuration
- **`poller_state`** — Polling watermark (survives restarts)
- **`agent_cache`** — Cached OpenClaw agent list

## Roadmap

- [ ] Web GUI (React + Vite)
- [ ] Outbound webhook receiver (OpenClaw → bridge)
- [ ] OpenClaw channel plugin for native integration
- [ ] New conversation notifications + auto-assignment UI
- [ ] Conversation hand-off between agents
- [ ] Message search
- [ ] Docker Compose setup

## Why not BlueBubbles?

BlueBubbles requires running a separate macOS server app + REST API + webhook infrastructure. OpenBubbles talks directly to `chat.db` and AppleScript — no extra dependencies, no middleman, runs entirely on the same Mac as Messages.app.

## License

MIT
