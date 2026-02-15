#!/bin/bash
# Mox Network Firewall Setup
# Run as root to block LAN access from mox-internet Docker network
#
# This allows Mox to access the internet but blocks:
# - LAN (192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12)
# - Localhost (127.0.0.0/8)
# - Tailscale (100.64.0.0/10)

set -e

NETWORK_NAME="mox-internet"

# Get bridge interface ID
BRIDGE_ID=$(docker network inspect "$NETWORK_NAME" -f '{{.Id}}' | cut -c1-12)
BRIDGE_IF="br-${BRIDGE_ID}"

echo "Setting up firewall for network: $NETWORK_NAME"
echo "Bridge interface: $BRIDGE_IF"

# Add rules to DOCKER-USER chain (processed before Docker's rules)
iptables -I DOCKER-USER -i "$BRIDGE_IF" -d 192.168.0.0/16 -j DROP
iptables -I DOCKER-USER -i "$BRIDGE_IF" -d 10.0.0.0/8 -j DROP
iptables -I DOCKER-USER -i "$BRIDGE_IF" -d 172.16.0.0/12 -j DROP
iptables -I DOCKER-USER -i "$BRIDGE_IF" -d 127.0.0.0/8 -j DROP
iptables -I DOCKER-USER -i "$BRIDGE_IF" -d 100.64.0.0/10 -j DROP

echo "Firewall rules added:"
iptables -L DOCKER-USER -n -v | grep "$BRIDGE_IF"

echo ""
echo "Mox can now:"
echo "  ✅ Access internet (curl google.com)"
echo "  ❌ Access LAN (192.168.x.x)"
echo "  ❌ Access localhost"
echo "  ❌ Access Tailscale (100.x.x.x)"
