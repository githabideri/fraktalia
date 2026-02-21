/**
 * Utility functions
 */

const { appendFileSync } = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, '..', 'fractal-api.log');

/**
 * Simple logger
 */
const logger = {
  info: (msg, ...args) => {
    const timestamp = new Date().toISOString();
    const message = `[${timestamp}] INFO: ${msg} ${args.join(' ')}`;
    console.log(message);
    try {
      appendFileSync(LOG_FILE, message + '\n');
    } catch (err) {
      // Ignore log file errors
    }
  },

  warn: (msg, ...args) => {
    const timestamp = new Date().toISOString();
    const message = `[${timestamp}] WARN: ${msg} ${args.join(' ')}`;
    console.warn(message);
    try {
      appendFileSync(LOG_FILE, message + '\n');
    } catch (err) {
      // Ignore log file errors
    }
  },

  error: (msg, ...args) => {
    const timestamp = new Date().toISOString();
    const message = `[${timestamp}] ERROR: ${msg} ${args.join(' ')}`;
    console.error(message);
    try {
      appendFileSync(LOG_FILE, message + '\n');
    } catch (err) {
      // Ignore log file errors
    }
  }
};

/**
 * Send JSON response
 */
function respondJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
}

/**
 * Send error response
 */
function respondError(res, status, message, details = null) {
  const error = {
    success: false,
    error: message
  };

  if (details) {
    error.details = details;
  }

  respondJSON(res, status, error);
}

module.exports = {
  logger,
  respondJSON,
  respondError
};
