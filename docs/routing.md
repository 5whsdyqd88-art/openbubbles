# Routing

## How routing works

When a new message arrives from a conversation that hasn't been assigned to an agent yet, the router evaluates your rules in priority order. The **first matching rule wins**.

Once a conversation is assigned, it stays assigned — all future messages in that conversation go to the same agent unless you manually reassign it.

## Rule priority

Lower number = higher priority. Rules are sorted ascending by priority before evaluation.

Example:
```
Priority 10  — exact_handle: +12025551234 → bobby
Priority 20  — group_name: "Family" → bernard  
Priority 50  — service: SMS → patti
Priority 100 — default → bobby
```

A message from `+12025551234` matches rule 10 and goes to Bobby, even though rule 50 would also match it.

## Match types

### `exact_handle`
Matches an exact phone number or email address. Only applies to DMs (not groups).

```json
{
  "matchType": "exact_handle",
  "matchValue": "+12025551234",
  "agentId": "bobby"
}
```

Phone numbers are normalized before comparison — `+1 (202) 555-1234` matches `+12025551234`.

### `handle_pattern`
Wildcard prefix match. The `*` is stripped and the remaining string is used as a prefix.

```json
{
  "matchType": "handle_pattern",
  "matchValue": "+1860*",
  "agentId": "patti"
}
```

Matches any phone number starting with `+1860`.

### `group_guid`
Matches a specific group chat by its exact GUID. Most precise way to target a group.

```json
{
  "matchType": "group_guid",
  "matchValue": "iMessage;+;chat928374651",
  "agentId": "bernard"
}
```

Find a group's GUID via `GET /api/conversations` or the web UI.

### `group_name`
Matches a group by display name (case-insensitive partial match).

```json
{
  "matchType": "group_name",
  "matchValue": "Family",
  "agentId": "bernard"
}
```

Matches any group whose display name contains "Family".

### `service`
Matches by message service type.

```json
{
  "matchType": "service",
  "matchValue": "SMS",
  "agentId": "bobby"
}
```

Valid values: `iMessage`, `SMS`, `RCS`, `SatelliteSMS`

### `is_group`
Matches all group chats or all DMs.

```json
{
  "matchType": "is_group",
  "matchValue": "true",
  "agentId": "bernard"
}
```

`true` = all groups, `false` = all DMs.

### `default`
Catch-all. Always matches. Should be lowest priority (highest number).

```json
{
  "matchType": "default",
  "matchValue": null,
  "agentId": "bobby"
}
```

## Manual assignment

You can override automatic routing at any time:

```bash
curl -X PUT http://localhost:3847/api/conversations/42/assign \
  -H "Content-Type: application/json" \
  -d '{"agentId": "bernard"}'
```

Manually assigned conversations are flagged (`auto_assigned = false`) and won't be re-routed by rules.

## New conversations

When a message arrives from a completely new contact or group:

1. A `conversations` row is created in Postgres
2. Routing rules are evaluated
3. The conversation is assigned to the matching agent (or the default)
4. All future messages in that conversation go to the same agent

The web UI will show new unrouted conversations (where no rule matched and there's no default rule) so you can manually assign them.

## Suggested rule setup

A simple starting point for a 3-agent setup:

| Priority | Match type | Value | Agent | Notes |
|---|---|---|---|---|
| 10 | `group_name` | `Family` | bernard | Specific group |
| 20 | `group_guid` | `iMessage;+;chat123` | bernard | Another specific group |
| 50 | `is_group` | `true` | bernard | All other groups |
| 90 | `service` | `SMS` | bobby | All green bubbles |
| 100 | `default` | — | bobby | Everything else |
