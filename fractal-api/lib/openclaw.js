/**
 * OpenClaw Gateway Config Management
 * CRITICAL: Uses read-modify-write pattern to avoid config corruption
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const { logger } = require('./utils');

const execAsync = promisify(exec);

class OpenClawClient {
  constructor(config) {
    this.gatewayCommand = config.gatewayCommand || 'openclaw gateway';
    this.catchAllAgentId = config.catchAllAgentId || 'felix';
  }

  /**
   * Get full gateway config
   */
  async getConfig() {
    logger.info('Reading OpenClaw config');
    
    const { stdout } = await execAsync(`${this.gatewayCommand} config.get`);
    return JSON.parse(stdout);
  }

  /**
   * Patch gateway config
   */
  async patchConfig(patch) {
    logger.info('Patching OpenClaw config');
    
    const patchJson = JSON.stringify(patch);
    const escapedPatch = patchJson.replace(/'/g, "'\\''");
    
    await execAsync(`${this.gatewayCommand} config.patch '${escapedPatch}'`);
  }

  /**
   * Add agent to config (read-modify-write)
   */
  async addAgent(agentConfig) {
    logger.info(`Adding agent: ${agentConfig.id}`);

    // Read full config
    const config = await this.getConfig();
    const initialCount = config.agents.list.length;

    // Check if agent already exists
    if (config.agents.list.find(a => a.id === agentConfig.id)) {
      throw new Error(`Agent '${agentConfig.id}' already exists in config`);
    }

    // Add new agent
    config.agents.list.push(agentConfig);

    // Validate count
    if (config.agents.list.length !== initialCount + 1) {
      throw new Error(
        `Agent list length mismatch! Expected ${initialCount + 1}, got ${config.agents.list.length}`
      );
    }

    // Write back FULL list
    await this.patchConfig({
      agents: {
        list: config.agents.list
      }
    });

    // Verify after write
    const verify = await this.getConfig();
    if (verify.agents.list.length !== initialCount + 1) {
      throw new Error(
        `POST-WRITE VALIDATION FAILED! Config has ${verify.agents.list.length} agents, expected ${initialCount + 1}. CHECK .bak FILES IMMEDIATELY!`
      );
    }

    logger.info(`Agent added successfully. Config now has ${verify.agents.list.length} agents.`);
  }

  /**
   * Remove agent from config (read-modify-write)
   */
  async removeAgent(agentId) {
    logger.info(`Removing agent: ${agentId}`);

    // Read full config
    const config = await this.getConfig();
    const initialCount = config.agents.list.length;

    // Find and remove agent
    const index = config.agents.list.findIndex(a => a.id === agentId);
    if (index === -1) {
      throw new Error(`Agent '${agentId}' not found in config`);
    }

    config.agents.list.splice(index, 1);

    // Validate count
    if (config.agents.list.length !== initialCount - 1) {
      throw new Error(
        `Agent list length mismatch! Expected ${initialCount - 1}, got ${config.agents.list.length}`
      );
    }

    // Write back FULL list
    await this.patchConfig({
      agents: {
        list: config.agents.list
      }
    });

    // Verify after write
    const verify = await this.getConfig();
    if (verify.agents.list.length !== initialCount - 1) {
      throw new Error(
        `POST-WRITE VALIDATION FAILED! Config has ${verify.agents.list.length} agents, expected ${initialCount - 1}. CHECK .bak FILES IMMEDIATELY!`
      );
    }

    logger.info(`Agent removed successfully. Config now has ${verify.agents.list.length} agents.`);
  }

  /**
   * Add binding (read-modify-write, insert before catch-all)
   */
  async addBinding(binding) {
    logger.info(`Adding binding for agent: ${binding.agentId}`);

    // Read full config
    const config = await this.getConfig();

    // Find catch-all binding (should be last)
    const catchAllIndex = config.bindings.findIndex(
      b => b.agentId === this.catchAllAgentId && b.match.channel === 'matrix' && !b.match.peer
    );

    if (catchAllIndex === -1) {
      logger.warn(`Catch-all binding for ${this.catchAllAgentId} not found, appending to end`);
      config.bindings.push(binding);
    } else {
      // Insert before catch-all
      config.bindings.splice(catchAllIndex, 0, binding);
      logger.info(`Binding inserted at position ${catchAllIndex} (before catch-all)`);
    }

    // Write back FULL list
    await this.patchConfig({
      bindings: config.bindings
    });

    logger.info('Binding added successfully');
  }

  /**
   * Remove binding (read-modify-write)
   */
  async removeBinding(agentId) {
    logger.info(`Removing binding for agent: ${agentId}`);

    // Read full config
    const config = await this.getConfig();

    // Find and remove binding
    const index = config.bindings.findIndex(b => b.agentId === agentId);
    if (index === -1) {
      logger.warn(`Binding for agent '${agentId}' not found`);
      return;
    }

    config.bindings.splice(index, 1);

    // Write back FULL list
    await this.patchConfig({
      bindings: config.bindings
    });

    logger.info('Binding removed successfully');
  }

  /**
   * Set group config (auto-reply, etc.)
   */
  async setGroupConfig(roomId, groupConfig) {
    logger.info(`Setting group config for room: ${roomId}`);

    // Read full config
    const config = await this.getConfig();

    // Set group config
    if (!config.channels) config.channels = {};
    if (!config.channels.matrix) config.channels.matrix = {};
    if (!config.channels.matrix.groups) config.channels.matrix.groups = {};

    config.channels.matrix.groups[roomId] = groupConfig;

    // Write back
    await this.patchConfig({
      channels: {
        matrix: {
          groups: config.channels.matrix.groups
        }
      }
    });

    logger.info('Group config set successfully');
  }

  /**
   * Remove group config
   */
  async removeGroupConfig(roomId) {
    logger.info(`Removing group config for room: ${roomId}`);

    // Read full config
    const config = await this.getConfig();

    if (config.channels?.matrix?.groups?.[roomId]) {
      delete config.channels.matrix.groups[roomId];

      // Write back
      await this.patchConfig({
        channels: {
          matrix: {
            groups: config.channels.matrix.groups
          }
        }
      });

      logger.info('Group config removed successfully');
    } else {
      logger.warn(`Group config for room '${roomId}' not found`);
    }
  }

  /**
   * Restart gateway
   */
  async restart() {
    logger.info('Restarting OpenClaw gateway');
    
    try {
      await execAsync('systemctl restart openclaw-gateway.service');
      logger.info('Gateway restart initiated');
      
      // Wait a bit for service to come up
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (err) {
      // Try alternative restart method
      logger.warn('systemctl restart failed, trying openclaw gateway restart');
      await execAsync(`${this.gatewayCommand} restart`);
    }
  }
}

module.exports = OpenClawClient;
