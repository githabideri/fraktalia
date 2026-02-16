# Fraktalia

**A self-hosted group chat with an AI agent that actually lives there.**

## What is this?

Fraktalia is a recipe for running a private, self-hosted group chat where an AI agent is a full participant — using [Matrix](https://matrix.org/) for the chat platform and [OpenClaw](https://github.com/openclaw/openclaw) for the AI agent.

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

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│  Element /   │────▶│   Matrix     │────▶│    OpenClaw      │
│  any client  │     │  (Synapse)   │     │   Gateway        │
└─────────────┘     └──────────────┘     └────────┬────────┘
                                                   │
                                          ┌────────▼────────┐
                                          │  Agent Session   │
                                          │  (Claude/GPT/…) │
                                          └────────┬────────┘
                                                   │
                                          ┌────────▼────────┐
                                          │ Docker Sandbox   │
                                          │ Python, Node,    │
                                          │ ffmpeg, SSH, …   │
                                          └──────────────────┘
```

**Key pieces:**
- **Matrix homeserver** (Synapse) — the chat platform. Self-hosted, federated, encrypted.
- **OpenClaw** — the AI gateway. Connects to Matrix, manages agent sessions, provides tools.
- **Docker sandbox** — isolated container where the agent runs code. Custom image with everything the agent might need.
- **Tailscale** (optional) — private network so friends can access your homeserver without exposing it to the internet.

## What's in this repo

```
fraktalia/
├── README.md                          ← you are here
├── docker/
│   └── mox-sandbox/Dockerfile         ← custom sandbox image
├── docs/
│   ├── sandbox-architecture.md        ← permission model, build notes, gotchas
│   └── room-setup-template.md         ← step-by-step setup template
├── scripts/
│   ├── mox-network-firewall.sh        ← network isolation script
│   ├── mox-firewall.service           ← systemd service for above
│   └── mox-port-forward.py           ← TCP forwarder: host → sandbox container
└── logs/                              ← runtime logs (gitignored)
```

## Quick Start

### Prerequisites
- A machine to host everything (Linux, 4GB+ RAM, more for Docker builds)
- A [Matrix homeserver](https://element-hq.github.io/synapse/latest/setup/installation.html) running (Synapse, Conduit, Dendrite, etc.)
- [OpenClaw](https://github.com/openclaw/openclaw) installed
- Docker installed
- (Optional) Tailscale for private access

### 1. Build the sandbox image

```bash
cd docker/mox-sandbox
docker build -t agent-sandbox:latest .
```

> ⚠️ Builds with 600+ packages need **16GB+ host memory** for Docker's export phase. See [sandbox-architecture.md](docs/sandbox-architecture.md) for details.

### 2. Configure your agent

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
      "readOnlyRoot": false
    }
  }
}
```

### 3. Bind agent to your Matrix room

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

### 4. Invite friends

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

## Lessons Learned

Things we figured out the hard way so you don't have to:

- **texlive kills Docker builds.** The `Building format(s) --all` post-install step OOMs even at 16GB. Don't include it in your image unless you actually need LaTeX. Install it at runtime if needed.
- **Permission model matters.** OpenClaw's Write/Edit tools run on the host side, shell commands run inside the container. If they run as different UIDs, you get permission hell. Solution: create a user in the Docker image with the same UID as your host user, and use a shared group.
- **`no-new-privileges` is hardcoded** in OpenClaw's sandbox. sudo won't work even if installed. Bake everything into the image.
- **`config.patch` destroys arrays.** If you need to edit a specific agent in `agents.list`, use surgical file edits, not the config.patch API.
- **Docker cache is fragile.** Adding one package to an apt layer invalidates the entire layer. Group your packages carefully.

## Customization

The Dockerfile is intentionally broad — Python, Node, ffmpeg, SSH, git, and common tools. Trim it for your use case:

- **Just chat + web?** Remove ffmpeg, pandoc, most node packages
- **Media creation?** Add manim, imagemagick, or whatever your agent needs
- **Hardware access?** SSH keys go in the agent's workspace `.ssh/` directory

## License

MIT — do whatever you want with it.
