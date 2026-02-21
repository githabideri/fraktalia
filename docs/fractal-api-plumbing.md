# Fractal API Plumbing Analysis

> Research conducted 2026-02-18  
> Purpose: Design a bridge API that lets Mox (agent running in LXC) create new sub-agents dynamically

---

## Executive Summary

This document describes the OpenClaw plumbing needed for a "Fractal API" — a system that allows agent Mox (running in an LXC container) to programmatically spawn new agents with dedicated Matrix rooms. The API requires coordinating three systems: **Matrix (Synapse)**, **OpenClaw (agent config)**, and **host infrastructure (Docker/LXC, filesystems)**.

**Critical safety requirement:** The `config.patch` API on `agents.list` is **destructive** — it replaces the entire array. Any implementation MUST use the read-modify-write pattern described below to avoid catastrophic agent deletion (this has happened twice, causing total service disruption).

---

## Part 1: Add-New-Room/Agent Routine

This section describes the complete procedure for programmatically creating a new agent with a dedicated Matrix room.

### 1.1 Matrix Side — Synapse Admin API

#### Prerequisites

- **Admin user:** `@admin:your-homeserver.example.com`
- **Admin token:** Stored at `<openclaw-data>/.openclaw/matrix-admin-token`
- **Synapse URL:** `http://localhost:8008` (local, no TLS)
- **External access:** `https://your-host.tailnet.ts.net:8448` (Tailscale)

#### Step 1: Create the Matrix Room

```bash
# Use the bot's token (not admin) to create the room
BOT_TOKEN="<your-bot-token>"  # from openclaw.json

curl -X POST "http://localhost:8008/_matrix/client/v3/createRoom" \
  -H "Authorization: Bearer $BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "New Fractal Agent",
    "preset": "private_chat",
    "invite": ["@youruser:your-homeserver.example.com"]
  }'
```

**Response:**
```json
{
  "room_id": "!example-room:your-homeserver.example.com"
}
```

**CRITICAL:** Save the `room_id` — you'll need it for all subsequent steps.

#### Step 2: Ensure 3+ Members (Required for Bindings)

**Why:** Matrix rooms with fewer than 3 members are treated as DMs, not group channels. This breaks OpenClaw's agent bindings which match `peer.kind: "channel"`.

**Solution:** Invite a dummy user as the 3rd member:

```bash
ROOM_ID="!example-room:your-homeserver.example.com"

# Invite admin/padding user as padding member
curl -X POST "http://localhost:8008/_matrix/client/v3/rooms/$ROOM_ID/invite" \
  -H "Authorization: Bearer $BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "@admin:your-homeserver.example.com"}'
```

**Members now:** @yourbot (bot), @youruser (creator), @admin (padding) → 3 members ✅

#### Step 3: Set Room Display Name (Optional)

If you want the bot to appear with a custom name in this specific room:

```bash
curl -X PUT "http://localhost:8008/_matrix/client/v3/rooms/$ROOM_ID/state/m.room.member/@yourbot:your-homeserver.example.com" \
  -H "Authorization: Bearer $BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"membership": "join", "displayname": "FractalAgent-X"}'
```

#### Step 4: Register New User (Optional)

If the fractal agent should be a **separate Matrix account** (not just a different persona):

```bash
# Generate single-use registration token
ADMIN_TOKEN=$(cat <openclaw-data>/.openclaw/matrix-admin-token)

curl -X POST "http://localhost:8008/_synapse/admin/v1/registration_tokens/new" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"uses_allowed": 1}'
```

**Response:**
```json
{
  "token": "xKj8mP3nQ...",
  "uses_allowed": 1,
  "pending": 0,
  "completed": 0,
  "expiry_time": null
}
```

Then register the account:

```bash
register_new_matrix_user -c /etc/matrix-synapse/homeserver.yaml \
  -u fractal-agent-x \
  -p <password> \
  -t xKj8mP3nQ...
```

**Note:** This creates a separate bot account like `@localbot:your-homeserver.example.com`. You'll need to configure it in `openclaw.json` under `channels.matrix.accounts.<id>`.

---

### 1.2 OpenClaw Side — Agent Configuration

#### Critical Safety Warning ⚠️

**The `config.patch` API on `agents.list` REPLACES the entire array.**

This has caused **two catastrophic incidents** (2026-02-14, 2026-02-15) where all 12 agents were deleted, leaving only a single agent. All traffic routed to the wrong agent for hours.

**NEVER do this:**
```javascript
// ❌ WRONG — This deletes all other agents!
gateway.config.patch({
  agents: {
    list: [
      { id: "new-agent", workspace: "..." }
    ]
  }
});
```

#### Required Safe Pattern

Always use **read-modify-write**:

```javascript
// ✅ CORRECT — Read full config, modify in place, write back complete list
const cfg = await gateway.config.get();

// Add new agent to the list
cfg.agents.list.push({
  id: "fractal-agent-x",
  workspace: "/var/lib/clawdbot/workspace/agents/fractal-agent-x",
  model: {
    primary: "anthropic/claude-sonnet-4-5",
    fallbacks: ["anthropic/claude-haiku-4-5"]
  },
  sandbox: {
    mode: "all",
    workspaceAccess: "rw",
    docker: {
      image: "mox-sandbox:latest",  // Reuse Mox's image
      network: "mox-internet",       // Reuse network (or create new)
      user: "996:1100",
      readOnlyRoot: false
    }
  }
});

// Validation check
if (cfg.agents.list.length !== 13) {  // Was 12, now should be 13
  throw new Error(`Agent count mismatch! Expected 13, got ${cfg.agents.list.length}`);
}

// Write back the FULL list
await gateway.config.patch({
  agents: {
    list: cfg.agents.list  // ← All 13 agents
  }
});

// Verify after write
const verify = await gateway.config.get();
if (verify.agents.list.length !== 13) {
  throw new Error(`Config corruption detected! Restore from backup immediately.`);
}
```

#### Agent Entry Fields

**Minimal required fields:**
```json
{
  "id": "fractal-agent-x"
}
```
All other fields inherit from `agents.defaults`.

**Full configuration:**
```json
{
  "id": "fractal-agent-x",
  "workspace": "<openclaw-data>/workspace/agents/fractal-agent-x",
  "model": {
    "primary": "anthropic/claude-sonnet-4-5",
    "fallbacks": ["anthropic/claude-haiku-4-5"]
  },
  "identity": {
    "name": "FractalAgentX",
    "theme": "Helpful assistant for fractal tasks"
  },
  "sandbox": {
    "mode": "all",
    "workspaceAccess": "rw",
    "docker": {
      "image": "agent-sandbox:latest",
      "network": "agent-internet",
      "user": "996:1100",
      "readOnlyRoot": false
    }
  },
  "tools": {
    "sandbox": {
      "tools": {
        "allow": [
          "group:runtime",
          "group:fs",
          "group:sessions",
          "group:memory",
          "group:messaging",
          "group:ui",
          "web_search",
          "web_fetch",
          "image",
          "tts"
        ]
      }
    }
  }
}
```

**Available defaults** (from `agents.defaults`):
- `model.primary`: `anthropic/claude-sonnet-4-5`
- `model.fallbacks`: `["openai-codex/gpt-5.1-codex-mini", "openai-codex/gpt-5.2-codex", "anthropic/claude-haiku-4-5"]`
- `workspace`: `<openclaw-data>/workspace`
- `memorySearch.enabled`: `true`
- `memorySearch.provider`: `local`
- `sandbox.mode`: `off`

---

### 1.3 Workspace Setup

Each agent needs a workspace directory with configuration files.

#### Directory Structure

```bash
<openclaw-data>/workspace/agents/fractal-agent-x/
├── AGENTS.md       # System prompt, available tools, rules
├── SOUL.md         # Persona definition (optional)
├── IDENTITY.md     # Identity/role description (optional)
├── USER.md         # User profile/preferences (optional)
├── TOOLS.md        # User tool notes (optional)
└── memory/         # Agent's memory files (created at runtime)
```

#### Creation Script

```bash
AGENT_ID="fractal-agent-x"
WORKSPACE="<openclaw-data>/workspace/agents/$AGENT_ID"

# Create directory structure
mkdir -p "$WORKSPACE/memory"

# Create scaffolding files
cat > "$WORKSPACE/AGENTS.md" <<'EOF'
# AGENTS.md - Fractal Agent X

This agent was created dynamically by the Fractal API.

## Purpose
[Agent's purpose/role]

## Tools
- Standard OpenClaw tools
- Sandboxed environment (internet-only)

## Memory
Keep a daily log at `memory/YYYY-MM-DD.md`.
EOF

cat > "$WORKSPACE/SOUL.md" <<'EOF'
# SOUL.md - Fractal Agent X

## Personality
[Define persona here]

## Communication Style
[How the agent should communicate]

## Values
[Core principles]
EOF

cat > "$WORKSPACE/IDENTITY.md" <<'EOF'
# I am Fractal Agent X

[Agent's identity/role description]
EOF

# Set ownership to OpenClaw service user
chown -R clawdbot:clawdbot "$WORKSPACE"
chmod -R 775 "$WORKSPACE"
```

**Important:** File ownership MUST match the OpenClaw gateway service user (e.g., `openclaw`), or config reload will fail with `EACCES: permission denied`.

#### Workspace Sync to Sandbox

When using Docker sandbox, the workspace files need to be synced to the container. Use `setupCommand`:

```json
{
  "sandbox": {
    "docker": {
      "setupCommand": "cp /host-workspace/*.md /workspace/ 2>/dev/null || true"
    }
  }
}
```

**How it works:**
- Host workspace: `<openclaw-data>/workspace/agents/fractal-agent-x/`
- Container bind mount: `/host-workspace` → host workspace (read-only)
- Container workspace: `/workspace` (writable, ephemeral)
- On container start, `setupCommand` copies `*.md` files to `/workspace`

**Sync behavior:**
- **One-way:** Host → Container only
- **When:** Container start / session reset
- **What:** Config files (`*.md`)
- **Not synced:** `memory/` directory (agent's runtime notes stay in container)

---

### 1.4 Sandbox Config — Docker in LXC

#### Example Setup

An example agent running in an LXC with Docker inside:

```
LXC Host (Proxmox)
└─ Agent LXC (example: the admin LXC)
   ├─ OpenClaw Gateway (Node.js service)
   └─ Docker daemon
      └─ agent-sandbox:latest (Debian 12 container)
         └─ Agent runtime environment
```

**Key insight:** From OpenClaw's perspective, **there is no difference between "Docker on bare metal" and "Docker in LXC"**. The gateway talks to the local Docker daemon via `/var/run/docker.sock` regardless of whether that daemon is running in an LXC container.

#### Sandbox Configuration

For a fractal agent with network isolation:

```json
{
  "sandbox": {
    "mode": "all",           // Sandbox all tool calls
    "workspaceAccess": "rw", // Read-write workspace access
    "docker": {
      "image": "agent-sandbox:latest",  // Your sandbox image
      "network": "agent-internet",       // Isolated network
      "user": "996:1100",              // UID:GID matching host user
      "readOnlyRoot": false            // Allow package installs
    }
  }
}
```

**Network:** An isolated Docker network can have firewall rules that block LAN/Tailscale access. Agents can:
- ✅ Reach internet (HTTP, HTTPS, DNS)
- ❌ Reach LAN (192.168.x.x)
- ❌ Reach Tailscale (100.x.x.x)
- ❌ Reach localhost/host services

**Firewall setup:** Can be managed by systemd service (see example in `scripts/mox-network-firewall.sh`).

#### Creating a Separate Network (Optional)

If you want fractal agents to have a separate network (e.g., different firewall rules):

```bash
# Create new Docker network
docker network create fractal-internet

# Apply firewall rules (using your firewall script)
sudo /path/to/your/network-firewall.sh fractal-internet
```

Then use `"network": "fractal-internet"` in the agent config.

#### Docker Image

Fractal agents can use a custom sandbox image with the tools they need.

**Example sandbox image might include:**
- Python 3.11 + uv (fast package manager)
- Node.js 18 + npm
- FFmpeg, ImageMagick, Blender
- Git, curl, wget, jq, ripgrep
- OpenCV, Manim dependencies
- Build tools (gcc, make)

**Build location:** See `docker/` directory in this repo for an example Dockerfile.

**UID matching:** The image should create a user with UID/GID matching the host OpenClaw service user. This ensures workspace file ownership is consistent between host and container.

**Customization:**
If fractal agents need different tools, create a new Dockerfile:

```dockerfile
FROM agent-sandbox:latest

# Add agent-specific tools
RUN apt-get update && apt-get install -y \
    tool1 tool2 tool3 \
    && rm -rf /var/lib/apt/lists/*

RUN uv pip install --system --break-system-packages \
    python-package1 python-package2
```

Build and use:
```bash
docker build -t fractal-custom:latest .
```

Then reference `"image": "fractal-custom:latest"` in agent config.

---

### 1.5 Binding — Route Room to Agent

After creating the agent, add a binding to route the Matrix room to it.

**Bindings use first-match semantics** — order matters!

#### Example Bindings (specific room → agent mappings)

```json
"bindings": [
  { "agentId": "agent-1", "match": { "channel": "matrix", "peer": { "kind": "channel", "id": "!room1:your-homeserver.example.com" } } },
  { "agentId": "agent-2", "match": { "channel": "matrix", "peer": { "kind": "channel", "id": "!room2:your-homeserver.example.com" } } },
  { "agentId": "agent-3", "match": { "channel": "matrix", "peer": { "kind": "channel", "id": "!room3:your-homeserver.example.com" } } },
  // ... more specific room bindings ...
  { "agentId": "main-agent", "match": { "channel": "matrix" } }  // ← Catch-all MUST be last
]
```

**Note:** The real deployment may have multiple agents with dedicated rooms (e.g., mox, felix, planning, etc.). The key pattern is: specific room bindings first, catch-all last.

#### Adding a New Binding

Same read-modify-write pattern as agents.list:

```javascript
const cfg = await gateway.config.get();

// Insert BEFORE the catch-all (last position)
cfg.bindings.splice(cfg.bindings.length - 1, 0, {
  agentId: "fractal-agent-x",
  match: {
    channel: "matrix",
    peer: {
      kind: "channel",
      id: "!example-room:your-homeserver.example.com"
    }
  }
});

// Write back
await gateway.config.patch({ bindings: cfg.bindings });
```

**Critical:** The catch-all binding (`{ "channel": "matrix" }`) MUST be last, or it will intercept all Matrix traffic.

---

### 1.6 Group Config — Enable Auto-Reply

Add the room to `channels.matrix.groups` to configure behavior:

```javascript
const cfg = await gateway.config.get();

cfg.channels.matrix.groups["!example-room:your-homeserver.example.com"] = {
  autoReply: true  // Agent responds without @mention
};

await gateway.config.patch({
  channels: {
    matrix: {
      groups: cfg.channels.matrix.groups
    }
  }
});
```

**Options:**
- `autoReply: true` — Agent responds to all messages (group chat style)
- `requireMention: true` — Agent only responds when @mentioned (LocalBot style)
- No entry — Defaults to auto-reply for groups

---

### 1.7 Restart Gateway

After all config changes:

```bash
systemctl restart openclaw-gateway.service
# or
openclaw gateway restart
```

**Verification:**
```bash
# Check agent list
openclaw gateway config.get | jq '.agents.list | length'  # Should be 13 (was 12)

# Check bindings
openclaw gateway config.get | jq '.bindings | length'  # Should be 14 (was 13 + catch-all)
```

---

## Part 2: General Routing Logic

This section explains how OpenClaw routes incoming messages to agents.

### 2.1 Room-to-Agent Binding

Bindings map incoming messages to agents based on:
- **Channel** (matrix, discord, telegram, etc.)
- **Account ID** (for multi-account Matrix setups like `@localbot`)
- **Peer** (DM vs channel, specific room ID)

**Example bindings:**

```json
// Specific room → specific agent
{
  "agentId": "agent-x",
  "match": {
    "channel": "matrix",
    "peer": {
      "kind": "channel",
      "id": "!room-x:your-homeserver.example.com"
    }
  }
}

// Specific account + room → specific agent
{
  "agentId": "second-bot-agent",
  "match": {
    "channel": "matrix",
    "accountId": "secondbot",
    "peer": {
      "kind": "channel",
      "id": "!room-y:your-homeserver.example.com"
    }
  }
}

// Catch-all (any Matrix message not matched above)
{
  "agentId": "main-agent",
  "match": {
    "channel": "matrix"
  }
}
```

**Matching logic:**
1. Iterate through `bindings` array in order
2. Check if `match.channel` equals message channel
3. Check if `match.accountId` matches (if specified)
4. Check if `match.peer.kind` matches (`"direct"` for DMs, `"channel"` for rooms)
5. Check if `match.peer.id` matches (if specified)
6. **First match wins** — stop iteration, use this agent

**Code reference:** `agent-scope.ts` → `resolveDefaultAgentId()`

---

### 2.2 groupAllowFrom and allowFrom Patterns

These control **who can trigger the bot** in group chats and DMs.

#### DM Policy

```json
"channels": {
  "matrix": {
    "dm": {
      "policy": "open",
      "allowFrom": [
        "@youruser:your-homeserver.example.com"
      ]
    }
  }
}
```

- `policy: "open"` — Accept DMs from users in `allowFrom`
- `policy: "closed"` — Reject all DMs
- `allowFrom` — List of Matrix user IDs allowed to DM the bot

**Example:** Only specific users can DM the bot.

#### Group Policy

```json
"channels": {
  "matrix": {
    "groupPolicy": "open",
    "groupAllowFrom": [
      "@youruser:your-homeserver.example.com",
      "@friend:your-homeserver.example.com"
    ]
  }
}
```

- `groupPolicy: "open"` — Accept messages from users in `groupAllowFrom`
- `groupAllowFrom` — List of Matrix user IDs allowed to **trigger slash commands** and **invoke the bot via @mention**

**Key distinction:**
- **All room members can read messages** (Matrix room permissions)
- **Only `groupAllowFrom` users can trigger bot actions** (OpenClaw enforcement)

**Example:** Friends can chat in the room, but only authorized users can run `/think` or send commands. Others just see the agent participating in conversation (autoReply mode).

---

### 2.3 Bindings Order — First-Match Semantics

**CRITICAL:** Bindings are evaluated **in array order**. The first match wins.

**Example problem:**

```json
// ❌ WRONG — Catch-all intercepts everything
"bindings": [
  { "agentId": "main-agent", "match": { "channel": "matrix" } },  // ← Matches EVERYTHING
  { "agentId": "specific-agent", "match": { "channel": "matrix", "peer": { "kind": "channel", "id": "!room:..." } } }  // Never reached!
]
```

**Result:** All Matrix messages route to main-agent. The specific-agent binding is never evaluated.

**Correct order:**

```json
// ✅ CORRECT — Specific rooms first, catch-all last
"bindings": [
  { "agentId": "agent-1", "match": { "channel": "matrix", "peer": { "kind": "channel", "id": "!room1:..." } } },
  { "agentId": "agent-2", "match": { "channel": "matrix", "peer": { "kind": "channel", "id": "!room2:..." } } },
  // ... other specific rooms ...
  { "agentId": "main-agent", "match": { "channel": "matrix" } }  // ← Catch-all LAST
]
```

**Rule:** Always add new bindings **before** the catch-all binding.

---

### 2.4 Overlapping Room Bindings

**What happens when multiple bindings match the same room?**

**Answer:** First match wins. Later bindings are ignored.

**Example:**

```json
"bindings": [
  { "agentId": "agent-x", "match": { "channel": "matrix", "peer": { "kind": "channel", "id": "!room-x:..." } } },
  { "agentId": "secondbot-agent-x", "match": { "channel": "matrix", "accountId": "secondbot", "peer": { "kind": "channel", "id": "!room-x:..." } } },
  { "agentId": "main-agent", "match": { "channel": "matrix" } }
]
```

**Behavior:**
- Messages from `@mainbot` in `!room-x...` → **agent-x** (first match)
- Messages from `@secondbot` in `!room-x...` → **secondbot-agent-x** (more specific match due to `accountId`)
- Messages from `@mainbot` in any other room → **main-agent** (catch-all)

**Key insight:** You can have multiple bots in the same room by using `accountId` to differentiate them.

---

### 2.5 Ensuring Fractal Agents Only Respond in Designated Rooms

**Goal:** Fractal Agent X should **only** respond in its designated room, not leak into other rooms.

**Solution:** Use a specific room binding, no catch-all.

**Configuration:**

```json
"bindings": [
  // ... existing bindings ...
  { 
    "agentId": "fractal-agent-x", 
    "match": { 
      "channel": "matrix", 
      "peer": { 
        "kind": "channel", 
        "id": "!example-room:your-homeserver.example.com" 
      } 
    } 
  },
  { "agentId": "main-agent", "match": { "channel": "matrix" } }  // Catch-all
]
```

**Behavior:**
- Messages in `!example-room...` → fractal-agent-x
- Messages in any other room → main-agent (catch-all)
- fractal-agent-x **cannot** respond in other rooms (no binding matches)

**Additional safety:** Set `groupAllowFrom` to restrict who can trigger the fractal agent:

```json
"channels": {
  "matrix": {
    "groupAllowFrom": [
      "@youruser:your-homeserver.example.com"  // Only authorized users can trigger bots
    ]
  }
}
```

This prevents unauthorized users from accidentally invoking fractal agents via @mention or slash commands.

---

## Part 3: Complete API Call Sequence

Here's the full sequence for Mox to create a new fractal agent:

### Step 1: Create Matrix Room

```javascript
const response = await fetch("http://localhost:8008/_matrix/client/v3/createRoom", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${BOT_TOKEN}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    name: "Fractal Agent X",
    preset: "private_chat",
    invite: ["@youruser:your-homeserver.example.com"]
  })
});

const { room_id } = await response.json();
```

### Step 2: Invite Padding Member (3+ members required)

```javascript
await fetch(`http://localhost:8008/_matrix/client/v3/rooms/${room_id}/invite`, {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${BOT_TOKEN}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    user_id: "@admin:your-homeserver.example.com"
  })
});
```

### Step 3: Create Workspace

```javascript
const agentId = "fractal-agent-x";
const workspace = `<openclaw-data>/workspace/agents/${agentId}`;

// Create directories
await exec(`mkdir -p ${workspace}/memory`);

// Create scaffold files
await Write({
  path: `${workspace}/AGENTS.md`,
  content: `# AGENTS.md - Fractal Agent X\n\n...`
});

await Write({
  path: `${workspace}/SOUL.md`,
  content: `# SOUL.md - Fractal Agent X\n\n...`
});

// Set ownership
await exec(`chown -R clawdbot:clawdbot ${workspace}`);
await exec(`chmod -R 775 ${workspace}`);
```

### Step 4: Add Agent to Config

```javascript
// Read current config
const cfg = await gateway.config.get();

// Add new agent
cfg.agents.list.push({
  id: agentId,
  workspace: workspace,
  model: {
    primary: "anthropic/claude-sonnet-4-5"
  },
  sandbox: {
    mode: "all",
    workspaceAccess: "rw",
    docker: {
      image: "mox-sandbox:latest",
      network: "mox-internet",
      user: "996:1100",
      readOnlyRoot: false
    }
  }
});

// Validate
if (cfg.agents.list.length !== 13) {
  throw new Error(`Expected 13 agents, got ${cfg.agents.list.length}`);
}

// Write back
await gateway.config.patch({
  agents: { list: cfg.agents.list }
});
```

### Step 5: Add Binding

```javascript
// Read current config
const cfg = await gateway.config.get();

// Insert before catch-all
cfg.bindings.splice(cfg.bindings.length - 1, 0, {
  agentId: agentId,
  match: {
    channel: "matrix",
    peer: {
      kind: "channel",
      id: room_id
    }
  }
});

// Write back
await gateway.config.patch({ bindings: cfg.bindings });
```

### Step 6: Enable Auto-Reply

```javascript
const cfg = await gateway.config.get();

cfg.channels.matrix.groups[room_id] = {
  autoReply: true
};

await gateway.config.patch({
  channels: {
    matrix: {
      groups: cfg.channels.matrix.groups
    }
  }
});
```

### Step 7: Restart Gateway

```javascript
await exec("systemctl restart openclaw-gateway.service");
```

### Step 8: Verify

```javascript
const verify = await gateway.config.get();

assert(verify.agents.list.length === 13);
assert(verify.bindings.find(b => b.agentId === agentId));
assert(verify.channels.matrix.groups[room_id]);

console.log("✅ Fractal agent created successfully");
```

---

## Part 4: Gotchas and Known Issues

### 4.1 Config Corruption Risk

**Issue:** `config.patch` on `agents.list` replaces the entire array.

**Impact:** Accidentally patching with a partial list deletes all other agents. This has happened **twice** (2026-02-14, 2026-02-15), causing total service outages.

**Mitigation:**
1. **Always** use read-modify-write pattern
2. **Always** validate `agents.list.length` before and after
3. Keep `.bak` files — they're the only recovery mechanism
4. Consider implementing a pre-flight check:
   ```javascript
   function validateAgentListPatch(patch) {
     if (patch.agents?.list && patch.agents.list.length < 12) {
       throw new Error(`Refusing to patch agents.list with only ${patch.agents.list.length} entries (expected 12+)`);
     }
   }
   ```

### 4.2 Room Member Count < 3

**Issue:** Matrix rooms with fewer than 3 members are treated as DMs, not channels.

**Impact:** Bindings with `peer.kind: "channel"` don't match, routing fails.

**Solution:** Always invite a dummy 3rd member (e.g., an admin user or room helper account).

### 4.3 Binding Order

**Issue:** First-match semantics mean order matters. Catch-all bindings intercept everything.

**Impact:** Specific room bindings placed after catch-all are never evaluated.

**Solution:** Always insert new bindings **before** the catch-all (last position).

### 4.4 File Ownership

**Issue:** Editing config files as root changes ownership to `root:root`.

**Impact:** OpenClaw gateway can't read config (EACCES), enters crash loop.

**Solution:** Always `chown clawdbot:clawdbot` after editing as root.

### 4.5 Sandbox UID/GID Mismatch

**Issue:** If container user UID doesn't match host OpenClaw user UID, workspace file permissions break.

**Impact:** Container can't read/write workspace files, or host can't clean up container files.

**Solution:** Use `docker.user: "996:1100"` to match OpenClaw service user, and create matching user in Dockerfile:
```dockerfile
RUN groupadd -g 1100 openclaw-agents && \
    useradd -u 996 -g 1100 -d /workspace -s /bin/bash -M mox
```

### 4.6 Docker Network Isolation

**Issue:** Docker containers on bridge networks can't reach Tailscale IPs (100.x.x.x) or LAN.

**Impact:** Fractal agents can't SSH to devices, access local services, etc.

**Solutions:**
1. **Install Tailscale in container** (recommended) — gives agent its own Tailscale identity, use ACLs to control access
2. **Use `network: "host"`** (simple but less secure) — shares host network stack
3. **SSH ProxyJump via host** (complex) — container SSHs to host first, then to target

### 4.7 Orphaned Sessions

**Issue:** When bindings change, old sessions may belong to agents that no longer handle that room.

**Impact:** Sessions show stale token counts, aren't cleaned by daily reset.

**Solution:** After adding/removing bindings, manually clean orphaned sessions from `~/.openclaw/agents/*/sessions/sessions.json`.

### 4.8 No Independent Config Methods

**Issue:** OpenClaw has no API to update a single agent config without touching `agents.list`.

**Impact:** Must always use read-modify-write on the full list, increasing corruption risk.

**Future improvement:** Add endpoints like:
- `gateway.agents.update(id, config)` — Update single agent
- `gateway.bindings.add(binding)` — Add single binding
- `gateway.bindings.remove(agentId)` — Remove binding

---

## Part 5: Synapse Admin API Reference

### Create Room

```bash
curl -X POST "http://localhost:8008/_matrix/client/v3/createRoom" \
  -H "Authorization: Bearer $BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Room Name",
    "preset": "private_chat",
    "invite": ["@user:server"]
  }'
```

### Invite User

```bash
curl -X POST "http://localhost:8008/_matrix/client/v3/rooms/$ROOM_ID/invite" \
  -H "Authorization: Bearer $BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "@user:server"}'
```

### Set Display Name

```bash
curl -X PUT "http://localhost:8008/_matrix/client/v3/rooms/$ROOM_ID/state/m.room.member/@bot:server" \
  -H "Authorization: Bearer $BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"membership": "join", "displayname": "Custom Name"}'
```

### Generate Registration Token

```bash
curl -X POST "http://localhost:8008/_synapse/admin/v1/registration_tokens/new" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"uses_allowed": 1}'
```

### List Room Members

```bash
curl "http://localhost:8008/_matrix/client/v3/rooms/$ROOM_ID/joined_members" \
  -H "Authorization: Bearer $BOT_TOKEN"
```

### Purge Room History

```bash
NOW_MS=$(date +%s)000
curl -X POST "http://localhost:8008/_synapse/admin/v1/purge_history/$ROOM_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"purge_up_to_ts\": $NOW_MS, \"delete_local_events\": true}"
```

**Note:** This only deletes message events, not media files. Use media admin API separately.

### Delete Media

```bash
# List media in room
curl "http://localhost:8008/_synapse/admin/v1/room/$ROOM_ID/media" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Delete specific media
curl -X DELETE "http://localhost:8008/_synapse/admin/v1/media/your-homeserver.example.com/$MEDIA_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

---

## Part 6: Recommendations

### For Production Fractal API

1. **Implement pre-flight validation:**
   - Check `agents.list.length` before patch
   - Verify room has 3+ members before binding
   - Validate binding order (no catch-alls before specific)

2. **Add atomic operations:**
   - Create transaction log of config changes
   - Implement rollback on failure
   - Auto-backup before each write

3. **Add dedicated API methods:**
   - `createAgent(id, config)` — handles full workflow
   - `deleteAgent(id)` — cleanup workspace, bindings, sessions
   - `listAgents()` — query current agents
   - `getAgent(id)` — get single agent config

4. **Implement limits:**
   - Max fractal agents per parent (e.g., 10)
   - Workspace quota enforcement
   - Rate limiting on agent creation

5. **Add monitoring:**
   - Alert on `agents.list.length` changes
   - Log all config mutations
   - Track orphaned sessions

6. **Improve safety:**
   - Require confirmation for destructive operations
   - Add "dry run" mode for config changes
   - Implement config version history

### For Mox LXC Setup

> **⚠️ Architecture Update (2026-02-21):** The original analysis below assumed everything stays on the admin LXC. The actual plan uses a **two-LXC model** — see README.md for the current architecture.

The target architecture separates admin and execution planes:

```
Proxmox Host
├─ Admin LXC (admin plane — locked down)
│   ├─ OpenClaw Gateway (manages ALL agents)
│   ├─ Synapse (Matrix server)
│   ├─ All API keys, configs, admin tokens
│   └─ Admin Agent (handles fractal creation via admin room)
│
└─ Mox LXC (Execution Plane — agent has root)
    ├─ Docker daemon (exposed via TCP to the admin LXC)
    ├─ Agent workspaces (mounted via sshfs on the admin LXC)
    ├─ Fractal sub-agent Docker containers
    └─ Programs agent installs as needed
```

**Key differences from the original single-LXC analysis:**
- Docker commands from OpenClaw go to the **remote** Docker daemon on Mox LXC via `DOCKER_HOST=tcp://...` (requires OpenClaw patch — see `openclaw-docker-host-patch.md`)
- Workspaces live on Mox LXC, mounted on the admin LXC via sshfs for OpenClaw to read config files
- Matrix/Synapse stays on the admin LXC — Mox never gets direct Matrix admin access
- Fractal creation uses a **human-in-the-loop admin room** instead of a programmatic API
- The Fractal API code is still valid for the plumbing (config management, room creation, workspace scaffolding) but may be used by the admin agent rather than called directly by Mox

**Security rationale:** Keeping the admin plane on the admin LXC prevents prompt injection attacks from accessing API tokens, channel credentials, or Matrix admin capabilities. The agent gets root on its own LXC but can't touch the admin plane.

---

## Appendix A: Full Example Config Snippets

### Agent Entry

```json
{
  "id": "fractal-agent-x",
  "workspace": "/var/lib/clawdbot/workspace/agents/fractal-agent-x",
  "model": {
    "primary": "anthropic/claude-sonnet-4-5",
    "fallbacks": ["anthropic/claude-haiku-4-5"]
  },
  "sandbox": {
    "mode": "all",
    "workspaceAccess": "rw",
    "docker": {
      "image": "mox-sandbox:latest",
      "network": "mox-internet",
      "user": "996:1100",
      "readOnlyRoot": false
    }
  }
}
```

### Binding

```json
{
  "agentId": "fractal-agent-x",
  "match": {
    "channel": "matrix",
    "peer": {
      "kind": "channel",
      "id": "!AbCdEfGhIjKlMnOpQr:your-homeserver.example.com"
    }
  }
}
```

### Group Config

```json
{
  "!AbCdEfGhIjKlMnOpQr:your-homeserver.example.com": {
    "autoReply": true
  }
}
```

---

## Appendix B: Safety Checklist

Before deploying Fractal API to production:

- [ ] Implement `agents.list.length` validation
- [ ] Add pre-flight check for binding order
- [ ] Test rollback from `.bak` files
- [ ] Verify 3+ member requirement enforcement
- [ ] Test file ownership after workspace creation
- [ ] Verify sandbox UID/GID matching
- [ ] Test gateway restart after config changes
- [ ] Implement orphaned session cleanup
- [ ] Add logging for all config mutations
- [ ] Test failure modes (network down, disk full, etc.)
- [ ] Document recovery procedures
- [ ] Add rate limiting
- [ ] Implement agent creation limits
- [ ] Test concurrent creation (race conditions)
- [ ] Verify Matrix room cleanup on agent deletion

---

## Summary

Creating a fractal agent requires orchestrating three systems:

1. **Matrix (Synapse):** Create room, invite users, ensure 3+ members
2. **OpenClaw:** Add agent to `agents.list`, create binding, enable auto-reply (using **read-modify-write pattern**)
3. **Host:** Create workspace directory, set permissions, restart gateway

The most critical safety requirement is the **read-modify-write pattern** for `agents.list` — partial patches have caused catastrophic service outages twice. Always read the full config, modify in place, write back the complete list, and validate before/after.

Routing is **first-match** — specific bindings must come before catch-alls. Fractal agents are isolated to their designated rooms by giving them specific bindings with no catch-all.

The LXC setup is **transparent** — Mox sees all APIs as localhost, no special handling needed.
