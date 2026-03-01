# Setup Guide

## Prerequisites

- macOS (Sonoma or later recommended)
- Node.js 20+
- PostgreSQL 14+
- Messages.app configured with your Apple ID
- iPhone with Text Message Forwarding enabled (for SMS)

## 1. System permissions

OpenBubbles needs **Full Disk Access** to read `~/Library/Messages/chat.db`.

Go to: **System Settings → Privacy & Security → Full Disk Access**

Add your Terminal app (or whichever app runs the bridge).

## 2. PostgreSQL

If you don't have Postgres running:

```bash
# macOS via Homebrew
brew install postgresql@17
brew services start postgresql@17
```

Create the database:

```bash
createdb imessage_bridge
```

## 3. Install OpenBubbles

```bash
git clone https://github.com/5whsdyqd88-art/openbubbles.git
cd openbubbles
npm install
```

## 4. Configure

```bash
cp .env.example .env
```

Edit `.env`:

```env
# Your Postgres connection
DATABASE_URL=postgresql://yourusername@localhost:5432/imessage_bridge

# OpenClaw gateway (check openclaw status for the port)
OPENCLAW_GATEWAY_URL=http://localhost:59679
OPENCLAW_GATEWAY_TOKEN=

# Which agent handles unmatched conversations
DEFAULT_AGENT=bobby
```

## 5. Push schema

```bash
npm run db:push
```

This creates the 7 tables in Postgres.

## 6. Start

```bash
npm run dev
```

On first run, the bridge will:
1. Sync all existing chats from `chat.db` into Postgres
2. Set the polling watermark to the current latest message (so it doesn't re-process history)
3. Start polling for new messages every 2 seconds
4. Start the HTTP API on port 3847

## 7. Set up routing rules

Open the web UI at **http://localhost:3847** and create your routing rules.

Or via API:

```bash
# Route all SMS to bobby
curl -X POST http://localhost:3847/api/rules \
  -H "Content-Type: application/json" \
  -d '{"name":"SMS to Bobby","matchType":"service","matchValue":"SMS","agentId":"bobby","priority":50}'

# Default catch-all
curl -X POST http://localhost:3847/api/rules \
  -H "Content-Type: application/json" \
  -d '{"name":"Default","matchType":"default","agentId":"bobby","priority":100}'
```

## 8. Configure OpenClaw

In your `openclaw.json`, configure each agent to send replies through the bridge:

```json
{
  "agents": {
    "bobby": {
      "channels": {
        "imessage": {
          "enabled": true,
          "outboundUrl": "http://localhost:3847/api/send"
        }
      }
    }
  }
}
```

*(Full OpenClaw channel plugin integration is in progress — see roadmap)*

## Running as a service

To run OpenBubbles automatically at login on macOS:

```bash
# Create a launchd plist
cat > ~/Library/LaunchAgents/com.openbubbles.bridge.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.openbubbles.bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/openbubbles/dist/index.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DATABASE_URL</key>
    <string>postgresql://yourusername@localhost:5432/imessage_bridge</string>
    <key>OPENCLAW_GATEWAY_URL</key>
    <string>http://localhost:59679</string>
    <key>DEFAULT_AGENT</key>
    <string>bobby</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/openbubbles.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/openbubbles.err</string>
</dict>
</plist>
EOF

launchctl load ~/Library/LaunchAgents/com.openbubbles.bridge.plist
```

## Troubleshooting

**`chat.db not found`**  
→ Check Full Disk Access is granted. Try `ls ~/Library/Messages/chat.db` in Terminal.

**`OpenClaw gateway: NOT reachable`**  
→ Check `openclaw gateway status`. Make sure the gateway is running.

**Messages not appearing**  
→ Check the watermark: `psql imessage_bridge -c "SELECT * FROM poller_state;"`  
→ Check logs for errors.

**Group messages not routing**  
→ Verify the group's GUID in Postgres: `SELECT chat_guid, display_name, is_group FROM conversations WHERE is_group = true;`

**HEIC attachments not converting**  
→ `sips` is built into macOS and should always work. Check logs for conversion errors.
