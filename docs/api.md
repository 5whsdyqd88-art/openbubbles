# API Reference

Base URL: `http://localhost:3847` (configurable via `BRIDGE_PORT`)

---

## Health

### `GET /api/health`
Check if the bridge is running.

**Response:**
```json
{ "status": "ok", "timestamp": 1740000000000 }
```

---

## Conversations

### `GET /api/conversations`
List all known conversations, ordered by most recent message.

**Response:**
```json
{
  "conversations": [
    {
      "id": 1,
      "chatGuid": "iMessage;-;+12025551234",
      "chatIdentifier": "+12025551234",
      "displayName": null,
      "service": "iMessage",
      "isGroup": false,
      "assignedAgentId": "bobby",
      "autoAssigned": true,
      "firstSeenAt": "2026-03-01T00:00:00.000Z",
      "lastMessageAt": "2026-03-01T10:00:00.000Z",
      "lastMessagePreview": "Hey, how's it going?",
      "messageCount": 42
    }
  ]
}
```

### `GET /api/conversations/:id`
Get a conversation with its participants and recent messages.

**Response:**
```json
{
  "conversation": { ... },
  "participants": [
    { "id": 1, "conversationId": 1, "handle": "+12025551234" }
  ],
  "messages": [
    {
      "id": 1,
      "text": "Hey!",
      "senderHandle": "+12025551234",
      "isFromMe": false,
      "deliveryStatus": "delivered",
      "createdAt": "2026-03-01T10:00:00.000Z"
    }
  ]
}
```

### `PUT /api/conversations/:id/assign`
Manually assign a conversation to an agent. Overrides automatic routing.

**Body:**
```json
{ "agentId": "bernard" }
```

**Response:**
```json
{ "success": true }
```

---

## Routing Rules

### `GET /api/rules`
List all routing rules, ordered by priority.

**Response:**
```json
{
  "rules": [
    {
      "id": 1,
      "priority": 10,
      "name": "Family group",
      "matchType": "group_name",
      "matchValue": "Family",
      "agentId": "bernard",
      "enabled": true,
      "createdAt": "2026-03-01T00:00:00.000Z"
    }
  ]
}
```

### `POST /api/rules`
Create a new routing rule.

**Body:**
```json
{
  "name": "SMS to Bobby",
  "matchType": "service",
  "matchValue": "SMS",
  "agentId": "bobby",
  "priority": 50,
  "description": "Route all green bubble messages to Bobby"
}
```

**Response:** `201` with created rule.

### `PUT /api/rules/:id`
Update an existing rule. All fields optional.

**Body:**
```json
{
  "priority": 20,
  "enabled": false
}
```

### `DELETE /api/rules/:id`
Delete a routing rule.

---

## Agents

### `GET /api/agents`
List OpenClaw agents. Tries live fetch from the gateway, falls back to cached data.

**Response:**
```json
{
  "agents": [
    { "id": "bobby", "name": "Bobby", "emoji": "🤵" },
    { "id": "bernard", "name": "Bernard" },
    { "id": "patti", "name": "Patti" }
  ],
  "source": "live"
}
```

`source` is `"live"` or `"cache"`.

---

## Stats

### `GET /api/stats`
Summary counts.

**Response:**
```json
{
  "totalConversations": 1427,
  "totalMessages": 14262,
  "unroutedConversations": 3
}
```

---

## Send

### `POST /api/send`
Send a message to a conversation via AppleScript. Used by OpenClaw agents to deliver replies.

**Body:**
```json
{
  "chatGuid": "iMessage;+;chat928374651",
  "text": "Hello from OpenBubbles!",
  "filePath": "/path/to/file.jpg"
}
```

`chatGuid` is required. `text` and/or `filePath` required (can send both).

**Response:**
```json
{ "success": true }
```

or on failure:
```json
{ "success": false, "error": "osascript: ..." }
```

**Note:** `filePath` must be accessible to the bridge process. For outbound attachments from OpenClaw, the file will be auto-staged to `~/Pictures/OpenClawBridgeOutbound/` before sending.
