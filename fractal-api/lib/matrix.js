/**
 * Matrix/Synapse API Client
 * Handles room creation and management
 */

const https = require('https');
const http = require('http');
const { logger } = require('./utils');

class MatrixClient {
  constructor(config) {
    this.baseUrl = config.baseUrl || 'http://localhost:8008';
    this.botToken = config.botToken;
    this.adminToken = config.adminToken;
    this.homeserver = config.homeserver || 'your-homeserver.example.com';
    this.botUserId = config.botUserId || `@yourbot:${this.homeserver}`;
  }

  /**
   * Make HTTP request to Matrix API
   */
  async request(method, path, body, token) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.baseUrl);
      const isHttps = url.protocol === 'https:';
      const client = isHttps ? https : http;

      const options = {
        method,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      };

      const req = client.request(url, options, (res) => {
        let data = '';

        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsed);
            } else {
              reject(new Error(`Matrix API error: ${res.statusCode} ${parsed.error || data}`));
            }
          } catch (err) {
            reject(new Error(`Failed to parse Matrix response: ${data}`));
          }
        });
      });

      req.on('error', reject);

      if (body) {
        req.write(JSON.stringify(body));
      }

      req.end();
    });
  }

  /**
   * Create a new Matrix room
   */
  async createRoom(name, inviteUsers = []) {
    logger.info(`Creating room: ${name}`);
    
    const body = {
      name,
      preset: 'private_chat',
      invite: inviteUsers
    };

    const result = await this.request(
      'POST',
      '/_matrix/client/v3/createRoom',
      body,
      this.botToken
    );

    return result.room_id;
  }

  /**
   * Invite a user to a room
   */
  async inviteUser(roomId, userId) {
    logger.info(`Inviting ${userId} to ${roomId}`);

    await this.request(
      'POST',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`,
      { user_id: userId },
      this.botToken
    );
  }

  /**
   * Get room member count
   */
  async getRoomMemberCount(roomId) {
    const result = await this.request(
      'GET',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`,
      null,
      this.botToken
    );

    return Object.keys(result.joined || {}).length;
  }

  /**
   * Ensure room has at least 3 members (add padding user if needed)
   */
  async ensureMinimumMembers(roomId, paddingUser) {
    const count = await this.getRoomMemberCount(roomId);
    
    if (count < 3) {
      logger.info(`Room has ${count} members, adding padding user ${paddingUser}`);
      await this.inviteUser(roomId, paddingUser);
      
      // Verify
      const newCount = await this.getRoomMemberCount(roomId);
      logger.info(`Room now has ${newCount} members`);
    } else {
      logger.info(`Room has ${count} members, no padding needed`);
    }
  }

  /**
   * Set bot display name in a room
   */
  async setRoomDisplayName(roomId, displayName) {
    logger.info(`Setting display name in ${roomId} to ${displayName}`);

    await this.request(
      'PUT',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.member/${encodeURIComponent(this.botUserId)}`,
      {
        membership: 'join',
        displayname: displayName
      },
      this.botToken
    );
  }
}

module.exports = MatrixClient;
