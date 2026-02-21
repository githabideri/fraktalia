# Fractal Agent Creation Guide

## Lessons Learned from Vogelhauswart (VHW) — 2026-02-21

### Architecture Reality

```
CT336 (Admin LXC — Gateway runs here)
├─ OpenClaw Gateway
├─ Docker daemon (local)
├─ Agent workspaces at /var/lib/clawdbot/workspace/agents/<id>/
├─ sshfs mount of CT339 agents at /var/lib/clawdbot/workspace/agents-ct339/
└─ All config, bindings, session data

CT339 (Mox LXC)
├─ Docker daemon (tcp://192.168.0.39:2375)
├─ Mox workspace + container
└─ sshfs source for agents-ct339/
```

### Key Discovery: Containers Run Locally

Despite `dockerHost: tcp://192.168.0.39:2375` in the agent config, OpenClaw creates containers on the **local** Docker daemon (CT336) if the image exists locally. This means:

- Workspace bind mounts use **CT336's filesystem**
- sshfs paths mounted into containers cause FUSE permission issues
- The `dockerHost` setting may be ignored for sandbox containers

### Workspace Rules

1. **Config workspace path = LOCAL** on CT336: `/var/lib/clawdbot/workspace/agents/<id>/`
2. **Persona files** (AGENTS.md, SOUL.md, IDENTITY.md, TOOLS.md, USER.md, HEARTBEAT.md) must exist at this path
3. **Docker bind mount** maps this local path to `/workspace` inside the container
4. Agent **can self-modify** persona files (changes picked up on next session reset)

### Do NOT use sshfs paths for workspaces

Using `/var/lib/clawdbot/workspace/agents-ct339/<id>/` as workspace causes:
- `EACCES` errors when Gateway tries to read persona files
- Permission denied when container tries to write (FUSE → bind mount → container = broken)
- GID remapping issues (CT339 GID 1100 ↔ CT336 GID 989)

### File Permissions

Files in the workspace must be writable by the container user (UID 996, GID 1100):
- Directories: `775`, owned by `996:1100`
- Files: `664`, owned by `996:1100`
- `.ssh/`: `700`, keys `600`

### Creation Checklist

1. ☐ Create Matrix room (`POST /_matrix/client/v3/createRoom`)
2. ☐ Invite members + @synadmin (need 3+ for channel binding)
3. ☐ Set bot display name in room
4. ☐ Create LOCAL workspace: `/var/lib/clawdbot/workspace/agents/<id>/`
5. ☐ Write persona files (AGENTS.md, SOUL.md, IDENTITY.md, TOOLS.md, USER.md, HEARTBEAT.md)
6. ☐ Set permissions: `chown -R 996:1100`, `chmod -R g+w`
7. ☐ Add agent to config (READ-MODIFY-WRITE, validate count!)
8. ☐ Add binding BEFORE felix catch-all
9. ☐ Add group config with `autoReply: true`
10. ☐ Restart gateway
11. ☐ **VERIFY**: `sessions_send` to agent, confirm response
12. ☐ **VERIFY**: Agent can write to workspace (`touch /workspace/test`)
13. ☐ If SSH needed: copy keys to `<workspace>/.ssh/` (chmod 700/600)

### CT339 Status

CT339 is still used by Mox (whose container runs there via remote Docker). For new fractal agents, use CT336 local Docker unless there's a specific reason for CT339 isolation.
