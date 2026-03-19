# SSH Key Permission Issue

## Problem
A system cron job that runs every 5 minutes was inadvertently changing SSH private key permissions from `0600` to `0664`, causing SSH to reject the keys.

## Root Cause
The cron job was designed to fix file permission issues with OpenClaw's sandbox write tool, which creates files with `0600` permissions via `mktemp`. When workspaces are accessed via sshfs mounts, this makes files unreadable in subsequent sessions.

The fix was to convert `0600` files to `0664`, but it didn't exclude sensitive files like SSH private keys.

## Solution

### 1. Update the Cron (exclude sensitive paths)

```bash
# Remove old cron
sudo crontab -l | grep -v "chmod.*664" | sudo crontab - 2>/dev/null || true
sudo rm -f /etc/cron.d/sandbox-permission-fix 2>/dev/null || true

# Add new cron (excludes .ssh, .git, *.key, *.pem)
cat > /etc/cron.d/sandbox-permission-fix << 'EOF'
*/5 * * * * find /var/lib/clawdbot/workspace/agents/ -type f \( -perm 0600 -not -path '*/.ssh/*' -not -path '*/.git/*' -not -path '*/*.key' -not -path '*/*.pem' \) -exec chmod 664 {} \; 2>/dev/null
EOF
sudo chmod 644 /etc/cron.d/sandbox-permission-fix
```

### 2. Restore SSH Key Permissions

```bash
# Fix all SSH private keys
sudo find /var/lib/clawdbot/workspace -path "*/.ssh/*" -type f -exec chmod 600 {} \;
```

## Verification

```bash
# Check remaining 0600 files (excluding .ssh/.git)
sudo find /var/lib/clawdbot/workspace/agents/ -type f -perm 0600 -not -path "*/.ssh/*" -not -path "*/.git/*" | wc -l
# Should be 0 or only recently created files

# Verify .ssh files are 0600
sudo find /var/lib/clawdbot/workspace -path "*/.ssh/*" -type f -perm 0600 | wc -l
# Should be all SSH keys
```

## Automated Fix Script

Use `fix-ssh-cron.sh` to apply the fix automatically.

## Related Issues

This is a known issue with OpenClaw sandbox agents when using sshfs mounts between hosts. The standard OpenClaw setup with local workspaces is unaffected.

**See also:**
- [Sandbox Permission Drift — Full Analysis](sandbox-permission-drift-fix.md)
