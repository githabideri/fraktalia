# Mox Sandbox Architecture

## Overview
Mox runs in a Docker container managed by OpenClaw's sandbox system. The container provides full isolation with network access controlled by Docker networking and Tailscale ACLs.

## Image: `mox-sandbox:latest`
- **Base:** `clawdbot-sandbox:bookworm-slim`
- **Packages:** 692 (Python 3.11, Node 18, ffmpeg 5.1.8, openssh-client, git, jq, ripgrep, pandoc, curl, sudo)
- **No texlive** — causes OOM during post-install format generation even at 16GB
- **User:** `mox` (UID 996, GID 1100 `openclaw-agents`)
- **Dockerfile:** `docker/mox-sandbox/Dockerfile`

## Permission Model

Two systems write to the workspace:
1. **Host-side** OpenClaw Write/Edit tools → run as `clawdbot` (UID 996)
2. **Container-side** shell commands → run as `mox` (UID 996, GID 1100)

Both use UID 996, so no permission conflicts. Workspace is owned `clawdbot:openclaw-agents` (996:1100) with mode 775.

### OpenClaw Config (agents.list)
```json
{
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

## Build Requirements
- **16GB+ host memory** for Docker builds with 600+ packages (export phase is memory-intensive)
- Build time: ~165s (105s apt install + 48s export + 12s unpack)
- Adding a single package to the apt layer invalidates cache for the entire layer

## Known Limitations

| Issue | Detail | Workaround |
|-------|--------|------------|
| `no-new-privileges` | Hardcoded in OpenClaw (`docker.ts:161`), no config toggle | Can't use sudo; bake everything into image |
| texlive OOM | `Building format(s) --all` kills at 16GB | Don't include texlive; install at runtime if needed |
| pip PEP 668 | System Python refuses pip install | Use `--break-system-packages` flag |
| uv path | Installed at `/root/.local/bin` during build (as root) | Not in mox's PATH; use pip instead |
| Binary file transfer | Write tool is text-only | Binary files from SSH stay in /tmp, can't be sent as attachments |
| config.patch arrays | Destroys entire agents.list | Use surgical Edit tool for per-agent config changes |

## Network
- `mox-internet` Docker bridge: open outbound, Tailscale ACLs restrict
- Tailscale IPs (100.x.x.x) may not be reachable from bridge network
- Options: `network: "host"`, Tailscale in container, or SSH ProxyJump

## SSH
- Keys: `agents/mox/.ssh/id_ed25519_vogl`
- Config: `agents/mox/.ssh/config` (ControlMaster multiplexing)
- Target: `vogl@100.87.103.34` (Raspberry Pi, vogelhaus project)
