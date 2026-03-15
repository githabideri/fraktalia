# Sandbox Permission Drift — Analysis & Fix

## Problem
OpenClaw's sandbox `write`/`edit` tool creates all files with `0600` permissions, making them unreadable in subsequent sessions when accessed via sshfs.

## Root Cause
The write pipeline in `src/agents/sandbox/fs-bridge-shell-command-plans.ts`:

1. `mktemp` creates a temp file → **always `0600`** (POSIX standard, ignores umask)
2. `cat >$tmp` writes content → permissions unchanged
3. `mv $tmp $target` → target inherits `0600` from temp file

```typescript
// buildWriteCommitPlan() — current implementation
script: 'set -eu; mv -f -- "$1" "$2"'
// No chmod after mv → file stays 0600
```

**Neither `.bashrc` umask nor Docker image umask fixes this** — `mktemp` explicitly sets `0600` regardless of process umask.

## Impact
- Affects all sandbox agents with workspaces on CT339 (mox, vogelhauswart, ht)
- MEMORY.md becomes unreadable → session startup shows `[MISSING]`
- memory/*.md files accumulate 0600 permissions over time
- Gateway reads workspace files from HOST side via sshfs → permission check applies

## Fix: Cron on CT339
Root cron job (installed 2026-03-15):
```cron
*/5 * * * * find /var/lib/clawdbot/workspace/agents/ -type f -perm 0600 -exec chmod 664 {} \; 2>/dev/null
```

Converts `0600` → `0664` every 5 minutes. 177 files were fixed on first run.

## Why not upstream?
This is specific to our sshfs multi-host setup. Standard OpenClaw installs with local workspaces are unaffected (gateway UID matches file owner, so 0600 is fine).

A theoretical upstream fix would be:
```typescript
script: 'set -eu; mv -f -- "$1" "$2"; chmod 664 -- "$2"'
```

## Related Fixes (same session)
- VHW TOOLS.md: Removed broken `accountId="localbot"` references (account disabled)
- VHW TOOLS.md: Added sandbox container path documentation
- Created `.bashrc` with `umask 002` in VHW workspace (helps exec-based writes)
- Fixed all script permissions (`chmod 775`)

## Verification
```bash
# On CT339: Check for remaining 0600 files
ssh root@192.168.0.39 'find /var/lib/clawdbot/workspace/agents/ -type f -perm 0600 | wc -l'
# Should be 0 (or only files created in last 5 minutes)
```
