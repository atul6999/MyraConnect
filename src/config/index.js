/**
 * Configuration Manager
 * Loads environment variables and provides typed config object
 */

require('dotenv').config();

const config = {
  // Server
  port: parseInt(process.env.PORT, 10) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  isDev: process.env.NODE_ENV !== 'production',

  // WhatsApp Business API
  whatsapp: {
    phoneNumberId: process.env.WA_PHONE_NUMBER_ID,
    accessToken: process.env.WA_ACCESS_TOKEN,
    verifyToken: process.env.WA_VERIFY_TOKEN,
    apiUrl: 'https://graph.facebook.com/v18.0'
  },

  // Myra AI WebSocket
  myra: {
    wsUrl: process.env.MYRA_WS_URL || 'wss://apolloalpha.makemytrip.com/travelplex/ws/websocket',
    deviceId: process.env.MYRA_DEVICE_ID,
    sessionId: process.env.MYRA_SESSION_ID,
    org: process.env.MYRA_ORG || 'MMT',
    requestTimeoutMs: parseInt(process.env.MYRA_REQUEST_TIMEOUT_MS, 10) || 60000 // 60 seconds default
  },

  // Session
  session: {
    ttlMinutes: parseInt(process.env.SESSION_TTL_MINUTES, 10) || 30
  },

  // Message Processing
  processing: {
    // Timeout for message processing (should be longer than Myra request timeout)
    timeoutMs: parseInt(process.env.PROCESSING_TIMEOUT_MS, 10) || 70000 // 70 seconds default (10s buffer over Myra timeout)
  }
};

module.exports = config;
