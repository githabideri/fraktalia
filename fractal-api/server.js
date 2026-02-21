#!/usr/bin/env node
/**
 * Fractal API Server
 * Manages dynamic agent creation and lifecycle for OpenClaw
 * 
 * Safety-critical: Uses read-modify-write pattern for config updates
 */

const http = require('http');
const { readFileSync } = require('fs');
const path = require('path');

const MatrixClient = require('./lib/matrix');
const OpenClawClient = require('./lib/openclaw');
const WorkspaceManager = require('./lib/workspace');
const FractalRegistry = require('./lib/registry');
const { logger, respondJSON, respondError } = require('./lib/utils');

// Load configuration
let config;
try {
  config = JSON.parse(readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
} catch (err) {
  console.error('FATAL: Cannot load config.json:', err.message);
  process.exit(1);
}

// Initialize clients
const matrix = new MatrixClient(config.matrix);
const openclaw = new OpenClawClient(config.openclaw);
const workspace = new WorkspaceManager(config.workspace);
const registry = new FractalRegistry(config.registry.dataFile);

const MAX_FRACTALS = config.limits?.maxFractals || 5;
const MIN_AGENTS_COUNT = config.limits?.minAgentsCount || 12;

/**
 * POST /fractal - Create new fractal agent
 */
async function createFractal(req, res) {
  let body = '';
  
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const params = JSON.parse(body);
      
      // Validate request
      const errors = validateCreateRequest(params);
      if (errors.length > 0) {
        return respondError(res, 400, 'Validation failed', errors);
      }

      // Check fractal limit
      const activeFractals = registry.list().filter(f => f.status === 'active');
      if (activeFractals.length >= MAX_FRACTALS) {
        return respondError(res, 429, `Maximum fractals limit reached (${MAX_FRACTALS})`);
      }

      logger.info(`Creating fractal: ${params.agentId}`);

      // Pre-flight check: verify config health
      const currentConfig = await openclaw.getConfig();
      if (!currentConfig.agents?.list || currentConfig.agents.list.length < MIN_AGENTS_COUNT) {
        return respondError(res, 500, 
          `Config corruption detected! agents.list has ${currentConfig.agents?.list?.length || 0} entries, expected ${MIN_AGENTS_COUNT}+. Refusing to modify.`
        );
      }

      const initialAgentCount = currentConfig.agents.list.length;
      logger.info(`Pre-flight check passed: ${initialAgentCount} agents in config`);

      // Step 1: Create Matrix room
      logger.info('Step 1/7: Creating Matrix room');
      const roomId = await matrix.createRoom(params.name, params.inviteUsers || []);
      logger.info(`Room created: ${roomId}`);

      // Step 2: Ensure 3+ members (add padding member)
      logger.info('Step 2/7: Ensuring 3+ members');
      await matrix.ensureMinimumMembers(roomId, config.matrix.paddingUser);
      
      const memberCount = await matrix.getRoomMemberCount(roomId);
      if (memberCount < 3) {
        throw new Error(`Room has ${memberCount} members, need 3+`);
      }
      logger.info(`Room has ${memberCount} members`);

      // Step 3: Create workspace
      logger.info('Step 3/7: Creating workspace');
      const workspacePath = await workspace.createWorkspace(params.agentId, {
        name: params.name,
        purpose: params.purpose,
        persona: params.persona
      });
      logger.info(`Workspace created: ${workspacePath}`);

      // Step 4: Add agent to config (CRITICAL: read-modify-write)
      logger.info('Step 4/7: Adding agent to config');
      try {
        await openclaw.addAgent({
          id: params.agentId,
          workspace: workspacePath,
          model: {
            primary: params.model || 'anthropic/claude-sonnet-4-5',
            fallbacks: ['anthropic/claude-haiku-4-5']
          },
          identity: {
            name: params.name,
            theme: params.purpose || 'Fractal agent'
          },
          sandbox: config.agentDefaults?.sandbox || {
            mode: 'all',
            workspaceAccess: 'rw',
            docker: {
              image: 'mox-sandbox:latest',
              network: 'mox-internet',
              user: '996:1100',
              readOnlyRoot: false
            }
          }
        });

        // Verify agent was added
        const verifyConfig = await openclaw.getConfig();
        if (verifyConfig.agents.list.length !== initialAgentCount + 1) {
          throw new Error(
            `Agent count validation failed! Expected ${initialAgentCount + 1}, got ${verifyConfig.agents.list.length}`
          );
        }
        logger.info(`Agent added, config now has ${verifyConfig.agents.list.length} agents`);
      } catch (err) {
        // Rollback: delete workspace
        logger.error('Agent creation failed, rolling back workspace');
        await workspace.deleteWorkspace(params.agentId);
        throw err;
      }

      // Step 5: Add binding (before felix catch-all)
      logger.info('Step 5/7: Adding binding');
      try {
        await openclaw.addBinding({
          agentId: params.agentId,
          match: {
            channel: 'matrix',
            peer: {
              kind: 'channel',
              id: roomId
            }
          }
        });
        logger.info('Binding added');
      } catch (err) {
        // Rollback: remove agent, delete workspace
        logger.error('Binding creation failed, rolling back agent and workspace');
        await openclaw.removeAgent(params.agentId);
        await workspace.deleteWorkspace(params.agentId);
        throw err;
      }

      // Step 6: Enable auto-reply
      logger.info('Step 6/7: Configuring group settings');
      try {
        await openclaw.setGroupConfig(roomId, {
          autoReply: params.autoReply !== undefined ? params.autoReply : true
        });
        logger.info('Group config set');
      } catch (err) {
        // Rollback: remove binding, agent, workspace
        logger.error('Group config failed, rolling back binding, agent, and workspace');
        await openclaw.removeBinding(params.agentId);
        await openclaw.removeAgent(params.agentId);
        await workspace.deleteWorkspace(params.agentId);
        throw err;
      }

      // Step 7: Restart gateway
      logger.info('Step 7/7: Restarting gateway');
      await openclaw.restart();
      logger.info('Gateway restarted');

      // Register fractal
      const fractal = registry.add({
        agentId: params.agentId,
        roomId,
        name: params.name,
        purpose: params.purpose,
        model: params.model || 'anthropic/claude-sonnet-4-5',
        workspace: workspacePath,
        createdAt: new Date().toISOString()
      });

      logger.info(`✅ Fractal created successfully: ${params.agentId}`);

      respondJSON(res, 201, {
        success: true,
        fractal
      });

    } catch (err) {
      logger.error('Fractal creation failed:', err);
      respondError(res, 500, 'Fractal creation failed', err.message);
    }
  });
}

/**
 * GET /fractal - List all fractals
 */
function listFractals(req, res) {
  const fractals = registry.list();
  respondJSON(res, 200, {
    success: true,
    count: fractals.length,
    fractals
  });
}

/**
 * GET /fractal/:id - Get fractal details
 */
function getFractal(req, res, agentId) {
  const fractal = registry.get(agentId);
  
  if (!fractal) {
    return respondError(res, 404, 'Fractal not found');
  }

  respondJSON(res, 200, {
    success: true,
    fractal
  });
}

/**
 * DELETE /fractal/:id - Delete fractal
 */
async function deleteFractal(req, res, agentId) {
  try {
    const fractal = registry.get(agentId);
    
    if (!fractal) {
      return respondError(res, 404, 'Fractal not found');
    }

    logger.info(`Deleting fractal: ${agentId}`);

    // Parse query params for optional cleanup
    const url = new URL(req.url, `http://${req.headers.host}`);
    const deleteRoom = url.searchParams.get('deleteRoom') === 'true';
    const deleteWorkspace = url.searchParams.get('deleteWorkspace') === 'true';

    // Step 1: Remove group config
    logger.info('Step 1/5: Removing group config');
    await openclaw.removeGroupConfig(fractal.roomId);

    // Step 2: Remove binding
    logger.info('Step 2/5: Removing binding');
    await openclaw.removeBinding(agentId);

    // Step 3: Remove agent
    logger.info('Step 3/5: Removing agent');
    await openclaw.removeAgent(agentId);

    // Step 4: Delete workspace (optional)
    if (deleteWorkspace) {
      logger.info('Step 4/5: Deleting workspace');
      await workspace.deleteWorkspace(agentId);
    } else {
      logger.info('Step 4/5: Preserving workspace');
    }

    // Step 5: Delete room (optional)
    if (deleteRoom) {
      logger.info('Step 5/5: Deleting Matrix room');
      // Note: Synapse doesn't have a simple room delete API
      // This would require kicking all users and purging history
      logger.warn('Room deletion not implemented, room will remain');
    }

    // Restart gateway
    logger.info('Restarting gateway');
    await openclaw.restart();

    // Update registry
    registry.remove(agentId);

    logger.info(`✅ Fractal deleted: ${agentId}`);

    respondJSON(res, 200, {
      success: true,
      message: 'Fractal deleted',
      agentId
    });

  } catch (err) {
    logger.error('Fractal deletion failed:', err);
    respondError(res, 500, 'Fractal deletion failed', err.message);
  }
}

/**
 * GET /health - Health check
 */
function healthCheck(req, res) {
  respondJSON(res, 200, {
    status: 'ok',
    version: '1.0.0',
    fractals: {
      active: registry.list().filter(f => f.status === 'active').length,
      total: registry.list().length,
      max: MAX_FRACTALS
    }
  });
}

/**
 * Validate create request parameters
 */
function validateCreateRequest(params) {
  const errors = [];

  if (!params.name || typeof params.name !== 'string') {
    errors.push('name is required (string)');
  }

  if (!params.agentId || typeof params.agentId !== 'string') {
    errors.push('agentId is required (string)');
  } else if (!/^[a-z0-9-]+$/.test(params.agentId)) {
    errors.push('agentId must be kebab-case (lowercase, numbers, hyphens only)');
  }

  if (registry.get(params.agentId)) {
    errors.push(`agentId '${params.agentId}' already exists`);
  }

  if (params.model && typeof params.model !== 'string') {
    errors.push('model must be a string');
  }

  if (params.inviteUsers && !Array.isArray(params.inviteUsers)) {
    errors.push('inviteUsers must be an array');
  }

  return errors;
}

/**
 * Authentication middleware
 */
function authenticate(req, res) {
  const authHeader = req.headers['authorization'];
  
  if (!authHeader) {
    respondError(res, 401, 'Missing Authorization header');
    return false;
  }

  const [type, token] = authHeader.split(' ');
  
  if (type !== 'Bearer' || token !== config.auth.secret) {
    respondError(res, 403, 'Invalid credentials');
    return false;
  }

  return true;
}

/**
 * Request router
 */
function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method;

  // Health check (no auth required)
  if (path === '/health' && method === 'GET') {
    return healthCheck(req, res);
  }

  // All other endpoints require auth
  if (!authenticate(req, res)) {
    return;
  }

  // Route to handlers
  if (path === '/fractal' && method === 'POST') {
    return createFractal(req, res);
  }

  if (path === '/fractal' && method === 'GET') {
    return listFractals(req, res);
  }

  const fractalMatch = path.match(/^\/fractal\/([a-z0-9-]+)$/);
  if (fractalMatch) {
    const agentId = fractalMatch[1];
    
    if (method === 'GET') {
      return getFractal(req, res, agentId);
    }
    
    if (method === 'DELETE') {
      return deleteFractal(req, res, agentId);
    }
  }

  // 404
  respondError(res, 404, 'Not found');
}

// Create server
const server = http.createServer(handleRequest);

const PORT = config.server?.port || 18790;
const HOST = config.server?.host || '127.0.0.1';

server.listen(PORT, HOST, () => {
  logger.info(`🚀 Fractal API listening on ${HOST}:${PORT}`);
  logger.info(`   Max fractals: ${MAX_FRACTALS}`);
  logger.info(`   Registry: ${config.registry.dataFile}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});
