# OpenClaw Docker Host Patch Specification

**Goal:** Add per-agent `dockerHost` configuration to allow specific agents to use a remote Docker daemon via TCP (e.g., `tcp://192.168.0.X:2375`).

**Date:** 2026-02-21  
**Status:** Design Complete – Ready for Implementation

---

## Overview

OpenClaw currently spawns all Docker containers using the local Docker daemon (default socket `/var/run/docker.sock`). This patch adds a `dockerHost` configuration field that allows per-agent override to target a remote Docker daemon over TCP.

**Primary Use Case:**  
Run Docker containers on a remote LXC/VM while keeping the OpenClaw gateway on the admin LXC (which has limited resources and Docker disabled).

---

## Architecture Impact

### **Critical Constraint: Workspace Bind-Mounts**

The sandbox system bind-mounts the workspace directory into containers:

```typescript
// From docker.ts:235-238
args.push("-v", `${workspaceDir}:${cfg.workdir}${mainMountSuffix}`);
args.push("-v", `${params.agentWorkspaceDir}:${SANDBOX_AGENT_WORKSPACE_MOUNT}${agentMountSuffix}`);
```

**When using a remote Docker host:**
- `workspaceDir` path (e.g., `/var/lib/clawdbot/workspace/...`) must exist **on the remote Docker host**, not on the admin LXC
- This means:
  - Workspaces for remote-Docker agents must live on (or be mounted from) the remote host
  - OR: Use a shared filesystem (NFS, sshfs, etc.) mounted at the same path on both the admin LXC and the remote host
  - Config validation should warn if remote Docker host is configured without addressing workspace availability

**Recommendation:** For Fraktalia's setup:
- Mount the admin LXC's `/var/lib/clawdbot/workspace` on the remote LXC at the same path via NFS/sshfs
- OR: Store workspaces on the remote host and access via reverse mount/API

---

## Code Changes Required

### 1. **Add `dockerHost` to Type Definitions**

**File:** `/opt/openclaw/src/agents/sandbox/types.docker.ts`

```typescript
export type SandboxDockerConfig = {
  image: string;
  containerPrefix: string;
  workdir: string;
  readOnlyRoot: boolean;
  tmpfs: string[];
  network: string;
  user?: string;
  capDrop: string[];
  env?: Record<string, string>;
  setupCommand?: string;
  pidsLimit?: number;
  memory?: string | number;
  memorySwap?: string | number;
  cpus?: number;
  ulimits?: Record<string, string | number | { soft?: number; hard?: number }>;
  seccompProfile?: string;
  apparmorProfile?: string;
  dns?: string[];
  extraHosts?: string[];
  binds?: string[];
  
  // NEW: Remote Docker daemon address
  dockerHost?: string;
};
```

**Notes:**
- Format: `tcp://host:port`, `unix:///path/to/socket`, or `ssh://user@host`
- When unset, uses Docker's default (local socket)
- Validation in Zod schema should check format (basic URL validation)

---

### 2. **Add Zod Schema Validation**

**File:** `/opt/openclaw/src/config/zod-schema.agent-runtime.ts`

```typescript
export const SandboxDockerSchema = z
  .object({
    image: z.string().optional(),
    containerPrefix: z.string().optional(),
    workdir: z.string().optional(),
    readOnlyRoot: z.boolean().optional(),
    tmpfs: z.array(z.string()).optional(),
    network: z.string().optional(),
    user: z.string().optional(),
    capDrop: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    setupCommand: z.string().optional(),
    pidsLimit: z.number().int().positive().optional(),
    memory: z.union([z.string(), z.number()]).optional(),
    memorySwap: z.union([z.string(), z.number()]).optional(),
    cpus: z.number().positive().optional(),
    ulimits: z
      .record(
        z.string(),
        z.union([
          z.string(),
          z.number(),
          z
            .object({
              soft: z.number().int().nonnegative().optional(),
              hard: z.number().int().nonnegative().optional(),
            })
            .strict(),
        ]),
      )
      .optional(),
    seccompProfile: z.string().optional(),
    apparmorProfile: z.string().optional(),
    dns: z.array(z.string()).optional(),
    extraHosts: z.array(z.string()).optional(),
    binds: z.array(z.string()).optional(),
    
    // NEW: Docker host address (tcp://..., unix://..., ssh://...)
    dockerHost: z.string().optional(),
  })
  .strict()
  .optional();
```

**Optional Enhancement:**  
Add `.refine()` to validate `dockerHost` format:

```typescript
.refine(
  (val) => {
    if (!val?.dockerHost) return true;
    const host = val.dockerHost;
    return (
      host.startsWith("tcp://") ||
      host.startsWith("unix://") ||
      host.startsWith("ssh://") ||
      host.startsWith("fd://")
    );
  },
  {
    message: "dockerHost must start with tcp://, unix://, ssh://, or fd://",
    path: ["dockerHost"],
  }
)
```

---

### 3. **Add Config Type for User-Facing Settings**

**File:** `/opt/openclaw/src/config/types.sandbox.ts`

```typescript
export type SandboxDockerSettings = {
  /** Docker image to use for sandbox containers. */
  image?: string;
  /** Prefix for sandbox container names. */
  containerPrefix?: string;
  /** Container workdir mount path (default: /workspace). */
  workdir?: string;
  /** Run container rootfs read-only. */
  readOnlyRoot?: boolean;
  /** Extra tmpfs mounts for read-only containers. */
  tmpfs?: string[];
  /** Container network mode (bridge|none|custom). */
  network?: string;
  /** Container user (uid:gid). */
  user?: string;
  /** Drop Linux capabilities. */
  capDrop?: string[];
  /** Extra environment variables for sandbox exec. */
  env?: Record<string, string>;
  /** Optional setup command run once after container creation. */
  setupCommand?: string;
  /** Limit container PIDs (0 = Docker default). */
  pidsLimit?: number;
  /** Limit container memory (e.g. 512m, 2g, or bytes as number). */
  memory?: string | number;
  /** Limit container memory swap (same format as memory). */
  memorySwap?: string | number;
  /** Limit container CPU shares (e.g. 0.5, 1, 2). */
  cpus?: number;
  /**
   * Set ulimit values by name (e.g. nofile, nproc).
   * Use "soft:hard" string, a number, or { soft, hard }.
   */
  ulimits?: Record<string, string | number | { soft?: number; hard?: number }>;
  /** Seccomp profile (path or profile name). */
  seccompProfile?: string;
  /** AppArmor profile name. */
  apparmorProfile?: string;
  /** DNS servers (e.g. ["1.1.1.1", "8.8.8.8"]). */
  dns?: string[];
  /** Extra host mappings (e.g. ["api.local:10.0.0.2"]). */
  extraHosts?: string[];
  /** Additional bind mounts (host:container:mode format, e.g. ["/host/path:/container/path:rw"]). */
  binds?: string[];
  
  /**
   * Remote Docker daemon address (e.g., tcp://192.168.0.100:2375).
   * When set, all Docker commands for this agent will target the remote host.
   * 
   * IMPORTANT: The workspace directory path must exist on the REMOTE Docker host
   * for bind-mounts to work. Use NFS/sshfs or equivalent to sync workspace paths.
   * 
   * Supported formats:
   * - tcp://host:port (insecure; use on trusted LANs only)
   * - tcp://host:port (with DOCKER_TLS_VERIFY env set separately)
   * - unix:///path/to/docker.sock (local socket, non-default path)
   * - ssh://user@host (requires SSH key auth)
   */
  dockerHost?: string;
};
```

---

### 4. **Update Config Resolution Logic**

**File:** `/opt/openclaw/src/agents/sandbox/config.ts`

```typescript
export function resolveSandboxDockerConfig(params: {
  scope: SandboxScope;
  globalDocker?: Partial<SandboxDockerConfig>;
  agentDocker?: Partial<SandboxDockerConfig>;
}): SandboxDockerConfig {
  const agentDocker = params.scope === "shared" ? undefined : params.agentDocker;
  const globalDocker = params.globalDocker;

  const env = agentDocker?.env
    ? { ...(globalDocker?.env ?? { LANG: "C.UTF-8" }), ...agentDocker.env }
    : (globalDocker?.env ?? { LANG: "C.UTF-8" });

  const ulimits = agentDocker?.ulimits
    ? { ...globalDocker?.ulimits, ...agentDocker.ulimits }
    : globalDocker?.ulimits;

  const binds = [...(globalDocker?.binds ?? []), ...(agentDocker?.binds ?? [])];

  return {
    image: agentDocker?.image ?? globalDocker?.image ?? DEFAULT_SANDBOX_IMAGE,
    containerPrefix:
      agentDocker?.containerPrefix ??
      globalDocker?.containerPrefix ??
      DEFAULT_SANDBOX_CONTAINER_PREFIX,
    workdir: agentDocker?.workdir ?? globalDocker?.workdir ?? DEFAULT_SANDBOX_WORKDIR,
    readOnlyRoot: agentDocker?.readOnlyRoot ?? globalDocker?.readOnlyRoot ?? true,
    tmpfs: agentDocker?.tmpfs ?? globalDocker?.tmpfs ?? ["/tmp", "/var/tmp", "/run"],
    network: agentDocker?.network ?? globalDocker?.network ?? "none",
    user: agentDocker?.user ?? globalDocker?.user,
    capDrop: agentDocker?.capDrop ?? globalDocker?.capDrop ?? ["ALL"],
    env,
    setupCommand: agentDocker?.setupCommand ?? globalDocker?.setupCommand,
    pidsLimit: agentDocker?.pidsLimit ?? globalDocker?.pidsLimit,
    memory: agentDocker?.memory ?? globalDocker?.memory,
    memorySwap: agentDocker?.memorySwap ?? globalDocker?.memorySwap,
    cpus: agentDocker?.cpus ?? globalDocker?.cpus,
    ulimits,
    seccompProfile: agentDocker?.seccompProfile ?? globalDocker?.seccompProfile,
    apparmorProfile: agentDocker?.apparmorProfile ?? globalDocker?.apparmorProfile,
    dns: agentDocker?.dns ?? globalDocker?.dns,
    extraHosts: agentDocker?.extraHosts ?? globalDocker?.extraHosts,
    binds: binds.length ? binds : undefined,
    
    // NEW: Docker host override
    dockerHost: agentDocker?.dockerHost ?? globalDocker?.dockerHost,
  };
}
```

**Notes:**
- Agent-specific `dockerHost` overrides global
- Shared sandbox scope ignores agent config (uses global only)
- No default value – when unset, Docker uses its default daemon

---

### 5. **Modify `execDocker` to Support Remote Hosts**

**File:** `/opt/openclaw/src/agents/sandbox/docker.ts`

#### **Current Implementation:**

```typescript
export function execDocker(args: string[], opts?: { allowFailure?: boolean }) {
  return new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
    const child = spawn("docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    // ... rest of implementation
  });
}
```

#### **New Implementation:**

```typescript
export function execDocker(
  args: string[],
  opts?: {
    allowFailure?: boolean;
    dockerHost?: string; // NEW: optional Docker host override
  }
) {
  return new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
    // Build environment with DOCKER_HOST if specified
    const env = opts?.dockerHost
      ? { ...process.env, DOCKER_HOST: opts.dockerHost }
      : process.env;

    const child = spawn("docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env, // NEW: pass custom environment
    });
    
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      const exitCode = code ?? 0;
      if (exitCode !== 0 && !opts?.allowFailure) {
        reject(new Error(stderr.trim() || `docker ${args.join(" ")} failed`));
        return;
      }
      resolve({ stdout, stderr, code: exitCode });
    });
  });
}
```

**Alternative Implementation (via `-H` flag):**

If you prefer passing `-H` explicitly instead of `DOCKER_HOST` env:

```typescript
export function execDocker(
  args: string[],
  opts?: {
    allowFailure?: boolean;
    dockerHost?: string;
  }
) {
  return new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
    // Prepend -H flag if dockerHost is specified
    const dockerArgs = opts?.dockerHost
      ? ["-H", opts.dockerHost, ...args]
      : args;

    const child = spawn("docker", dockerArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    
    // ... rest unchanged
  });
}
```

**Recommendation:** Use `DOCKER_HOST` environment variable (first approach):
- Cleaner – no need to modify arg arrays
- Standard Docker behavior
- Works with all Docker commands uniformly

---

### 6. **Update All Call Sites to Pass `dockerHost`**

All functions that call `execDocker()` need to accept and forward the `dockerHost` parameter from the config.

#### **6.1. Functions in `docker.ts`**

**Pattern:** Add `dockerHost?: string` param, pass to `execDocker`:

```typescript
// BEFORE:
export async function readDockerPort(containerName: string, port: number) {
  const result = await execDocker(["port", containerName, `${port}/tcp`], {
    allowFailure: true,
  });
  // ...
}

// AFTER:
export async function readDockerPort(
  containerName: string,
  port: number,
  dockerHost?: string
) {
  const result = await execDocker(
    ["port", containerName, `${port}/tcp`],
    {
      allowFailure: true,
      dockerHost,
    }
  );
  // ...
}
```

**Functions to update in `docker.ts`:**
1. `readDockerPort(containerName, port, dockerHost?)`
2. `dockerImageExists(image, dockerHost?)`
3. `ensureDockerImage(image, dockerHost?)`
4. `dockerContainerState(name, dockerHost?)`
5. `readContainerConfigHash(containerName, dockerHost?)`
6. `createSandboxContainer(params)` – extract `dockerHost` from `params.cfg.dockerHost`
7. `ensureSandboxContainer(params)` – extract from `params.cfg.docker.dockerHost`

**Example for `ensureSandboxContainer`:**

```typescript
export async function ensureSandboxContainer(params: {
  sessionKey: string;
  workspaceDir: string;
  agentWorkspaceDir: string;
  cfg: SandboxConfig;
}) {
  const dockerHost = params.cfg.docker.dockerHost;
  const scopeKey = resolveSandboxScopeKey(params.cfg.scope, params.sessionKey);
  // ...
  const state = await dockerContainerState(containerName, dockerHost);
  // ...
  if (!hasContainer) {
    await createSandboxContainer({
      // ... existing params
      dockerHost, // NEW
    });
  } else if (!running) {
    await execDocker(["start", containerName], { dockerHost });
  }
  // ...
}
```

**For `createSandboxContainer`:**

```typescript
async function createSandboxContainer(params: {
  name: string;
  cfg: SandboxDockerConfig;
  workspaceDir: string;
  workspaceAccess: SandboxWorkspaceAccess;
  agentWorkspaceDir: string;
  scopeKey: string;
  configHash?: string;
  dockerHost?: string; // NEW
}) {
  const { name, cfg, workspaceDir, scopeKey, dockerHost } = params;
  await ensureDockerImage(cfg.image, dockerHost);

  const args = buildSandboxCreateArgs({
    name,
    cfg,
    scopeKey,
    configHash: params.configHash,
  });
  // ... build args ...

  await execDocker(args, { dockerHost });
  await execDocker(["start", name], { dockerHost });

  if (cfg.setupCommand?.trim()) {
    await execDocker(["exec", "-i", name, "sh", "-lc", cfg.setupCommand], { dockerHost });
  }
}
```

---

#### **6.2. Functions in `browser.ts`**

**File:** `/opt/openclaw/src/agents/sandbox/browser.ts`

Add `dockerHost` param threading:

```typescript
async function ensureSandboxBrowserImage(image: string, dockerHost?: string) {
  const result = await execDocker(["image", "inspect", image], {
    allowFailure: true,
    dockerHost,
  });
  // ...
}

export async function ensureSandboxBrowser(params: {
  scopeKey: string;
  workspaceDir: string;
  agentWorkspaceDir: string;
  cfg: SandboxConfig;
  evaluateEnabled?: boolean;
}): Promise<SandboxBrowserContext | null> {
  const dockerHost = params.cfg.docker.dockerHost;
  // ...
  const state = await dockerContainerState(containerName, dockerHost);
  if (!state.exists) {
    await ensureSandboxBrowserImage(params.cfg.browser.image ?? DEFAULT_SANDBOX_BROWSER_IMAGE, dockerHost);
    // ...
    await execDocker(args, { dockerHost });
    await execDocker(["start", containerName], { dockerHost });
  } else if (!state.running) {
    await execDocker(["start", containerName], { dockerHost });
  }

  const mappedCdp = await readDockerPort(containerName, params.cfg.browser.cdpPort, dockerHost);
  // ...
  
  const onEnsureAttachTarget = params.cfg.browser.autoStart
    ? async () => {
        const state = await dockerContainerState(containerName, dockerHost);
        if (state.exists && !state.running) {
          await execDocker(["start", containerName], { dockerHost });
        }
        // ...
      }
    : undefined;
  // ...
}
```

---

#### **6.3. Functions in `manage.ts`**

**File:** `/opt/openclaw/src/agents/sandbox/manage.ts`

For `listSandboxContainers()` and `listSandboxBrowsers()`, need to resolve dockerHost per entry:

```typescript
export async function listSandboxContainers(): Promise<SandboxContainerInfo[]> {
  const config = loadConfig();
  const registry = await readRegistry();
  const results: SandboxContainerInfo[] = [];

  for (const entry of registry.entries) {
    const agentId = resolveSandboxAgentId(entry.sessionKey);
    const agentConfig = resolveSandboxConfigForAgent(config, agentId);
    const dockerHost = agentConfig.docker.dockerHost; // NEW
    
    const state = await dockerContainerState(entry.containerName, dockerHost);
    let actualImage = entry.image;
    if (state.exists) {
      try {
        const result = await execDocker(
          ["inspect", "-f", "{{.Config.Image}}", entry.containerName],
          { allowFailure: true, dockerHost }
        );
        if (result.code === 0) {
          actualImage = result.stdout.trim();
        }
      } catch {
        // ignore
      }
    }
    const configuredImage = agentConfig.docker.image;
    results.push({
      ...entry,
      image: actualImage,
      running: state.running,
      imageMatch: actualImage === configuredImage,
    });
  }

  return results;
}
```

**Similar changes for:**
- `listSandboxBrowsers()`
- `removeSandboxContainer(containerName)` – needs to resolve agent from registry to get dockerHost
- `removeSandboxBrowserContainer(containerName)` – same

**For removal functions:**

You need to look up the agent config from registry to get dockerHost:

```typescript
export async function removeSandboxContainer(containerName: string): Promise<void> {
  const config = loadConfig();
  const registry = await readRegistry();
  const entry = registry.entries.find((e) => e.containerName === containerName);
  
  let dockerHost: string | undefined;
  if (entry) {
    const agentId = resolveSandboxAgentId(entry.sessionKey);
    const agentConfig = resolveSandboxConfigForAgent(config, agentId);
    dockerHost = agentConfig.docker.dockerHost;
  }
  
  try {
    await execDocker(["rm", "-f", containerName], { allowFailure: true, dockerHost });
  } catch {
    // ignore removal failures
  }
  await removeRegistryEntry(containerName);
}
```

---

#### **6.4. Functions in `prune.ts`**

**File:** `/opt/openclaw/src/agents/sandbox/prune.ts`

Similar pattern – resolve dockerHost from registry:

```typescript
async function pruneSandboxContainers(cfg: SandboxConfig) {
  const config = loadConfig();
  const now = Date.now();
  const idleHours = cfg.prune.idleHours;
  const maxAgeDays = cfg.prune.maxAgeDays;
  if (idleHours === 0 && maxAgeDays === 0) {
    return;
  }
  const registry = await readRegistry();
  for (const entry of registry.entries) {
    const idleMs = now - entry.lastUsedAtMs;
    const ageMs = now - entry.createdAtMs;
    if (
      (idleHours > 0 && idleMs > idleHours * 60 * 60 * 1000) ||
      (maxAgeDays > 0 && ageMs > maxAgeDays * 24 * 60 * 60 * 1000)
    ) {
      const agentId = resolveSandboxAgentId(entry.sessionKey);
      const agentConfig = resolveSandboxConfigForAgent(config, agentId);
      const dockerHost = agentConfig.docker.dockerHost;
      
      try {
        await execDocker(["rm", "-f", entry.containerName], {
          allowFailure: true,
          dockerHost,
        });
      } catch {
        // ignore prune failures
      } finally {
        await removeRegistryEntry(entry.containerName);
      }
    }
  }
}

// Similar changes for pruneSandboxBrowsers()

export async function ensureDockerContainerIsRunning(containerName: string) {
  // Need to resolve dockerHost from registry lookup
  const config = loadConfig();
  const registry = await readRegistry();
  const entry = registry.entries.find((e) => e.containerName === containerName);
  
  let dockerHost: string | undefined;
  if (entry) {
    const agentId = resolveSandboxAgentId(entry.sessionKey);
    const agentConfig = resolveSandboxConfigForAgent(config, agentId);
    dockerHost = agentConfig.docker.dockerHost;
  }
  
  const state = await dockerContainerState(containerName, dockerHost);
  if (state.exists && !state.running) {
    await execDocker(["start", containerName], { dockerHost });
  }
}
```

---

## Complete File Change Summary

### Files to Modify

| File | Changes |
|------|---------|
| `/opt/openclaw/src/agents/sandbox/types.docker.ts` | Add `dockerHost?: string` field to `SandboxDockerConfig` |
| `/opt/openclaw/src/config/types.sandbox.ts` | Add `dockerHost?: string` with documentation to `SandboxDockerSettings` |
| `/opt/openclaw/src/config/zod-schema.agent-runtime.ts` | Add `dockerHost: z.string().optional()` to `SandboxDockerSchema` |
| `/opt/openclaw/src/agents/sandbox/config.ts` | Add `dockerHost` to config resolution logic in `resolveSandboxDockerConfig()` |
| `/opt/openclaw/src/agents/sandbox/docker.ts` | Modify `execDocker()` signature and all helper functions to thread `dockerHost` |
| `/opt/openclaw/src/agents/sandbox/browser.ts` | Thread `dockerHost` through all `execDocker()` calls |
| `/opt/openclaw/src/agents/sandbox/manage.ts` | Resolve `dockerHost` from registry/config for management operations |
| `/opt/openclaw/src/agents/sandbox/prune.ts` | Resolve `dockerHost` from registry/config for cleanup operations |

---

## Testing Plan

### 1. **Local Testing (No dockerHost Set)**
- Verify existing sandbox functionality unchanged
- Run `openclaw sandbox create` and exec commands
- Confirm containers run on local Docker

### 2. **Remote Docker Testing**
- Set up remote Docker daemon (e.g., CT337 @ `tcp://192.168.0.X:2375`)
- Configure agent with:
  ```yaml
  agents:
    list:
      - id: test-remote
        sandbox:
          mode: all
          docker:
            dockerHost: tcp://192.168.0.X:2375
  ```
- Verify container spawns on remote host:
  ```bash
  # On remote host:
  docker ps  # Should show openclaw-sandbox-* containers
  ```
- Test `exec`, `browser`, and cleanup operations

### 3. **Workspace Accessibility Test**
- Attempt to spawn sandbox WITHOUT shared workspace
- Expected: Container creation succeeds, but bind-mount fails
- Verify error message mentions workspace path
- Set up NFS/sshfs mount at same path on remote host
- Retry – should succeed

### 4. **Mixed Local/Remote Test**
- Configure one agent with remote Docker, another with local
- Verify containers spawn on correct hosts
- Confirm registry tracks them independently
- Test cleanup for both

### 5. **Container Lifecycle Test**
- Create sandbox on remote
- Stop container manually on remote host
- Trigger OpenClaw sandbox operation
- Verify auto-restart works via remote Docker

---

## Security Considerations

### 1. **Unencrypted TCP (Current Scope)**
- `tcp://host:port` sends all Docker API traffic unencrypted
- **Risk:** Command injection, container manipulation on untrusted networks
- **Mitigation (current):** Use only on trusted LAN (Proxmox internal network)
- **Not suitable for:** Public networks, multi-tenant environments

### 2. **TLS Support (Future Enhancement)**
Docker supports TLS via:
```bash
DOCKER_TLS_VERIFY=1
DOCKER_CERT_PATH=/path/to/certs
DOCKER_HOST=tcp://host:2376
```

To support this in the future:
- Add `dockerTlsVerify?: boolean` to config
- Add `dockerCertPath?: string` to config
- Update `execDocker()` to set these env vars when `dockerTlsVerify` is true

### 3. **Container Escape on Remote Host**
- Compromised container on remote host has same escape risk as local
- Ensure remote Docker host is hardened (AppArmor, Seccomp, user namespaces)
- Current sandbox config already includes:
  - Read-only root (`readOnlyRoot: true`)
  - Capabilities dropped (`capDrop: ["ALL"]`)
  - `no-new-privileges` security opt

---

## Config Hash Impact

The config hash (used to detect config changes) is computed in `config-hash.ts`:

```typescript
export function computeSandboxConfigHash(input: SandboxHashInput): string {
  const payload = normalizeForHash(input);
  const raw = JSON.stringify(payload);
  return crypto.createHash("sha1").update(raw).digest("hex");
}

type SandboxHashInput = {
  docker: SandboxDockerConfig;  // <-- includes dockerHost
  workspaceAccess: SandboxWorkspaceAccess;
  workspaceDir: string;
  agentWorkspaceDir: string;
};
```

**Impact:**
- Adding `dockerHost` to `SandboxDockerConfig` automatically includes it in hash
- Changing `dockerHost` will trigger container recreation (desired behavior)
- No changes needed to `config-hash.ts`

---

## Example Configuration

### Global Default (All Agents Use Remote Docker)

```yaml
agents:
  defaults:
    sandbox:
      mode: all
      docker:
        dockerHost: tcp://192.168.0.100:2375
        workspaceRoot: /var/lib/clawdbot/workspace  # Must exist on remote host
```

### Per-Agent Override

```yaml
agents:
  defaults:
    sandbox:
      mode: off

  list:
    - id: local-agent
      sandbox:
        mode: all
        # No dockerHost – uses local Docker

    - id: remote-agent
      sandbox:
        mode: all
        docker:
          dockerHost: tcp://192.168.0.100:2375
          # Workspace must be accessible on 192.168.0.100
```

---

## Implementation Checklist

- [ ] Add `dockerHost` to `SandboxDockerConfig` type (`types.docker.ts`)
- [ ] Add `dockerHost` to `SandboxDockerSettings` type (`types.sandbox.ts`)
- [ ] Add `dockerHost` to Zod schema (`zod-schema.agent-runtime.ts`)
- [ ] Add `dockerHost` to config resolution (`config.ts`)
- [ ] Modify `execDocker()` to accept and use `dockerHost` (`docker.ts`)
- [ ] Update all `docker.ts` helper functions to thread `dockerHost`
- [ ] Update `browser.ts` to pass `dockerHost`
- [ ] Update `manage.ts` to resolve and pass `dockerHost`
- [ ] Update `prune.ts` to resolve and pass `dockerHost`
- [ ] Test local Docker unchanged
- [ ] Test remote Docker functionality
- [ ] Test workspace bind-mount scenarios
- [ ] Test mixed local/remote agents
- [ ] Document workspace sharing requirement
- [ ] (Optional) Add validation warning if dockerHost set without workspace path discussion

---

## Future Enhancements

1. **TLS Support**
   - Add `dockerTlsVerify`, `dockerCertPath`, `dockerTlsCAPath` config fields
   - Set corresponding env vars in `execDocker()`

2. **SSH Support**
   - `dockerHost: ssh://user@host` works via Docker's built-in SSH support
   - Requires SSH keys configured for the OpenClaw process user
   - Test SSH transport separately

3. **Workspace Sync Automation**
   - Detect when `dockerHost` is remote
   - Auto-configure sshfs/NFS mount for workspace
   - OR: Fail early with helpful error message

4. **Docker Context Support**
   - Instead of `dockerHost`, use Docker contexts (`docker context use <name>`)
   - Requires pre-configured contexts on the host
   - Simpler for operators managing multiple Docker endpoints

5. **Container Health Monitoring**
   - Track remote container health separately
   - Alert if remote Docker daemon unreachable
   - Auto-fallback to local Docker if remote fails

---

## Appendix: Docker Host Formats

Docker CLI accepts these `DOCKER_HOST` formats:

| Format | Description | Example |
|--------|-------------|---------|
| `unix:///path` | Local Unix socket | `unix:///var/run/docker.sock` |
| `tcp://host:port` | TCP (insecure) | `tcp://192.168.0.100:2375` |
| `tcp://host:port` (TLS) | TCP with TLS | `tcp://192.168.0.100:2376` (requires `DOCKER_TLS_VERIFY=1`) |
| `ssh://user@host` | SSH tunnel | `ssh://root@192.168.0.100` |
| `fd://N` | File descriptor | `fd://3` (rare, used by systemd socket activation) |

**Recommendation for LAN:** Use `tcp://host:2375` (insecure) on trusted Proxmox internal network.

**Recommendation for production:** Use TLS (`tcp://host:2376` + certs) or SSH transport.

---

## Summary

This patch adds a single configuration field (`dockerHost`) that propagates through the entire Docker command invocation stack. The change is minimally invasive:

- **Config layer:** Add field to types and schema
- **Execution layer:** Thread `dockerHost` from config to `execDocker()`
- **All call sites:** Pass `dockerHost` through the chain

The main complexity is ensuring **workspace paths exist on the remote Docker host**, which is an operational concern, not a code issue.

**Estimated implementation time:** 2-3 hours (including testing).

**Risk level:** Low (env var change only, well-isolated).

**Deployment strategy:** Deploy to the admin LXC, test with one agent targeting remote Docker, monitor for errors, then expand.

---

**End of Specification**
