# Fractal API

A Node.js HTTP service for dynamically creating and managing OpenClaw sub-agents ("fractals").

> **Note:** This implementation serves as a **reference implementation** and **library for the plumbing logic**. For actual deployments, the **admin room workflow** (human-in-the-loop approval via a dedicated Matrix room) is the recommended approach. This code provides the building blocks (Matrix room creation, OpenClaw config management, workspace scaffolding) that an admin agent can use to execute approved fractal proposals. The HTTP service wrapper may not be needed in production.

## Overview

The Fractal API allows agent Mox (or other authorized clients) to programmatically create new agents with dedicated Matrix rooms. Each fractal agent:

- Gets a dedicated Matrix room for communication
- Has its own workspace directory with configuration files
- Runs in a sandboxed Docker environment
- Is automatically bound to its room via OpenClaw config
- Can be managed independently (list, get, delete)

## Architecture

```
┌─────────────┐
│     Mox     │ (or other client)
└──────┬──────┘
       │ HTTP (Bearer token auth)
       ▼
┌─────────────────────┐
│   Fractal API       │ (Node.js, port 18790)
│   (the admin LXC/clawdbot)  │
└─────────┬───────────┘
          │
    ┌─────┴─────┬─────────┬──────────┐
    ▼           ▼         ▼          ▼
┌────────┐ ┌─────────┐ ┌─────────┐ ┌────────┐
│ Matrix │ │OpenClaw │ │Workspace│ │Registry│
│ Synapse│ │ Gateway │ │  Files  │ │  JSON  │
└────────┘ └─────────┘ └─────────┘ └────────┘
```

## Installation

1. **Clone/copy** the `fractal-api/` directory to your server

2. **Create config file** from the example:
   ```bash
   cd <fraktalia-repo>/fractal-api
   cp config.example.json config.json
   ```

3. **Edit config.json** with your actual values:
   - `auth.secret`: Strong random token for API authentication
   - `matrix.botToken`: From `~/.openclaw/openclaw.json` → `channels.matrix.accounts.<your-bot>.token`
   - `matrix.adminToken`: From your Matrix admin token file

4. **Set permissions:**
   ```bash
   chown -R <openclaw-user>:<openclaw-group> <fraktalia-repo>/fractal-api
   chmod 600 config.json  # Protect secrets
   ```

5. **Install systemd service:**
   ```bash
   sudo cp fractal-api.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable fractal-api.service
   sudo systemctl start fractal-api.service
   ```

6. **Check status:**
   ```bash
   sudo systemctl status fractal-api.service
   curl http://localhost:18790/health
   ```

## API Endpoints

### Authentication

All endpoints except `/health` require a Bearer token:

```bash
Authorization: Bearer YOUR_SECRET_TOKEN
```

### `GET /health`

Health check (no auth required).

**Response:**
```json
{
  "status": "ok",
  "version": "1.0.0",
  "fractals": {
    "active": 2,
    "total": 3,
    "max": 5
  }
}
```

### `POST /fractal`

Create a new fractal agent.

**Request body:**
```json
{
  "name": "ResearchBot",
  "agentId": "research-bot",
  "purpose": "Helps with research tasks",
  "persona": "Professional, thorough, detail-oriented researcher",
  "model": "anthropic/claude-sonnet-4-5",
  "inviteUsers": ["@m:your-homeserver.example.com"],
  "autoReply": true
}
```

**Fields:**
- `name` (required): Display name for the agent
- `agentId` (required): Unique kebab-case identifier
- `purpose` (optional): What the agent does (for IDENTITY.md)
- `persona` (optional): Personality description (for SOUL.md)
- `model` (optional): LLM model to use (default: claude-sonnet-4-5)
- `inviteUsers` (optional): Matrix user IDs to invite to the room
- `autoReply` (optional): Auto-reply in the room (default: true)

**Response (201):**
```json
{
  "success": true,
  "fractal": {
    "agentId": "research-bot",
    "roomId": "!AbCdEf:your-homeserver.example.com",
    "name": "ResearchBot",
    "purpose": "Helps with research tasks",
    "model": "anthropic/claude-sonnet-4-5",
    "workspace": "/var/lib/clawdbot/workspace/agents/research-bot",
    "status": "active",
    "createdAt": "2026-02-18T22:30:00.000Z"
  }
}
```

**Process:**
1. Create Matrix room and invite users
2. Ensure room has 3+ members (add padding user if needed)
3. Create workspace directory with scaffold files
4. Add agent to OpenClaw config (read-modify-write)
5. Add binding to route room → agent (before felix catch-all)
6. Set group config (auto-reply)
7. Restart OpenClaw gateway

### `GET /fractal`

List all fractals.

**Response (200):**
```json
{
  "success": true,
  "count": 2,
  "fractals": [
    {
      "agentId": "research-bot",
      "roomId": "!room1:your-homeserver.example.com",
      "name": "ResearchBot",
      "status": "active",
      "createdAt": "2026-02-18T22:30:00.000Z"
    },
    {
      "agentId": "data-analyst",
      "roomId": "!room2:your-homeserver.example.com",
      "name": "DataAnalyst",
      "status": "active",
      "createdAt": "2026-02-18T23:00:00.000Z"
    }
  ]
}
```

### `GET /fractal/:id`

Get details of a specific fractal.

**Response (200):**
```json
{
  "success": true,
  "fractal": {
    "agentId": "research-bot",
    "roomId": "!AbCdEf:your-homeserver.example.com",
    "name": "ResearchBot",
    "purpose": "Helps with research tasks",
    "model": "anthropic/claude-sonnet-4-5",
    "workspace": "/var/lib/clawdbot/workspace/agents/research-bot",
    "status": "active",
    "createdAt": "2026-02-18T22:30:00.000Z"
  }
}
```

### `DELETE /fractal/:id`

Delete a fractal agent.

**Query parameters:**
- `deleteWorkspace=true` (optional): Also delete workspace files
- `deleteRoom=true` (optional): Also delete Matrix room (not implemented)

**Example:**
```bash
DELETE /fractal/research-bot?deleteWorkspace=true
```

**Response (200):**
```json
{
  "success": true,
  "message": "Fractal deleted",
  "agentId": "research-bot"
}
```

**Process:**
1. Remove group config
2. Remove binding
3. Remove agent from config
4. Delete workspace (if requested)
5. Restart OpenClaw gateway
6. Remove from registry

## Safety Features

### Config Corruption Prevention

The API uses a **read-modify-write pattern** for all OpenClaw config updates to prevent catastrophic agent deletion:

1. **Read** full config with `config.get()`
2. **Modify** in memory
3. **Validate** changes (agent count, binding order)
4. **Write** back complete config with `config.patch()`
5. **Verify** after write

This pattern is **critical** because `config.patch` on `agents.list` replaces the entire array. A partial patch would delete all other agents.

### Pre-flight Checks

- Refuses to create fractals if `agents.list.length < 12` (indicates corruption)
- Validates agent count before and after config updates
- Ensures bindings are inserted before the felix catch-all

### Rollback on Failure

If any step fails during creation:
- Workspace is deleted
- Agent config is removed
- Binding is removed
- System is left in a clean state

### Limits

- Maximum 5 fractals by default (configurable)
- Only authorized clients can call the API (Bearer token)

## Usage Examples

### Create a fractal (curl)

```bash
curl -X POST http://localhost:18790/fractal \
  -H "Authorization: Bearer YOUR_SECRET_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "ResearchBot",
    "agentId": "research-bot",
    "purpose": "Helps with research tasks",
    "persona": "Professional researcher",
    "inviteUsers": ["@youruser:your-homeserver.example.com"],
    "autoReply": true
  }'
```

### List fractals

```bash
curl http://localhost:18790/fractal \
  -H "Authorization: Bearer YOUR_SECRET_TOKEN"
```

### Delete a fractal

```bash
curl -X DELETE "http://localhost:18790/fractal/research-bot?deleteWorkspace=true" \
  -H "Authorization: Bearer YOUR_SECRET_TOKEN"
```

### Health check

```bash
curl http://localhost:18790/health
```

## Configuration Reference

### `config.json`

```json
{
  "server": {
    "host": "127.0.0.1",      // Bind address
    "port": 18790              // Port number
  },
  "auth": {
    "secret": "..."            // Bearer token for API auth
  },
  "matrix": {
    "baseUrl": "http://localhost:8008",
    "homeserver": "your-homeserver.example.com",
    "botToken": "...",         // From openclaw.json
    "adminToken": "...",       // Admin token
    "paddingUser": "@admin:..." // User to invite for 3+ members
  },
  "openclaw": {
    "gatewayCommand": "openclaw gateway",
    "catchAllAgentId": "main-agent" // Catch-all binding agent
  },
  "workspace": {
    "baseDir": "<openclaw-data>/workspace/agents",
    "owner": "openclaw:openclaw",
    "permissions": "775"
  },
  "registry": {
    "dataFile": "<openclaw-data>/.openclaw/fractal-registry.json"
  },
  "limits": {
    "maxFractals": 5,          // Max concurrent fractals
    "minAgentsCount": 12       // Min expected agents (corruption check)
  },
  "agentDefaults": {
    "sandbox": {               // Default sandbox config for new agents
      "mode": "all",
      "workspaceAccess": "rw",
      "docker": {
        "image": "agent-sandbox:latest",
        "network": "agent-internet",
        "user": "996:1100",
        "readOnlyRoot": false
      }
    }
  }
}
```

## Logs

- **stdout/stderr**: Systemd journal (`journalctl -u fractal-api.service -f`)
- **File**: `fractal-api.log` (in the API directory)

## Troubleshooting

### API won't start

```bash
# Check service status
sudo systemctl status fractal-api.service

# Check logs
sudo journalctl -u fractal-api.service -n 50

# Verify config
cat config.json | jq .
```

### Config corruption detected

If you see: `Config corruption detected! agents.list has X entries, expected 12+`

**Recovery:**
1. Stop the API: `sudo systemctl stop fractal-api.service`
2. Check OpenClaw config: `openclaw gateway config.get | jq '.agents.list | length'`
3. Restore from backup if needed: `~/.openclaw/openclaw.json.bak*`
4. Verify agent count: Should be 12+ (base agents)

### Room has fewer than 3 members

The API automatically invites a padding user (`@synadmin`) to ensure rooms have 3+ members. If this fails:
- Check that `matrix.paddingUser` exists in config
- Verify the padding user is registered in Synapse

### Fractal not responding

1. Check that room binding exists: `openclaw gateway config.get | jq '.bindings'`
2. Verify agent config: `openclaw gateway config.get | jq '.agents.list[] | select(.id == "fractal-id")'`
3. Check group config: `openclaw gateway config.get | jq '.channels.matrix.groups'`
4. Restart gateway: `sudo systemctl restart openclaw-gateway.service`

## Development

Run manually for testing:

```bash
cd /var/lib/clawdbot/workspace/fraktalia/fractal-api
node server.js
```

## Security Notes

- **Token security**: Keep `config.json` mode 600 and never commit to git
- **Local only**: Server binds to 127.0.0.1 by default (localhost only)
- **Firewall**: If exposing externally, use Tailscale or VPN + strong token
- **Audit logs**: All operations are logged to `fractal-api.log`

## License

Internal use only. Part of the Fraktalia project.
