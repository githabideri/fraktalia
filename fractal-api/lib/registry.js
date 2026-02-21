/**
 * Fractal Registry
 * Tracks active fractals in a JSON file
 */

const { readFileSync, writeFileSync, existsSync } = require('fs');
const { logger } = require('./utils');

class FractalRegistry {
  constructor(dataFile) {
    this.dataFile = dataFile;
    this.fractals = this.load();
  }

  /**
   * Load registry from disk
   */
  load() {
    if (!existsSync(this.dataFile)) {
      logger.info(`Registry file not found, creating: ${this.dataFile}`);
      return [];
    }

    try {
      const data = readFileSync(this.dataFile, 'utf8');
      const fractals = JSON.parse(data);
      logger.info(`Loaded ${fractals.length} fractals from registry`);
      return fractals;
    } catch (err) {
      logger.error(`Failed to load registry: ${err.message}`);
      return [];
    }
  }

  /**
   * Save registry to disk
   */
  save() {
    try {
      const data = JSON.stringify(this.fractals, null, 2);
      writeFileSync(this.dataFile, data, 'utf8');
      logger.info(`Saved ${this.fractals.length} fractals to registry`);
    } catch (err) {
      logger.error(`Failed to save registry: ${err.message}`);
      throw err;
    }
  }

  /**
   * Add a fractal to the registry
   */
  add(fractal) {
    const entry = {
      ...fractal,
      status: 'active',
      createdAt: fractal.createdAt || new Date().toISOString()
    };

    this.fractals.push(entry);
    this.save();

    return entry;
  }

  /**
   * Get a fractal by agent ID
   */
  get(agentId) {
    return this.fractals.find(f => f.agentId === agentId);
  }

  /**
   * List all fractals
   */
  list() {
    return [...this.fractals];
  }

  /**
   * Update fractal status
   */
  updateStatus(agentId, status) {
    const fractal = this.get(agentId);
    
    if (!fractal) {
      throw new Error(`Fractal not found: ${agentId}`);
    }

    fractal.status = status;
    fractal.updatedAt = new Date().toISOString();
    this.save();

    return fractal;
  }

  /**
   * Remove a fractal from the registry
   */
  remove(agentId) {
    const index = this.fractals.findIndex(f => f.agentId === agentId);
    
    if (index === -1) {
      throw new Error(`Fractal not found: ${agentId}`);
    }

    this.fractals.splice(index, 1);
    this.save();
  }

  /**
   * Count active fractals
   */
  countActive() {
    return this.fractals.filter(f => f.status === 'active').length;
  }
}

module.exports = FractalRegistry;
