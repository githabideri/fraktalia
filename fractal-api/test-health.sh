#!/bin/bash
# Quick health check for Fractal API

echo "=== Fractal API Health Check ==="
echo ""

# Check if service is running
echo "1. Service status:"
systemctl is-active fractal-api.service 2>/dev/null
if [ $? -eq 0 ]; then
  echo "   ✅ Service is running"
else
  echo "   ❌ Service is not running"
fi
echo ""

# Check if port is listening
echo "2. Port check:"
if ss -tlnp | grep -q ":18790"; then
  echo "   ✅ Port 18790 is listening"
else
  echo "   ❌ Port 18790 is not listening"
fi
echo ""

# Check health endpoint
echo "3. Health endpoint:"
RESPONSE=$(curl -s http://localhost:18790/health 2>&1)
if echo "$RESPONSE" | grep -q '"status":"ok"'; then
  echo "   ✅ Health check passed"
  echo "$RESPONSE" | jq . 2>/dev/null
else
  echo "   ❌ Health check failed"
  echo "   Response: $RESPONSE"
fi
echo ""

# Check config file
echo "4. Config file:"
if [ -f "config.json" ]; then
  echo "   ✅ config.json exists"
  if [ "$(stat -c %a config.json)" = "600" ]; then
    echo "   ✅ Permissions are 600"
  else
    echo "   ⚠️  Permissions are $(stat -c %a config.json) (should be 600)"
  fi
else
  echo "   ❌ config.json not found"
fi
echo ""

# Check registry file
echo "5. Registry file:"
REGISTRY_FILE="/var/lib/clawdbot/.openclaw/fractal-registry.json"
if [ -f "$REGISTRY_FILE" ]; then
  echo "   ✅ Registry exists"
  COUNT=$(jq 'length' "$REGISTRY_FILE" 2>/dev/null)
  echo "   Fractals: $COUNT"
else
  echo "   ℹ️  Registry will be created on first fractal"
fi
echo ""

# Check logs
echo "6. Recent logs (last 5 lines):"
if [ -f "fractal-api.log" ]; then
  tail -n 5 fractal-api.log
else
  echo "   (No log file yet)"
fi
echo ""

echo "=== End Health Check ==="
