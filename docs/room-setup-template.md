# YourRoom - Group Chat Setup

## Overview
YourRoom is a Matrix room for friends, powered by YourAgent agent.

## Room Details
- **Room ID:** `!your-room-id:your-server.example`
- **Agent:** YourAgent (id: `your-agent`)
- **Model:** Opus (fallback: Sonnet)
- **Sandbox:** Enabled (full isolation)

## Access
- Friends connect via **Tailscale Magic DNS**: `https://your-tailscale-or-public-url.example`
- If your homeserver uses a local/private domain, friends will need a way to reach it (Tailscale, VPN, public DNS, reverse proxy, etc.)
- Registration can be restricted via tokens, invite-only, or disabled entirely
- Rooms should be **invite-only** so friends can't browse other rooms on the server

**Note:** If using Tailscale, remember that split DNS settings are per-user. Friends connecting via Tailscale should use the Magic DNS hostname or the machine's Tailscale IP.

---

## Friend Onboarding

### Prerequisites
- Tailscale installed and connected to the shared network
- Registration token (single-use, get from admin)

### Steps

1. **Get a Matrix client**
   - Element (recommended): https://element.io/download
   - Or any Matrix client (FluffyChat, Nheko, etc.)

2. **Register an account**
   - Homeserver URL: `https://your-tailscale-or-public-url.example`
   - Click "Create account" or "Register"
   - Enter username, password, and registration token
   - You'll become `@username:your-server.example`

3. **Join YourRoom**
   - Wait for an invite from admin, or
   - Ask m for a direct invite to the room

4. **Chat with YourAgent**
   - Just talk in the room - YourAgent responds when it has something to say
   - No @mention needed

---

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| Can't reach homeserver | Tailscale not connected | Check `tailscale status` on your device |
| "Invalid token" on registration | Token already used or typo | Get new token from admin |
| Can't find room | Not invited yet | Ask m for invite |
| YourAgent doesn't respond | Nothing worth saying, or bot offline | That's fine - YourAgent speaks when it counts |
| Media won't load | Client cache issue | Clear cache in client settings |
| Slow connection | Tailscale using relay | Check for DERP vs direct in `tailscale status` |

---

## Token Management

### Admin token location
```
<your-admin-token-path>
```

### Check existing tokens
```bash
TOKEN=$(cat <your-admin-token-path>)
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8008/_synapse/admin/v1/registration_tokens" | jq
```

### Create new token
```bash
TOKEN=$(cat <your-admin-token-path>)
curl -X POST "http://localhost:8008/_synapse/admin/v1/registration_tokens/new" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"uses_allowed": 1}'
```

### Delete unused token
```bash
TOKEN=$(cat <your-admin-token-path>)
curl -X DELETE "http://localhost:8008/_synapse/admin/v1/registration_tokens/TOKEN_HERE" \
  -H "Authorization: Bearer $TOKEN"
```

### Regenerate admin token (if compromised)
```bash
# Password stored securely at <your-admin-password-path>
PW=$(cat <your-admin-password-path>)
NEW_TOKEN=$(curl -s -X POST "http://localhost:8008/_matrix/client/r0/login" \
  -H "Content-Type: application/json" \
  -d "{\"type\": \"m.login.password\", \"user\": \"matrixadmin\", \"password\": \"$PW\"}" \
  | jq -r '.access_token')
echo "$NEW_TOKEN" > <your-admin-token-path>
chmod 600 <your-admin-token-path>
```

---

## Security Model

### Threat Vectors & Blast Radius

**What a compromised/misbehaving YourAgent CAN do:**
| Vector | Risk | Mitigation |
|--------|------|------------|
| Exfiltrate workspace data | Medium | Only /workspace visible, no secrets |
| Download/run malware | Medium | Contained to container, resource limits |
| Crypto mining | Low | CPU limits (4 cores max) |
| DoS via resource exhaustion | Low | CPU/memory limits enforced |
| Supply chain attacks (npm/pip) | Medium | Isolated environment, no persistence outside workspace |
| Malicious media processing | Low | ffmpeg in container, can't escape |

**What YourAgent CANNOT do:**
| Vector | Why blocked |
|--------|-------------|
| Access LAN (192.168.x.x) | iptables DOCKER-USER rules |
| Access Tailscale (100.x.x.x) | iptables DOCKER-USER rules |
| Access localhost/Clawdbot | iptables blocks 127.0.0.0/8 |
| Read host filesystem | Docker isolation, no bind mounts |
| Escape container | No privileged mode, dropped caps |
| Persist malware outside workspace | Container recreates, rootfs ephemeral |
| Affect other agents/sessions | Separate container per agent |

### Container Isolation Layers

```
┌─────────────────────────────────────────────────────┐
│ 1. Docker container isolation                        │
│    - Separate PID/network/mount namespaces          │
│    - No privileged mode                              │
│    - Capabilities dropped                            │
├─────────────────────────────────────────────────────┤
│ 2. Network firewall (iptables)                       │
│    - Internet: ✅ allowed                            │
│    - LAN: ❌ blocked                                 │
│    - Tailscale: ❌ blocked                           │
│    - Localhost: ❌ blocked                           │
├─────────────────────────────────────────────────────┤
│ 3. Resource limits                                   │
│    - CPU: 4 cores max                                │
│    - Memory: 8GB max                                 │
│    - Prevents resource exhaustion attacks            │
├─────────────────────────────────────────────────────┤
│ 4. Filesystem isolation                              │
│    - Only /workspace mounted (persistent)            │
│    - System rootfs ephemeral (lost on recreate)      │
│    - No access to host paths                         │
└─────────────────────────────────────────────────────┘
```

### Installed Tools & Risk Assessment

| Tool | Purpose | Risk | Notes |
|------|---------|------|-------|
| curl, wget | HTTP requests | Low | Network already allowed |
| jq | JSON processing | Very low | Pure data processing |
| git | Version control | Low | Can clone repos |
| ripgrep | File search | Very low | Read-only operation |
| sqlite3 | Local databases | Very low | Workspace only |
| uv | Python env/packages | Medium | pip install in venv |
| ffmpeg | Media processing | Medium | CVE history, but contained |
| node | JS runtime | Medium | npm supply chain risk |
| pandoc | Doc conversion | Low | Well-audited |

### YourAgent Sandbox Config
| Capability | Status |
|------------|--------|
| Docker image | `agent-sandbox:latest` |
| Network | ✅ Internet only (LAN/Tailscale blocked) |
| Host filesystem | ❌ Only /workspace |
| Tailscale/nodes | ❌ Firewall blocked |
| CLI commands | ✅ Full toolkit, sandboxed |
| Privileged ops | ❌ No |
| CPU limit | 4 cores |
| Memory limit | 8GB |

### Custom Docker Image

Build location: `docker/agent-sandbox/`

```bash
# Rebuild if needed:
cd <workspace>/docker/agent-sandbox
docker build -t agent-sandbox:latest .
```

**Included tools:**
- Python 3.11 + uv (fast package manager)
- Node.js 18 + npm
- git, curl, wget, jq, ripgrep
- sqlite3, ffmpeg, pandoc

---

## Workspace Architecture

### Two Workspaces (by design)

YourAgent has **two separate workspace directories**:

| Location | Purpose | Edited by |
|----------|---------|-----------|
| `<workspace>/agents/your-agent/` | Main workspace (admin config) | You |
| `<clawdbot-data>/sandboxes/agent-your-agent-{hash}/` | Sandbox workspace (runtime) | YourAgent |

### Why Two Workspaces?

**Security isolation.** The sandbox is designed to prevent a compromised/misbehaving agent from:
- Modifying its own instructions to escape restrictions
- Affecting other agents' workspaces
- Persisting malicious changes to admin-controlled files

### Sync Behavior

- **One-way sync:** Main → Sandbox (on container start via `setupCommand`)
- **No reverse sync:** Sandbox changes don't flow back to main
- **Sync scope:** Only `*.md` config files (AGENTS.md, SOUL.md, etc.)

### What Goes Where

| File type | Location | Sync behavior |
|-----------|----------|---------------|
| `AGENTS.md`, `SOUL.md`, `TOOLS.md` | Edit in main | Synced to sandbox on start |
| `memory/` | Sandbox only | Never synced (YourAgent's notes) |
| Code/files YourAgent creates | Sandbox only | Persists, never synced |

### Design Decision: No Self-Improvement

We chose **admin-controlled instructions** over self-improvement:

**Option A (chosen):** Admin edits config → synced to sandbox → overwrites any YourAgent changes
- ✅ Predictable behavior
- ✅ Admin always in control
- ✅ Simple mental model
- ❌ YourAgent can't evolve its own instructions

**Option B (rejected):** Bidirectional sync / self-improvement
- ✅ YourAgent could refine its own personality/instructions
- ❌ Unpredictable behavior over time
- ❌ Complex merge conflicts
- ❌ Security risk (prompt injection persistence)

For a friend-facing chat agent, predictability > autonomy.

### Editing Workflow

1. Edit files in **main workspace**: `<workspace>/agents/your-agent/`
2. Changes apply on next container start (or manual session reset)
3. Never edit the sandbox directory directly (changes will be overwritten)

---

## Room Lifecycle & Maintenance

### Full Room Reset (Clean Slate)

When you need to completely reset YourRoom (new persona, fresh start, etc.):

```bash
TOKEN=$(cat <clawdbot-data>/matrix-admin-token)
ROOM="!your-room-id:your-server.example"

# 1. Delete all room media (images, files)
for mid in $(curl -s "http://localhost:8008/_synapse/admin/v1/room/$ROOM/media" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.local[]'); do
  curl -X DELETE "http://localhost:8008/_synapse/admin/v1/media/your-server.example/$mid" \
    -H "Authorization: Bearer $TOKEN"
done

# 2. Purge message history
NOW_MS=$(date +%s)000
curl -X POST "http://localhost:8008/_synapse/admin/v1/purge_history/$ROOM" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"purge_up_to_ts\": $NOW_MS, \"delete_local_events\": true}"

# 3. Reset YourAgent session (see below)
```

### Session Reset Only (Keep Matrix History)

For just resetting YourAgent's context without touching Matrix:

```python
# <clawdbot-data>/agents/your-agent/sessions/sessions.json
# Set systemSent: false and generate new sessionId
# Or run from Felix: "reset YourAgent session"
```

### ⚠️ Important: Media vs Events

Synapse `purge_history` only deletes **message events**, NOT **media files**:

| What | purge_history | Media delete API |
|------|---------------|------------------|
| Text messages | ✅ Deleted | N/A |
| m.image events | ✅ Deleted | Need separate call |
| Actual image files | ❌ Kept | ✅ Deleted |
| mxc:// URLs | ❌ Still work | ✅ Broken after delete |

**Always delete media first, then purge history** for a true clean slate.

### Maintenance Schedule

| Task | Frequency | How |
|------|-----------|-----|
| Session reset | As needed | Manual or daily at 07:00 (config) |
| History purge | As needed | Admin API |
| Media cleanup | As needed | Admin API (delete orphaned media) |
| Workspace sync | Automatic | setupCommand on container start |
| Firewall rules | On reboot | agent-firewall.service (systemd) |

### User Permissions
| Action | Friends | m (owner) |
|--------|---------|-----------|
| Chat in rooms | ✅ | ✅ |
| Create rooms | ✅ | ✅ |
| Trigger Clawdbot | ❌ | ✅ |
| Slash commands | ❌ | ✅ |
| DM the bot | ❌ | ✅ |
| Admin API | ❌ | ✅ |

**To enable friends to interact with bot later:**
Add their Matrix ID to `groupAllowFrom` in `~/.clawdbot/clawdbot.json`:
```json
"groupAllowFrom": ["@admin:your-server.example", "@friend1:your-server.example"]
```

---

## Monitoring
- **Room monitor:** Cron job runs every 5 minutes
- **Script:** `<workspace>/scripts/matrix-room-monitor.sh`
- **Notifies:** DM room when new rooms are created

---

## Network Access (Internet-Only)

YourAgent has internet access but is blocked from LAN/Tailscale:

**Docker network:** `agent-internet`
**Config:** `sandbox.docker.network: "agent-internet"`

### Firewall Setup (requires root)

```bash
# One-time setup - run as root on the LXC host:
sudo <workspace>/scripts/your-agent-network-firewall.sh
```

**What's blocked:**
- 192.168.0.0/16 (LAN)
- 10.0.0.0/8 (Private)
- 172.16.0.0/12 (Docker internal)
- 127.0.0.0/8 (Localhost)
- 100.64.0.0/10 (Tailscale CGNAT)

### Persistence (systemd service)

Already configured: `agent-firewall.service` runs automatically after Docker on boot.

```bash
# Check status
systemctl status agent-firewall.service

# Manual re-run if needed
sudo systemctl restart agent-firewall.service
```

Service file: `/etc/systemd/system/agent-firewall.service`

---

---

## Initial Setup (How to Create a Room Like This)

Step-by-step to create a new sandboxed agent room from scratch:

### 1. Create Matrix Room
```bash
# Create room via Element/client, or API:
BOT_TOKEN="<clawdbot_token>"
curl -X POST "http://localhost:8008/_matrix/client/v3/createRoom" \
  -H "Authorization: Bearer $BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "RoomName", "preset": "private_chat"}'
# Note the room_id from response
```

### 2. Add 3+ Members (Important!)
Rooms need 3+ members to be treated as channels, not DMs:
- Invite yourself (@admin:...)
- Invite a helper account (@helper:... or @helper:...)
- Bot is already there

### 3. Create Agent Workspace
```bash
mkdir -p <workspace>/agents/<agent-id>
# Create: AGENTS.md, SOUL.md, IDENTITY.md, USER.md, TOOLS.md
```

### 4. Build Docker Image (if sandboxed)
```bash
cd <workspace>/docker/<agent>-sandbox
docker build -t <agent>-sandbox:latest .
```

### 5. Create Docker Network (if internet-restricted)
```bash
docker network create <agent>-internet
# Create firewall script and systemd service
```

### 6. Add Agent to Clawdbot Config
```json
{
  "agents": {
    "list": [
      {
        "id": "<agent-id>",
        "workspace": "<workspace>/agents/<agent-id>",
        "model": { "primary": "anthropic/claude-opus-4-5" },
        "identity": { "name": "AgentName", "theme": "..." },
        "sandbox": {
          "mode": "all",
          "docker": {
            "image": "<agent>-sandbox:latest",
            "network": "<agent>-internet",
            "setupCommand": "cp /host-workspace/*.md /workspace/ 2>/dev/null || true"
          }
        }
      }
    ]
  }
}
```

### 7. Add Binding (Route Room → Agent)
```json
{
  "bindings": [
    {
      "agentId": "<agent-id>",
      "match": {
        "channel": "matrix",
        "peer": { "kind": "channel", "id": "!roomid:server" }
      }
    }
  ]
}
```

### 8. Add Room to Groups Config (autoReply)
```json
{
  "channels": {
    "matrix": {
      "groups": {
        "!roomid:server": { "autoReply": true }
      }
    }
  }
}
```

### 9. Set Display Name (Optional)
```bash
BOT_TOKEN="<token>"
curl -X PUT "http://localhost:8008/_matrix/client/v3/rooms/!roomid:server/state/m.room.member/@bot:server" \
  -H "Authorization: Bearer $BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"membership": "join", "displayname": "AgentName"}'
```

### 10. Apply Firewall Rules
```bash
sudo systemctl enable <agent>-firewall.service
sudo systemctl start <agent>-firewall.service
```

### 11. Restart Gateway
```bash
clawdbot gateway restart
```

---

## Setup History (2026-02-03)
1. Created room (needed 3+ members for binding to work)
2. Added synadmin as 3rd member
3. Configured YourAgent agent with Opus + sandbox
4. Set up room monitor cron
5. Created registration tokens for friends
6. Added internet-only network access (agent-internet)
7. Created secure admin user (`matrixadmin`) with token stored at `<your-admin-token-path>`
8. Deactivated old `tokenchecker` user (password was exposed)
