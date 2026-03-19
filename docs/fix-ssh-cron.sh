#!/bin/bash
# Script to fix SSH key permissions and update the 5-minute cron
# 
# Execute this script on the host that manages the workspace (e.g., via SSH or locally)
# OR copy the commands directly and run them there

set -euo pipefail

echo "=== SSH Key + Cron Fix ==="
echo ""

echo "Step 1: Restore SSH key permissions to 0600"
echo "------------------------------------------"
echo "Fixing SSH private key permissions..."
find /var/lib/clawdbot/workspace -path '*/.ssh/*' -type f -name 'id_*' ! -name '*.pub' -exec chmod 600 {} \;
echo "Done. Verifying:"
find /var/lib/clawdbot/workspace -path '*/.ssh/*' -type f -name 'id_*' ! -name '*.pub' -exec ls -l {} \; | grep -v -E '0600|rw-------' || echo "All SSH keys are 0600 ✅"

echo ""
echo "Step 2: Update the 5-minute chmod cron"
echo "--------------------------------------"
# Remove old broken cron entries
sudo crontab -l | grep -v "chmod.*664" | sudo crontab - 2>/dev/null || true
sudo rm -f /etc/cron.d/sandbox-permission-fix 2>/dev/null || true

# Create fixed cron that excludes sensitive paths
sudo tee /etc/cron.d/sandbox-permission-fix > /dev/null << 'CRON_EOF'
*/5 * * * * find /var/lib/clawdbot/workspace/agents/ -type f \( -perm 0600 -not -path '*/.ssh/*' -not -path '*/.git/*' -not -path '*/*.key' -not -path '*/*.pem' \) -exec chmod 664 {} \; 2>/dev/null
CRON_EOF
sudo chmod 644 /etc/cron.d/sandbox-permission-fix

echo "New cron installed. Verifying:"
sudo cat /etc/cron.d/sandbox-permission-fix

echo ""
echo "Step 3: Verify fix"
echo "------------------"
echo "Checking remaining 0600 files (excluding .ssh/.git):"
find /var/lib/clawdbot/workspace/agents/ -type f -perm 0600 -not -path "*/.ssh/*" -not -path "*/.git/*" | wc -l

echo ""
echo "Checking SSH keys are still 0600:"
find /var/lib/clawdbot/workspace -path "*/.ssh/*" -type f -name 'id_*' ! -name '*.pub' -exec stat -c '%a %n' {} \; | grep -v "600" || echo "All SSH keys are 0600 ✅"

echo ""
echo "✅ Fix complete!"
echo ""
echo "The 5-minute cron now:"
echo "  - Converts 0600 → 0664 for regular workspace files"
echo "  - EXCLUDES .ssh/ .git/ *.key *.pem files"
echo ""
echo "SSH private keys are protected from permission changes."
