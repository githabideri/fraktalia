# Fraktalia

**A self-hosted group chat with an AI agent that actually lives there.**

## What is this?

Fraktalia is a recipe for running a private Matrix room where an AI agent (powered by [OpenClaw](https://github.com/openclaw/openclaw)) is a full participant — not a bot you @mention, but a member of the group who can see conversations, remember context, run code, SSH into devices, and create things.

Friends connect via Tailscale (or any private network), chat in Element (or any Matrix client), and the agent participates naturally alongside everyone else.

## Why?

Most AI chat setups are 1:1 — you talk to a bot, it talks back. That's useful but boring.

What if your friend group had a shared AI that:
- Remembers what you talked about last week
- Can write and run code in a sandboxed environment
- Has SSH access to hardware (a Raspberry Pi, a server, whatever)
- Creates visualizations, analyzes data, fetches things from the web
- Has its own personality and evolves over time
- Runs on your infrastructure, not someone else's cloud

That's what this sets up.

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
└── scripts/
    ├── mox-network-firewall.sh        ← network isolation script
    └── mox-firewall.service           ← systemd service for above
```

## Quick Start

### Prerequisites
- A machine to host everything (Linux, 4GB+ RAM, more for Docker builds)
- [Matrix Synapse](https://matrix-org.github.io/synapse/latest/setup/installation.html) running
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
