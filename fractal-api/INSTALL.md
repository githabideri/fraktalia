# Fractal API - Installation Guide

Quick setup guide for deploying the Fractal API on your admin LXC.

## Prerequisites

- OpenClaw Gateway running
- Matrix Synapse running
- Node.js installed (v18+)
- systemd available
- OpenClaw service user with appropriate permissions

## Installation Steps

### 1. Navigate to the API directory

```bash
cd <fraktalia-repo>/fractal-api
```

### 2. Create configuration

```bash
cp config.example.json config.json
```

### 3. Edit config.json

**Required values to update:**

```bash
# Generate a strong secret token
openssl rand -hex 32

# Get Matrix bot token
cat ~/.openclaw/openclaw.json | jq -r '.channels.matrix.accounts.<your-bot>.token'

# Get Matrix admin token
cat <openclaw-data>/.openclaw/matrix-admin-token
```

Edit `config.json`:
- Set `auth.secret` to the generated token
- Set `matrix.botToken` from openclaw.json
- Set `matrix.adminToken` from the admin token file
- Verify other paths match your setup

### 4. Secure the config

```bash
chmod 600 config.json
chown <openclaw-user>:<openclaw-group> config.json
```

### 5. Verify ownership

```bash
chown -R <openclaw-user>:<openclaw-group> <fraktalia-repo>/fractal-api
```

### 6. Install systemd service

```bash
sudo cp fractal-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable fractal-api.service
```

### 7. Start the service

```bash
sudo systemctl start fractal-api.service
```

### 8. Verify it's running

```bash
sudo systemctl status fractal-api.service
./test-health.sh
```

Expected output:
```
=== Fractal API Health Check ===

1. Service status:
   ✅ Service is running

2. Port check:
   ✅ Port 18790 is listening

3. Health endpoint:
   ✅ Health check passed
   {
     "status": "ok",
     "version": "1.0.0",
     ...
   }
```

### 9. Test the API

```bash
# Set your auth token
export FRACTAL_TOKEN="your-secret-token-here"

# Health check
curl http://localhost:18790/health

# List fractals (should be empty)
curl -H "Authorization: Bearer $FRACTAL_TOKEN" \
  http://localhost:18790/fractal
```

## Troubleshooting

### Service won't start

```bash
# Check logs
sudo journalctl -u fractal-api.service -n 50

# Common issues:
# - config.json not found or invalid JSON
# - Wrong file ownership
# - Port 18790 already in use
```

### Config file errors

```bash
# Validate JSON syntax
cat config.json | jq .

# Check ownership
ls -l config.json
# Should be: -rw------- 1 clawdbot clawdbot

# Fix ownership if needed
sudo chown clawdbot:clawdbot config.json
sudo chmod 600 config.json
```

### Port already in use

```bash
# Find what's using port 18790
sudo ss -tlnp | grep 18790

# Change port in config.json if needed
```

### Health check fails

```bash
# Check if server is listening
curl -v http://localhost:18790/health

# Check logs
tail -f fractal-api.log

# Restart service
sudo systemctl restart fractal-api.service
```

## Manual Testing

Create a test fractal:

```bash
export FRACTAL_TOKEN="your-token"

curl -X POST http://localhost:18790/fractal \
  -H "Authorization: Bearer $FRACTAL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "TestBot",
    "agentId": "test-bot",
    "purpose": "Testing the Fractal API",
    "persona": "Helpful test assistant",
    "inviteUsers": ["@m:your-homeserver.example.com"],
    "autoReply": true
  }'
```

Expected response (201):
```json
{
  "success": true,
  "fractal": {
    "agentId": "test-bot",
    "roomId": "!xyz...",
    "name": "TestBot",
    ...
  }
}
```

Verify the fractal:

```bash
# List all fractals
curl -H "Authorization: Bearer $FRACTAL_TOKEN" \
  http://localhost:18790/fractal

# Get specific fractal
curl -H "Authorization: Bearer $FRACTAL_TOKEN" \
  http://localhost:18790/fractal/test-bot

# Check OpenClaw config
openclaw gateway config.get | jq '.agents.list[] | select(.id == "test-bot")'

# Check if agent responds in Matrix room
# Send a message in the room created by the API
```

Clean up test fractal:

```bash
curl -X DELETE "http://localhost:18790/fractal/test-bot?deleteWorkspace=true" \
  -H "Authorization: Bearer $FRACTAL_TOKEN"
```

## Next Steps

1. **Set up monitoring:** Add Prometheus metrics or log alerts
2. **Document token:** Store API token in password manager
3. **Enable for Mox:** Give Mox the API endpoint and token
4. **Backup config:** Include config.json in backup routine

## Security Checklist

- [ ] config.json is mode 600
- [ ] API token is strong (32+ characters)
- [ ] Server binds to localhost only (not exposed to network)
- [ ] Logs are rotated (journald handles this)
- [ ] Matrix admin token is protected

## Support

- **Logs:** `journalctl -u fractal-api.service -f`
- **Health:** `./test-health.sh`
- **Documentation:** See README.md and fractal-api-draft.md
