# Fraktalia

**A self-hosted group chat with an AI agent that actually lives there.**

## What is this?

Fraktalia is a recipe for running a private, self-hosted group chat where an AI agent is a full participant — using [Matrix](https://matrix.org/) for the chat platform and [OpenClaw](https://github.com/openclaw/openclaw) for the AI agent.

Beyond a single room, Fraktalia includes the **Fractal API** — a system for dynamically creating sub-agents ("fractals") with dedicated Matrix rooms, each running in isolated Docker containers on a separate execution LXC.

## Why Matrix?

OpenClaw supports many messaging platforms — WhatsApp, Telegram, Discord, Signal, and more. Most people use one of those. So why bother with Matrix?

**Control.** With WhatsApp or Telegram, you're giving an AI agent access to your real account on someone else's platform. Your conversations pass through their servers. You're bound by their terms of service. If they change their API, your setup breaks.

With a self-hosted Matrix homeserver:
- **Everything runs on your hardware.** Messages, media, encryption keys — all yours.
- **The network is isolated.** Your homeserver doesn't need to be on the public internet. Friends connect via Tailscale or VPN.
- **You control the accounts.** Create dedicated Matrix users, manage permissions, revoke access — no platform politics.
- **The agent can administer the server.** OpenClaw agents can manage Matrix rooms, users, and permissions — your AI helps run the infrastructure it lives on.
- **No vendor lock-in.** Matrix is an open, federated protocol. Any client works (Element, FluffyChat, etc.). You can federate with other servers or keep it fully private.

**The tradeoff:** More setup than connecting a Telegram bot. This repo is here to make that setup manageable.

## Architecture

Fraktalia uses a **two-LXC model** — the admin plane and execution plane are physically separated:

```
Proxmox Host
│
├─ Admin LXC (Admin Plane — locked down; example: the admin LXC)
│   ├─ OpenClaw Gateway (manages ALL agents)
│   ├─ Matrix Synapse (homeserver)
│   ├─ All API keys, channel configs, agent configs
│   ├─ Fraktalia Admin Room (human-in-the-loop approval)
│   └─ Admin Agent (executes approved fractal proposals)
│
└─ Agent LXC (Execution Plane — agent has root; example: Mox)
    ├─ Docker daemon (fractal sub-agent containers)
    ├─ Agent workspaces + memory
    ├─ Programs agent installs as needed
    └─ Full root access (isolated from admin plane)
```

**How it connects:**

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│  Element /   │────▶│   Matrix     │────▶│    OpenClaw      │
│  any client  │     │  (Synapse)   │     │   Gateway        │
└─────────────┘     │  (Admin LXC) │     │   (Admin LXC)    │
                     └──────────────┘     └────────┬────────┘
                                                    │
                              DOCKER_HOST=tcp://... │
                                                    │
                                          ┌─────────▼────────┐
                                          │   Agent LXC       │
                                          │   Docker Daemon    │
                                          │  ┌──────────────┐ │
                                          │  │ Agent Sandbox │ │
                                          │  │ Python, Node, │ │
                                          │  │ ffmpeg, SSH,… │ │
                                          │  └──────────────┘ │
                                          └──────────────────┘
```

**Key pieces:**
- **Matrix homeserver** (Synapse) on admin LXC — the chat platform. Self-hosted, federated, encrypted.
- **OpenClaw** on admin LXC — the AI gateway. Connects to Matrix, manages agent sessions, provides tools. Controls the admin plane.
- **Agent LXC** — separate Proxmox container where the agent has root access. Docker containers for sub-agents run here. Agent can install programs, manage its own environment.
- **Remote Docker** — OpenClaw on the admin LXC sends Docker commands to the agent LXC's Docker daemon via TCP (`DOCKER_HOST`). Requires a small OpenClaw patch (see `docs/openclaw-docker-host-patch.md`).
- **sshfs** — Agent workspaces live on agent LXC; admin LXC mounts them via sshfs so OpenClaw can read config files.
- **Tailscale** (optional) — private network so friends can access your homeserver without exposing it to the internet.

### Why Two LXCs?

**Security.** The admin plane (API keys, agent configs, Matrix admin tokens, channel integrations) stays on the admin LXC where only the human operator has access. Even if a prompt injection attack compromises the agent, it can't:
- Steal API tokens or channel credentials
- Add new messaging integrations
- Modify other agents' configs
- Access the Matrix admin API directly

The agent gets root on its own LXC — it can install programs, manage Docker images, create unix users for sub-agents — but it can't touch the admin plane.

### Fractal Creation Workflow

Instead of an API service, fractal creation uses a **human-in-the-loop admin room** (preferred approach):

1. **Agent** decides a new fractal room would be useful
2. **Agent** posts a proposal in the Fraktalia Admin Room (private, operator-only)
3. **Operator** reviews and approves/modifies/rejects
4. **Admin Agent** on admin LXC executes: creates Matrix room, adds OpenClaw agent config, sets up workspace, wires bindings
5. Fractal is live

This is simpler and more secure than a programmatic API — no token management, no slot system, full human oversight.

**Note on the Fractal API:** The `fractal-api/` directory contains a complete Node.js implementation of a programmatic HTTP API for fractal creation. This serves as a **reference implementation** and **library for the plumbing logic** (Matrix room creation, OpenClaw config management, workspace scaffolding). The admin room workflow above is recommended for actual deployments — the Fractal API code provides the building blocks that the admin agent can use.

## What's in this repo

```
fraktalia/
├── README.md                              ← you are here
├── FRACTAL_API_COMPLETE.md               ← implementation status & summary
├── docker/
│   └── mox-sandbox/Dockerfile             ← custom sandbox image
├── docs/
│   ├── sandbox-architecture.md            ← permission model, build notes, gotchas
│   ├── room-setup-template.md             ← step-by-step setup template
│   ├── fractal-api-draft.md               ← Fractal API design & implementation doc
│   ├── fractal-api-plumbing.md            ← OpenClaw plumbing research (routing, config)
│   ├── openclaw-docker-host-patch.md      ← Patch spec for remote Docker support
│   └── openclaw-remote-sandbox-investigation.md ← Investigation of OC sandbox options
├── fractal-api/                           ← Fractal API implementation (Node.js)
│   ├── server.js                          ← HTTP server (~440 lines)
│   ├── lib/                               ← Client libraries (matrix, openclaw, workspace)
│   ├── config.example.json                ← Config template
│   ├── fractal-api.service                ← systemd unit
│   ├── README.md                          ← API documentation
│   ├── INSTALL.md                         ← Installation guide
│   └── test-health.sh                     ← Health check script
├── scripts/
│   ├── mox-network-firewall.sh            ← network isolation script
│   ├── mox-firewall.service               ← systemd service for above
│   └── mox-port-forward.py               ← TCP forwarder: host → sandbox container
└── logs/                                  ← runtime logs (gitignored)
```

### Implementation Status

The **Fractal API** (`fractal-api/`) is a complete Node.js implementation (~1,250 lines, zero deps) that handles programmatic agent creation. It was built for a single-LXC architecture and will need adaptation for the two-LXC model:

- **Still valid:** Matrix room creation, OpenClaw config management (read-modify-write pattern), workspace scaffolding, binding management, rollback logic
- **Needs update:** Docker sandbox config (add `dockerHost`), workspace paths (point to Mox LXC), network config
- **May be replaced by:** The admin room workflow (simpler, more secure, human-in-the-loop)

The **dockerHost patch** for OpenClaw is specced but not yet implemented — see `docs/openclaw-docker-host-patch.md`.

## Quick Start

### Prerequisites
- A machine to host everything (Linux, 4GB+ RAM, more for Docker builds)
- A [Matrix homeserver](https://element-hq.github.io/synapse/latest/setup/installation.html) running (Synapse, Conduit, Dendrite, etc.)
- [OpenClaw](https://github.com/openclaw/openclaw) installed
- Docker installed
- Proxmox (for the two-LXC setup) or a single Linux host (simpler, less isolation)
- (Optional) Tailscale for private access

### 1. Build the sandbox image

```bash
cd docker/mox-sandbox
docker build -t agent-sandbox:latest .
```

> ⚠️ Builds with 600+ packages need **16GB+ host memory** for Docker's export phase. See [sandbox-architecture.md](docs/sandbox-architecture.md) for details.

### 2. Set up the execution LXC (two-LXC mode)

Create a new Proxmox LXC for the agent:
- **Storage:** 80GB (or as needed)
- **Networking:** Allow traffic to/from admin LXC
- **Docker:** Install Docker inside the LXC
- **Docker TCP:** Expose Docker daemon on TCP for remote access from admin LXC (firewall to admin LXC only)
- **sshfs:** Set up SSH key auth so admin LXC can mount workspaces

For single-host setups, skip this step — everything runs on one machine (less isolation but simpler).

### 3. Configure your agent

In your OpenClaw config (`openclaw.json`), add an agent with sandbox enabled:

```json
{
  "id": "your-agent",
  "sandbox": {
    "mode": "all",
    "workspaceAccess": "rw",
    "docker": {
      "image": "agent-sandbox:latest",
      "network": "your-network",
      "readOnlyRoot": false,
      "dockerHost": "tcp://mox-lxc-ip:2375"
    }
  }
}
```

> Note: `dockerHost` requires the OpenClaw patch described in `docs/openclaw-docker-host-patch.md`.

### 4. Bind agent to your Matrix room

Add a binding so the agent responds in your room:

```json
{
  "agentId": "your-agent",
  "match": {
    "channel": "matrix",
    "peer": { "kind": "group", "id": "!your-room-id:your-server" }
  }
}
```

### 5. Invite friends

Set up Tailscale (or another private network), create Matrix accounts for friends, and invite them to the room. The agent will be there waiting.

## Port Forwarding (Exposing Sandbox Services)

The sandbox container runs on an isolated Docker network. To make web services (or anything else) inside the container accessible from the host, LAN, or Tailscale, use the port forwarder:

```bash
# Forward host:9000 → container:9000
python3 scripts/mox-port-forward.py 9000

# Forward multiple ports
python3 scripts/mox-port-forward.py 9000 9001 9002
```

**Port range:** `9000-9099` is reserved for Fraktalia services. The forwarder enforces this range to avoid collisions with other host services.

**How it works:**
- Resolves the container IP dynamically via `docker inspect` on each incoming connection
- Survives container recreation (OpenClaw recreates sandbox containers on restart)
- No root required, no iptables, no extra containers

**Making it persistent:** Add to your system startup (root required):

```bash
# In /etc/rc.local or a systemd service:
su - clawdbot -c 'nohup python3 /path/to/fraktalia/scripts/mox-port-forward.py 9000 \
    >> /path/to/fraktalia/logs/port-forward.log 2>&1 &'
```

**Accessing from Tailscale:** Once forwarding, services are available at `http://clawdbot:9000` (or whatever MagicDNS name your host has).

**Convention:** Tell your agent to bind web servers to port 9000+ inside the container, not 8080 or other common ports that may conflict on the host.

**Location (two-LXC setup):** With the two-LXC architecture, the port forwarder runs on the **agent LXC** (where Docker is), not the admin LXC. This is because the Docker containers run on the agent LXC, and the forwarder needs access to the local Docker daemon to resolve container IPs.

> Note: With the two-LXC setup, port forwarding runs on the Mox LXC, not the admin LXC.

## Lessons Learned

Things we figured out the hard way so you don't have to:

- **texlive kills Docker builds.** The `Building format(s) --all` post-install step OOMs even at 16GB. Don't include it in your image unless you actually need LaTeX. Install it at runtime if needed.
- **Permission model matters.** OpenClaw's Write/Edit tools run on the host side, shell commands run inside the container. If they run as different UIDs, you get permission hell. Solution: create a user in the Docker image with the same UID as your host user, and use a shared group.
- **`no-new-privileges` is hardcoded** in OpenClaw's sandbox. sudo won't work even if installed. Bake everything into the image.
- **`config.patch` destroys arrays.** If you need to edit `agents.list`, always use the read-modify-write pattern — read full config, modify in place, write back complete list. This has caused two catastrophic outages (all agents deleted).
- **Docker cache is fragile.** Adding one package to an apt layer invalidates the entire layer. Group your packages carefully.
- **Matrix rooms need 3+ members.** Rooms with fewer than 3 members are treated as DMs, which breaks `peer.kind: "channel"` bindings. Always invite a padding user.
- **Binding order matters.** First match wins. Always add specific room bindings before the catch-all.
- **NFS doesn't work on unprivileged LXCs.** Use sshfs (FUSE-based, userspace) instead for cross-LXC filesystem access.

## Customization

The Dockerfile is intentionally broad — Python, Node, ffmpeg, SSH, git, and common tools. Trim it for your use case:

- **Just chat + web?** Remove ffmpeg, pandoc, most node packages
- **Media creation?** Add manim, imagemagick, or whatever your agent needs
- **Hardware access?** SSH keys go in the agent's workspace `.ssh/` directory

## License

MIT — do whatever you want with it.
