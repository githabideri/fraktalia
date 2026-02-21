# OpenClaw Remote Sandbox Investigation
**Date:** 2026-02-21  
**Investigator:** felix (subagent)  
**Goal:** Determine if OpenClaw can use a remote Docker daemon or SSH for agent sandboxes

---

## Executive Summary

**Investigation 1: Remote Docker Host** — ❌ **Not currently supported**  
OpenClaw's Docker sandbox implementation does NOT support configuring a remote Docker daemon (via `DOCKER_HOST` or TCP socket) on a per-agent basis. All Docker commands execute against the local Docker socket.

**Investigation 2: SSH-based Execution** — ❌ **Not currently supported**  
OpenClaw does NOT support SSH-based remote execution for sandbox environments. There is no built-in mechanism to redirect tool execution over SSH.

**Tool Routing:** Only `exec` runs inside Docker containers when sandboxed. `read`, `write`, and `edit` operate directly on the filesystem (the workspace is bind-mounted into the container).

---

## Investigation 1: Remote Docker Host per Agent

### Current Configuration (Agent Mox)
```json
{
  "mode": "all",
  "workspaceAccess": "rw",
  "docker": {
    "image": "mox-sandbox:latest",
    "readOnlyRoot": false,
    "network": "mox-internet",
    "user": "996:1100"
  }
}
```

**Available Docker Config Options** (`SandboxDockerConfig` from `src/agents/sandbox/types.docker.ts`):
- `image`, `containerPrefix`, `workdir`
- `readOnlyRoot`, `tmpfs[]`, `network`, `user`
- `capDrop[]`, `env{}`, `setupCommand`
- `pidsLimit`, `memory`, `memorySwap`, `cpus`, `ulimits{}`
- `seccompProfile`, `apparmorProfile`
- `dns[]`, `extraHosts[]`, `binds[]`

**Missing:** `host`, `socket`, `endpoint`, or any equivalent parameter for specifying a remote Docker daemon.

### How Docker Commands Are Executed
**Source:** `/opt/openclaw/src/agents/sandbox/docker.ts`

All Docker operations use the `execDocker()` function:
```typescript
export function execDocker(args: string[], opts?: { allowFailure?: boolean }) {
  return new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
    const child = spawn("docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    // ...
  });
}
```

**Key Finding:** The `spawn("docker", args, ...)` call does NOT pass any custom environment variables. It inherits the gateway process's environment.

### Can DOCKER_HOST Be Used?
The Docker CLI respects the `DOCKER_HOST` environment variable **if present** in the process environment. However:

1. **Global only:** Setting `DOCKER_HOST` in the gateway's environment would affect ALL agents, not just Mox.
2. **No per-agent env:** The `sandbox.docker.env` config only sets environment variables **inside** the container, not for the `docker` CLI itself.
3. **No config support:** There's no OpenClaw config field to specify a Docker host/socket per agent.

### Workaround Feasibility
**Possible (with code changes):**
1. Add a `sandbox.docker.dockerHost` config field (string, e.g., `"tcp://192.168.0.100:2375"`)
2. Modify `execDocker()` to accept an optional `dockerHost` parameter
3. Pass `{ env: { ...process.env, DOCKER_HOST: dockerHost } }` in the `spawn()` options
4. Route this config through `ensureSandboxContainer()` and all Docker operations

**Estimated Effort:** Medium (a few hours of development + testing)
- Requires editing: `types.docker.ts`, `docker.ts`, and config schema
- Must ensure DOCKER_HOST is threaded through all Docker calls (create, start, exec, inspect, rm, port)
- Security consideration: remote Docker hosts without TLS are insecure; would need TLS support

**Alternative Approach (Docker Context):**  
OpenClaw could use `docker --context <name>` instead of `DOCKER_HOST`. This would require:
- Adding `sandbox.docker.context` config field
- Modifying `execDocker()` to prepend `["--context", context]` when present
- More flexible than DOCKER_HOST (supports TLS, named configs)

---

## Investigation 2: SSH-based Sandbox/Execution

### Current Remote Execution Support
OpenClaw has SSH infrastructure (`/opt/openclaw/src/infra/ssh-tunnel.ts`, `ssh-config.ts`), but it's used for:
- Gateway tunneling (macOS app ↔ remote gateway)
- Not for sandbox/tool execution

### Exec Tool Routing
**Source:** `/opt/openclaw/src/agents/bash-tools.exec.ts`

The `exec` tool supports three execution targets (`host` parameter):
1. **`sandbox`** — Run inside Docker container (via `docker exec`)
2. **`gateway`** — Run on the gateway host (no sandbox)
3. **`node`** — Run on a paired node device (via `requestExecHostViaSocket()`)

**Node execution** uses a local socket protocol (`ExecHostRequest` over UNIX socket), not SSH.

### How Exec Runs in Sandbox Mode
When `sandbox` is enabled, the exec tool:
1. Calls `buildDockerExecArgs()` to construct `docker exec -i [-t] <container> sh -c <command>`
2. Spawns the `docker` process locally
3. Pipes stdin/stdout/stderr

**No SSH:** All execution is local to the gateway host.

### Read/Write/Edit Tools
These tools are NOT routed through Docker. They use `createReadTool(root)` / `createWriteTool(root)` / `createEditTool(root)` from the `pi-coding-agent` library, which operates directly on the filesystem.

**How it works in sandbox mode:**
- The workspace directory is bind-mounted into the container (e.g., `-v /host/workspace:/workspace:rw`)
- Read/write/edit tools on the gateway manipulate files in `/host/workspace`
- Changes are immediately visible inside the container at `/workspace`

**Implication:** For SSH-based remote execution, you'd need to:
1. Sync the workspace over SSH (rsync, sshfs, NFS, etc.)
2. Proxy exec commands via SSH
3. Proxy read/write/edit operations via SSH (or use a shared filesystem)

---

## What Would SSH-based Execution Require?

### Minimal Approach (Exec Only)
1. Add a new exec `host` type: `"ssh"`
2. Add config fields: `sandbox.ssh.host`, `sandbox.ssh.user`, `sandbox.ssh.keyPath`
3. Modify `runExecProcess()` to spawn `ssh user@host <command>` instead of `docker exec`
4. Limitation: Read/write/edit would still be local (files must be accessible on both systems)

### Full Approach (All Tools)
1. SSH-based exec (as above)
2. Remote filesystem access:
   - **SSHFS:** Mount remote workspace via SSHFS (simple but slow)
   - **NFS/SMB:** Shared filesystem (faster, more setup)
   - **Proxy read/write/edit:** Send file operations over SSH (complex)
3. Estimated Effort: High (1-2 weeks, significant testing required)

---

## Recommendations

### For Remote Docker (admin LXC → CT342)
**Option A: Wait for official support**  
File a feature request for `sandbox.docker.dockerHost` or `sandbox.docker.context` config.

**Option B: Workaround with global DOCKER_HOST**  
Set `DOCKER_HOST=tcp://192.168.0.100:2375` in the gateway's environment (affects ALL agents).

**Option C: Docker proxy/relay**  
Run a Docker socket proxy on the admin LXC that forwards to CT342:
```bash
# On the admin LXC
socat UNIX-LISTEN:/var/run/docker.sock,fork TCP:192.168.0.100:2375
```
Risk: Security (unencrypted Docker API), affects all agents.

**Option D: Custom patch**  
Fork OpenClaw, add `sandbox.docker.dockerHost` config, submit PR upstream.

### For SSH-based Execution
**Not Recommended** — High complexity, limited benefit. Better to:
1. Use Docker-based sandboxing locally
2. Or run the entire gateway on the target machine (CT342) and remote-access via SSH tunnel

---

## Code References

### Docker Implementation
- **Main file:** `/opt/openclaw/src/agents/sandbox/docker.ts`
- **Type definitions:** `/opt/openclaw/src/agents/sandbox/types.docker.ts`
- **Exec tool:** `/opt/openclaw/src/agents/bash-tools.exec.ts`
- **Docker exec command builder:** `buildDockerExecArgs()` in `bash-tools.shared.ts`

### Key Functions
- `execDocker(args)` — Spawns `docker` CLI (no env customization)
- `ensureSandboxContainer(params)` — Creates/starts container
- `buildSandboxCreateArgs(params)` — Constructs `docker create` args
- `runExecProcess(opts)` — Routes exec to sandbox/gateway/node

### SSH Infrastructure (Not Used for Sandbox)
- `/opt/openclaw/src/infra/ssh-tunnel.ts` — SSH tunneling (for gateway connection)
- `/opt/openclaw/src/infra/exec-host.ts` — Node exec via socket (not SSH)

---

## Current Mox Config (Full)
```bash
cat /var/lib/clawdbot/.openclaw/openclaw.json | jq '.agents.list[] | select(.id=="mox")'
```

**Sandbox excerpt:**
```json
{
  "sandbox": {
    "mode": "all",
    "workspaceAccess": "rw",
    "docker": {
      "image": "mox-sandbox:latest",
      "readOnlyRoot": false,
      "network": "mox-internet",
      "user": "996:1100"
    }
  }
}
```

---

## Conclusion

**Remote Docker Host:** Not supported out-of-the-box. Requires code changes (medium effort).  
**SSH Execution:** Not supported. High complexity to implement properly.  
**Best Path Forward:** File a feature request or submit a PR adding `sandbox.docker.dockerHost` config support.

---

## Next Steps
1. Decide if remote Docker is critical for Mox
2. If yes: Consider patching OpenClaw locally or contributing upstream
3. If no: Run Mox's Docker containers locally on the admin LXC (current setup)
4. For true remote execution: Move the entire gateway to CT342 instead of just containers
