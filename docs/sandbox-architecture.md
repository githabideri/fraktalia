# Sandbox Architecture

## Overview

The agent runs inside a Docker container managed by OpenClaw's sandbox system. This gives the agent a full Linux environment (shell, Python, Node, ffmpeg, etc.) while keeping it isolated from the host.

## How it works

Two systems write to the agent's workspace:

1. **Host-side tools** (OpenClaw's Write/Edit) — run as the host service user
2. **Container-side shell** (exec tool) — run as the container user

If these run as different UIDs, you get permission conflicts. The solution:

### Matching UIDs

Create a user inside the Docker image with the **same UID** as your host service user:

```dockerfile
# Example: host service runs as UID 1000, GID 1000
RUN groupadd -g 1000 agent-group && \
    useradd -u 1000 -g 1000 -d /workspace -s /bin/bash -M agent
```

Then configure OpenClaw to run the container as that user:

```json
{
  "sandbox": {
    "docker": {
      "user": "1000:1000"
    }
  }
}
```

Set workspace ownership to match:
```bash
chown -R 1000:1000 /path/to/agent/workspace
chmod -R 775 /path/to/agent/workspace
```

## Docker Image

The included Dockerfile builds a general-purpose sandbox with ~690 packages:

| Category | Packages |
|----------|----------|
| Languages | Python 3.11, Node 18 |
| Media | ffmpeg, cairo, pango |
| Dev tools | git, jq, ripgrep, curl, wget |
| Documents | pandoc |
| Network | openssh-client |
| Package mgmt | pip, uv, npm |

### What's NOT included (and why)

- **texlive** — The `Building format(s) --all` post-install step consumes enormous memory (OOM at 16GB). Install at runtime if needed.
- **manim** — Dependencies are present (cairo, pango, ffmpeg), but pip install is left to the user/agent.
- **GUI tools** — No X11/display. This is a headless environment.

## Build Requirements

- **Memory:** 16GB+ host RAM for builds with 600+ packages. The Docker export phase is the bottleneck.
- **Disk:** ~2.5GB for the final image
- **Time:** ~3 minutes (download + install + export)
- **Cache:** Adding a single package to the apt layer invalidates the entire layer. Group carefully.

## Known Limitations

| Issue | Detail | Workaround |
|-------|--------|------------|
| `no-new-privileges` | Hardcoded in OpenClaw sandbox. No config toggle. | Can't use sudo. Bake everything into the image. |
| pip PEP 668 | System Python refuses global pip install | Use `--break-system-packages` flag |
| Binary file transfer | OpenClaw's Write tool is text-only | Binary files from SSH/downloads stay in container `/tmp/` |
| Config array editing | `config.patch` API destroys `agents.list` arrays | Use surgical file edits for per-agent config changes |

## Network

By default, OpenClaw creates a Docker bridge network for the sandbox. This provides internet access but:

- **Tailscale IPs** (100.x.x.x) won't be reachable from the bridge — Tailscale runs on the host, not in the container
- **Options:** Use `network: "host"` (simple, less isolation), run Tailscale in the container, or SSH ProxyJump through the host

## SSH Access

To give the agent SSH access to external machines:

1. Generate a key pair in the agent's workspace: `.ssh/id_ed25519`
2. Deploy the public key to the target
3. Create `.ssh/config` with connection details
4. Set permissions: `chmod 700 .ssh && chmod 600 .ssh/id_ed25519`

The container needs a `/etc/passwd` entry for the running UID, or SSH will fail with "No user exists for uid X". This is handled by the `useradd` in the Dockerfile.
