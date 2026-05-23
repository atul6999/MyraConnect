/**
 * Myra AI WebSocket Client
 * Persistent WebSocket connection with auto-reconnect and event handling
 */

const WebSocket = require('ws');
const EventEmitter = require('events');
const config = require('../config');
const logger = require('../utils/logger');
const { 
  buildNewChatPayload, 
  buildPostMessagePayload,
  buildHeartbeatPayload 
} = require('./payloadBuilder');

class MyraWSClient extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 3000;
    this.heartbeatInterval = null;
    this.pendingRequests = new Map();
  }

  /**
   * Connect to Myra WebSocket
   * @returns {Promise<void>}
   */
  connect() {
    return new Promise((resolve, reject) => {
      if (this.isConnected) {
        resolve();
        return;
      }

      logger.info('Connecting to Myra WebSocket', { url: config.myra.wsUrl });

      this.ws = new WebSocket(config.myra.wsUrl);

      this.ws.on('open', () => {
        logger.info('Myra WebSocket connected');
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.startHeartbeat();
        this.emit('connected');
        resolve();
      });

      this.ws.on('message', (data) => {
        this.handleMessage(data);
      });

      this.ws.on('close', (code, reason) => {
        logger.warn('Myra WebSocket closed', { code, reason: reason.toString() });
        this.isConnected = false;
        this.stopHeartbeat();
        this.handleReconnect();
      });

      this.ws.on('error', (error) => {
        logger.error('Myra WebSocket error', { error: error.message });
        if (!this.isConnected) {
          reject(error);
        }
      });
    });
  }

  /**
   * Handle incoming WebSocket message
   * @param {Buffer} data
   */
  handleMessage(data) {
    try {
      const message = JSON.parse(data.toString());
      
      // Extract tempId from various possible locations (ensure it's a string for consistent matching)
      const rawTempId = message.uiMetadata?.tempId || 
                        message.tempId || 
                        message.data?.uiMetadata?.tempId ||
                        message.headers?.['request-id'];
      const tempId = rawTempId ? String(rawTempId) : null;
      
      logger.info('Received Myra message', { 
        eventType: message.eventType,
        conversationId: message.data?.conversationId,
        hasMessage: !!message.data?.message,
        messageContent: message.data?.message?.content?.[0]?.value || message.data?.leadingQuestion || 'N/A',
        tempId: tempId,
        hasUiMetadata: !!message.uiMetadata,
        pendingRequestsCount: this.pendingRequests.size,
        pendingTempIds: Array.from(this.pendingRequests.keys())
      });

      // Log full message structure for debugging (only for non-heartbeat messages)
      if (message.eventType !== 'HEART_BEAT') {
        logger.debug('Full Myra response structure', { 
          fullMessage: JSON.stringify(message, null, 2),
          eventType: message.eventType
        });
      }

      // Emit event for handlers
      this.emit('message', message);

      // Handle specific event types
      switch (message.eventType) {
        case 'NEW_CHAT_CREATED':
          this.emit('chatCreated', message);
          // Don't resolve on NEW_CHAT_CREATED - wait for NEW_MESSAGE which has the actual response
          // But if NEW_MESSAGE already came (shouldn't happen), resolve now
          if (tempId && this.pendingRequests.has(tempId)) {
            logger.debug('NEW_CHAT_CREATED received, waiting for NEW_MESSAGE', { tempId });
            // Store the NEW_CHAT_CREATED message for later use
            const pending = this.pendingRequests.get(tempId);
            if (pending) {
              pending.chatCreated = message;
            }
          }
          break;

        case 'NEW_MESSAGE':
          this.emit('newMessage', message);
          // NEW_MESSAGE contains the actual assistant reply - resolve with this
          // Merge with NEW_CHAT_CREATED if we stored it
          if (tempId && this.pendingRequests.has(tempId)) {
            const pending = this.pendingRequests.get(tempId);
            if (pending && pending.chatCreated) {
              // Merge both messages - use NEW_MESSAGE as primary but include conversationId from NEW_CHAT_CREATED if needed
              logger.debug('Merging NEW_CHAT_CREATED and NEW_MESSAGE', { tempId });
              if (!message.data?.conversationId && pending.chatCreated.data?.conversationId) {
                message.data = message.data || {};
                message.data.conversationId = pending.chatCreated.data.conversationId;
              }
            }
            
            // Check if this is a loader message - don't resolve yet if it is
            const messageContent = message.data?.message?.content || [];
            const hasLoaderText = messageContent.some(content => content.type === 'LOADER_TEXT');
            const isCompleted = message.data?.message?.isCompleted === true; // Explicitly check for true
            const hasActualContent = messageContent.some(content => 
              content.type === 'TEXT' || content.type === 'CARD' || content.type === 'LIST'
            );
            const hasLeadingQuestion = !!message.data?.leadingQuestion;
            
            // Store the latest message
            if (pending) {
              pending.lastMessage = message;
            }
            
            // Only resolve if:
            // 1. Has leadingQuestion (which is the actual response), OR
            // 2. Has actual content types (TEXT, CARD, LIST) - even if not completed, as Myra may send multiple updates
            if (hasLoaderText && !hasActualContent && !hasLeadingQuestion) {
              logger.debug('Skipping resolution - LOADER_TEXT only, waiting for actual content', { 
                tempId,
                isCompleted,
                hasLoaderText,
                hasActualContent,
                hasLeadingQuestion,
                contentTypes: messageContent.map(c => c.type)
              });
              // Don't resolve yet - wait for actual content
            } else if (hasActualContent || hasLeadingQuestion) {
              // This is actual content - resolve now
              logger.debug('Resolving with actual content', {
                tempId,
                isCompleted,
                hasLoaderText,
                hasActualContent,
                hasLeadingQuestion,
                contentTypes: messageContent.map(c => c.type)
              });
              this.resolvePending(tempId, message);
            } else {
              // Edge case: no loader, no actual content - might be empty message, resolve anyway
              logger.debug('Resolving NEW_MESSAGE with no clear content type', {
                tempId,
                contentTypes: messageContent.map(c => c.type),
                hasLeadingQuestion
              });
              this.resolvePending(tempId, message);
            }
          } else {
            // No pending request - this might be a follow-up message after resolution
            // Log for debugging but don't try to resolve
            logger.debug('Received response but no pending requests', { 
              tempId, 
              eventType: message.eventType 
            });
          }
          break;

        default:
          logger.debug('Unhandled event type', { 
            eventType: message.eventType,
            tempId: tempId,
            willTryToResolve: !!tempId && this.pendingRequests.has(tempId)
          });
          // Try to resolve anyway if we have a tempId match (for other event types that might be valid responses)
          if (tempId && this.pendingRequests.has(tempId)) {
            logger.info('⚠️ Resolving unhandled event type with matching tempId', { 
              eventType: message.eventType,
              tempId 
            });
            this.resolvePending(tempId, message);
          }
      }
    } catch (error) {
      logger.error('Error parsing Myra message', { error: error.message, stack: error.stack });
    }
  }

  /**
   * Send message to Myra WebSocket
   * @param {Object} payload
   * @returns {Promise<Object>}
   */
  send(payload) {
    return new Promise((resolve, reject) => {
      if (!this.isConnected) {
        logger.error('❌ Cannot send: WebSocket not connected', { 
          isConnected: this.isConnected,
          hasWs: !!this.ws,
          readyState: this.ws?.readyState
        });
        reject(new Error('WebSocket not connected'));
        return;
      }

      // Check WebSocket ready state
      if (this.ws.readyState !== WebSocket.OPEN) {
        logger.error('❌ Cannot send: WebSocket not in OPEN state', { 
          readyState: this.ws.readyState,
          readyStateNames: {
            0: 'CONNECTING',
            1: 'OPEN',
            2: 'CLOSING',
            3: 'CLOSED'
          }
        });
        reject(new Error(`WebSocket not ready (state: ${this.ws.readyState})`));
        return;
      }

      const tempId = payload.uiMetadata?.tempId;
      
      // Store pending request for resolution (ensure tempId is string for consistent matching)
      if (tempId) {
        const tempIdStr = String(tempId);
        this.pendingRequests.set(tempIdStr, { 
          resolve, 
          reject, 
          timestamp: Date.now(),
          chatCreated: null // Store NEW_CHAT_CREATED if it comes first
        });
        
        logger.debug('📝 Stored pending request', { 
          tempId: tempIdStr,
          pendingRequestsCount: this.pendingRequests.size,
          allPendingTempIds: Array.from(this.pendingRequests.keys())
        });
        
        // Timeout after configured duration (default 60 seconds)
        const timeoutMs = config.myra.requestTimeoutMs;
        const timeoutSeconds = timeoutMs / 1000;
        setTimeout(() => {
          if (this.pendingRequests.has(tempIdStr)) {
            logger.error('⏰ Myra request timeout', { 
              tempId: tempIdStr,
              pendingRequests: this.pendingRequests.size,
              waitingTime: `${timeoutSeconds} seconds`,
              allPendingTempIds: Array.from(this.pendingRequests.keys())
            });
            this.pendingRequests.delete(tempIdStr);
            reject(new Error(`Request timeout - Myra did not respond within ${timeoutSeconds} seconds`));
          }
        }, timeoutMs);
      }

      logger.info('📤 Sending message to Myra', { 
        eventType: payload.eventType,
        tempId: tempId,
        messageText: payload.data?.message?.content?.[0]?.value || 'N/A',
        payloadStructure: {
          hasUiMetadata: !!payload.uiMetadata,
          uiMetadataKeys: payload.uiMetadata ? Object.keys(payload.uiMetadata) : [],
          hasData: !!payload.data,
          hasHeaders: !!payload.headers
        }
      });
      
      // Log full payload for debugging
      logger.debug('Full payload being sent to Myra', { 
        payload: JSON.stringify(payload, null, 2),
        tempId 
      });
      
      this.ws.send(JSON.stringify(payload), (error) => {
        if (error) {
          logger.error('❌ Error sending to Myra', { error: error.message, stack: error.stack });
          if (tempId) {
            this.pendingRequests.delete(tempId);
          }
          reject(error);
        } else {
          logger.info('✅ Message sent to Myra successfully', { 
            eventType: payload.eventType, 
            tempId,
            waitingForResponse: !!tempId,
            pendingRequestsCount: this.pendingRequests.size
          });
          // If no tempId, resolve immediately
          if (!tempId) {
            resolve();
          }
        }
      });
    });
  }

  /**
   * Resolve pending request
   * @param {string} tempId
   * @param {Object} response
   */
  resolvePending(tempId, response) {
    if (!tempId) {
      logger.debug('No tempId in response, cannot resolve pending request', { 
        eventType: response?.eventType 
      });
      return;
    }

    // Try exact match first
    if (this.pendingRequests.has(tempId)) {
      logger.info('✅ Resolving pending Myra request (exact match)', { 
        tempId,
        eventType: response?.eventType,
        hasData: !!response?.data
      });
      const { resolve } = this.pendingRequests.get(tempId);
      this.pendingRequests.delete(tempId);
      resolve(response);
      return;
    }

    // Try string conversion match (in case of number/string mismatch)
    const tempIdStr = String(tempId);
    if (this.pendingRequests.has(tempIdStr)) {
      logger.info('✅ Resolving pending Myra request (string match)', { 
        tempId,
        tempIdStr,
        eventType: response?.eventType
      });
      const { resolve } = this.pendingRequests.get(tempIdStr);
      this.pendingRequests.delete(tempIdStr);
      resolve(response);
      return;
    }

    // Try to find by partial match (in case tempId is embedded differently)
    for (const [pendingTempId, request] of this.pendingRequests.entries()) {
      if (String(pendingTempId).includes(String(tempId)) || String(tempId).includes(String(pendingTempId))) {
        logger.info('✅ Resolving pending Myra request (partial match)', { 
          tempId,
          pendingTempId,
          eventType: response?.eventType
        });
        const { resolve } = request;
        this.pendingRequests.delete(pendingTempId);
        resolve(response);
        return;
      }
    }

    // If we have pending requests but no match, log warning
    if (this.pendingRequests.size > 0) {
      logger.warn('⚠️ Received response for unknown tempId', { 
        tempId, 
        eventType: response?.eventType,
        pendingRequestsCount: this.pendingRequests.size,
        pendingTempIds: Array.from(this.pendingRequests.keys()),
        responseStructure: {
          hasUiMetadata: !!response?.uiMetadata,
          uiMetadataKeys: response?.uiMetadata ? Object.keys(response.uiMetadata) : [],
          hasHeaders: !!response?.headers,
          headerKeys: response?.headers ? Object.keys(response.headers) : []
        }
      });
    } else {
      logger.debug('Received response but no pending requests', { 
        tempId, 
        eventType: response?.eventType 
      });
    }
  }

  /**
   * Create new chat and send first message
   * @param {string} message - User message
   * @returns {Promise<Object>}
   */
  async newChat(message) {
    const payload = buildNewChatPayload(message);
    return this.send(payload);
  }

  /**
   * Send message to existing conversation
   * @param {string} conversationId
   * @param {string} message
   * @returns {Promise<Object>}
   */
  async postMessage(conversationId, message) {
    const payload = buildPostMessagePayload(conversationId, message);
    return this.send(payload);
  }

  /**
   * Start heartbeat interval
   */
  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      if (this.isConnected) {
        const payload = buildHeartbeatPayload();
        this.ws.send(JSON.stringify(payload));
        logger.debug('Heartbeat sent');
      }
    }, 30000); // Every 30 seconds
  }

  /**
   * Stop heartbeat interval
   */
  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Handle reconnection
   */
  handleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('Max reconnect attempts reached');
      this.emit('maxReconnectReached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * this.reconnectAttempts;
    
    logger.info(`Reconnecting in ${delay}ms`, { attempt: this.reconnectAttempts });
    
    setTimeout(() => {
      this.connect().catch((error) => {
        logger.error('Reconnect failed', { error: error.message });
      });
    }, delay);
  }

  /**
   * Disconnect from WebSocket
   */
  disconnect() {
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    this.pendingRequests.clear();
  }
}

// Export singleton instance
module.exports = new MyraWSClient();
