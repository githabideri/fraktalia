/**
 * Workspace Management
 * Creates and manages agent workspace directories
 */

const { mkdir, writeFile, rm, access, chown } = require('fs').promises;
const { exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const { logger } = require('./utils');

const execAsync = promisify(exec);

class WorkspaceManager {
  constructor(config) {
    this.baseDir = config.baseDir || '/var/lib/clawdbot/workspace/agents';
    this.owner = config.owner || 'clawdbot:clawdbot';
    this.permissions = config.permissions || '775';
  }

  /**
   * Create workspace directory and scaffold files
   */
  async createWorkspace(agentId, metadata) {
    const workspacePath = path.join(this.baseDir, agentId);
    
    logger.info(`Creating workspace: ${workspacePath}`);

    // Create directories
    await mkdir(workspacePath, { recursive: true });
    await mkdir(path.join(workspacePath, 'memory'), { recursive: true });

    // Create AGENTS.md
    const agentsMd = this.generateAgentsMd(metadata);
    await writeFile(path.join(workspacePath, 'AGENTS.md'), agentsMd);

    // Create SOUL.md
    const soulMd = this.generateSoulMd(metadata);
    await writeFile(path.join(workspacePath, 'SOUL.md'), soulMd);

    // Create IDENTITY.md
    const identityMd = this.generateIdentityMd(metadata);
    await writeFile(path.join(workspacePath, 'IDENTITY.md'), identityMd);

    // Create TOOLS.md
    const toolsMd = this.generateToolsMd();
    await writeFile(path.join(workspacePath, 'TOOLS.md'), toolsMd);

    // Set ownership and permissions
    await this.setOwnership(workspacePath);

    logger.info(`Workspace created: ${workspacePath}`);
    return workspacePath;
  }

  /**
   * Delete workspace directory
   */
  async deleteWorkspace(agentId) {
    const workspacePath = path.join(this.baseDir, agentId);
    
    logger.info(`Deleting workspace: ${workspacePath}`);

    try {
      await access(workspacePath);
      await rm(workspacePath, { recursive: true, force: true });
      logger.info(`Workspace deleted: ${workspacePath}`);
    } catch (err) {
      if (err.code === 'ENOENT') {
        logger.warn(`Workspace not found: ${workspacePath}`);
      } else {
        throw err;
      }
    }
  }

  /**
   * Set ownership and permissions
   */
  async setOwnership(workspacePath) {
    try {
      // Use chown command for reliability
      await execAsync(`chown -R ${this.owner} "${workspacePath}"`);
      await execAsync(`chmod -R ${this.permissions} "${workspacePath}"`);
      logger.info(`Set ownership: ${this.owner}, permissions: ${this.permissions}`);
    } catch (err) {
      logger.error(`Failed to set ownership: ${err.message}`);
      throw err;
    }
  }

  /**
   * Generate AGENTS.md content
   */
  generateAgentsMd(metadata) {
    return `# AGENTS.md - ${metadata.name}

This workspace belongs to a fractal agent created by the Fractal API.

## Identity
- **Name:** ${metadata.name}
- **Purpose:** ${metadata.purpose || 'General assistance'}

## Workspace
This folder is your working directory. Treat it as your personal space.

## Memory
Keep a daily log at \`memory/YYYY-MM-DD.md\` to maintain continuity across sessions.

## Tools
You have access to standard OpenClaw tools:
- File operations (read, write, edit)
- Shell commands (exec)
- Web search and fetch
- Browser automation
- Message sending

## Sandbox
You run in a sandboxed Docker environment with:
- Internet access (HTTP/HTTPS)
- Isolated from LAN and Tailscale networks
- Python, Node.js, and common tools pre-installed

## Safety
- Don't exfiltrate secrets or private data
- Be concise in chat; write longer output to files
- Ask before running destructive commands
`;
  }

  /**
   * Generate SOUL.md content
   */
  generateSoulMd(metadata) {
    return `# SOUL.md - ${metadata.name}

## Persona
${metadata.persona || 'You are a helpful, friendly assistant created to support specific tasks.'}

## Communication Style
- Be clear and concise
- Ask clarifying questions when needed
- Explain your reasoning when helpful
- Admit uncertainty rather than guess

## Values
- Accuracy over speed
- Collaboration over independence
- Learning from mistakes
- Respecting user preferences
`;
  }

  /**
   * Generate IDENTITY.md content
   */
  generateIdentityMd(metadata) {
    return `# I am ${metadata.name}

${metadata.purpose || 'I am a fractal agent — a dynamically created assistant designed to help with specific tasks.'}

I was created by the Fractal API and operate within the OpenClaw ecosystem.

My workspace is my personal space where I can:
- Maintain memory across sessions
- Store working files
- Keep notes and logs

I run in a sandboxed environment with internet access but isolated from internal networks.
`;
  }

  /**
   * Generate TOOLS.md content
   */
  generateToolsMd() {
    return `# TOOLS.md - User Tool Notes

This file is for notes about external tools and conventions.

## Available Tools
- **exec**: Run shell commands in the sandbox
- **read/write/edit**: File operations
- **web_search**: Search the web via Brave API
- **web_fetch**: Fetch and extract web content
- **browser**: Browser automation
- **message**: Send messages (Matrix, etc.)
- **image**: Analyze images
- **tts**: Text-to-speech

## Sandbox Environment
- Debian 12 base image
- Python 3.11 + uv
- Node.js 18 + npm
- Common tools: git, curl, jq, ffmpeg, imagemagick

## Network
- Internet access: ✅
- LAN access: ❌
- Tailscale access: ❌
`;
  }
}

module.exports = WorkspaceManager;
