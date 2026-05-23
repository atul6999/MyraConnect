/**
 * WhatsApp Business API Client
 * Sends messages to WhatsApp Cloud API
 */

const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');
const { normalizePhoneNumber, formatPhoneNumber } = require('../utils/phoneNumber');

class WhatsAppClient {
  constructor() {
    this.baseUrl = `${config.whatsapp.apiUrl}/${config.whatsapp.phoneNumberId}/messages`;
    // Headers will be built dynamically to always use the latest token
    this._baseHeaders = {
      'Content-Type': 'application/json'
    };
  }

  /**
   * Get current headers with fresh token from config
   * This ensures we always use the latest token from environment
   * @returns {Object}
   */
  _getHeaders() {
    const accessToken = config.whatsapp.accessToken;
    if (!accessToken) {
      logger.warn('⚠️ WA_ACCESS_TOKEN is not set in environment');
    }
    return {
      ...this._baseHeaders,
      'Authorization': `Bearer ${accessToken}`
    };
  }

  /**
   * Normalize phone number in payload
   * @param {Object} payload - WhatsApp message payload
   * @returns {Object} - Payload with normalized phone number
   */
  _normalizePayload(payload) {
    if (payload.to) {
      const originalTo = payload.to;
      const normalizedTo = normalizePhoneNumber(payload.to);
      
      if (originalTo !== normalizedTo) {
        logger.debug('Normalizing phone number', {
          original: originalTo,
          normalized: normalizedTo
        });
      }
      
      return {
        ...payload,
        to: normalizedTo
      };
    }
    return payload;
  }

  /**
   * Check if error is due to recipient not in allowed list
   * @param {Object} error - Axios error
   * @returns {boolean}
   */
  _isRecipientNotAllowedError(error) {
    const errorCode = error.response?.data?.error?.code;
    const errorMessage = error.response?.data?.error?.message || '';
    return errorCode === 131030 || errorMessage.includes('Recipient phone number not in allowed list');
  }

  /**
   * Check if error is due to expired or invalid access token
   * @param {Object} error - Axios error
   * @returns {boolean}
   */
  _isTokenError(error) {
    const errorCode = error.response?.data?.error?.code;
    const errorMessage = error.response?.data?.error?.message || '';
    const errorType = error.response?.data?.error?.type || '';
    
    // Error code 190 = OAuthException (token issues)
    // Error code 401 = Unauthorized (usually token issues)
    return errorCode === 190 || 
           errorCode === 401 || 
           errorType === 'OAuthException' ||
           errorMessage.includes('access token') ||
           errorMessage.includes('Session has expired') ||
           errorMessage.includes('Token expired');
  }

  /**
   * Check if error is due to invalid phone number ID
   * @param {Object} error - Axios error
   * @returns {boolean}
   */
  _isPhoneNumberIdError(error) {
    const errorCode = error.response?.data?.error?.code;
    const errorSubcode = error.response?.data?.error?.error_subcode;
    const errorMessage = error.response?.data?.error?.message || '';
    const errorType = error.response?.data?.error?.type || '';
    
    // Error code 100 with subcode 33 = Object doesn't exist or no permissions
    // This usually means the phone number ID is invalid or inaccessible
    return (errorCode === 100 && errorSubcode === 33) ||
           errorType === 'GraphMethodException' ||
           errorMessage.includes('does not exist') ||
           errorMessage.includes('cannot be loaded due to missing permissions') ||
           errorMessage.includes('does not support this operation');
  }

  /**
   * Send a message to WhatsApp
   * @param {Object} payload - WhatsApp message payload
   * @returns {Promise<Object>}
   */
  async send(payload) {
    // Normalize phone number
    const normalizedPayload = this._normalizePayload(payload);
    const phoneNumberDisplay = formatPhoneNumber(normalizedPayload.to);

    // Test mode: Skip actual API call in development
    if (config.isDev && !config.whatsapp.accessToken) {
      logger.info('🧪 TEST MODE: Skipping WhatsApp API call', {
        to: phoneNumberDisplay,
        normalized: normalizedPayload.to,
        type: normalizedPayload.type,
        message: normalizedPayload.text?.body || normalizedPayload.interactive?.body?.text || 'N/A'
      });
      return {
        messaging_product: 'whatsapp',
        contacts: [{ input: normalizedPayload.to, wa_id: normalizedPayload.to }],
        messages: [{ id: `test_${Date.now()}` }]
      };
    }

    try {
      logger.debug('Sending WhatsApp message', {
        to: phoneNumberDisplay,
        normalized: normalizedPayload.to,
        type: normalizedPayload.type
      });

      const response = await axios.post(this.baseUrl, normalizedPayload, {
        headers: this._getHeaders()
      });
      
      // Check if message was actually accepted
      const messageId = response.data?.messages?.[0]?.id;
      const contactWaId = response.data?.contacts?.[0]?.wa_id;
      
      // Log full response for debugging
      logger.info('✅ WhatsApp API Response', {
        status: response.status,
        messageId: messageId,
        contactWaId: contactWaId,
        contacts: response.data?.contacts,
        to: phoneNumberDisplay,
        normalizedTo: normalizedPayload.to,
        hasMessageId: !!messageId,
        responseData: JSON.stringify(response.data, null, 2)
      });
      
      // Warn if contact wa_id doesn't match (might indicate number not in allowed list)
      if (contactWaId && contactWaId !== normalizedPayload.to) {
        logger.warn('⚠️ Contact WA ID mismatch', {
          expected: normalizedPayload.to,
          received: contactWaId,
          message: 'This might indicate the phone number is not in the allowed recipient list'
        });
      }
      
      // Warn if no message ID (shouldn't happen, but good to check)
      if (!messageId) {
        logger.warn('⚠️ No message ID in response', {
          responseData: response.data,
          message: 'Message might not have been accepted by WhatsApp'
        });
      }
      
      logger.debug('Message sent successfully', { 
        messageId: messageId,
        to: phoneNumberDisplay
      });
      return response.data;
    } catch (error) {
      const errorData = error.response?.data?.error || {};
      const errorCode = errorData.code;
      const errorMessage = errorData.message || error.message;
      const errorType = errorData.type || '';

      // Special handling for token errors (expired/invalid)
      if (this._isTokenError(error)) {
        const currentToken = config.whatsapp.accessToken;
        const tokenPreview = currentToken ? 
          `${currentToken.substring(0, 10)}...${currentToken.substring(currentToken.length - 5)}` : 
          'NOT SET';
        
        logger.error('❌ WhatsApp Access Token Error', {
          errorCode,
          errorType,
          errorMessage,
          tokenPreview,
          tokenLength: currentToken?.length || 0,
          help: 'Your WhatsApp access token has expired or is invalid. Generate a new token from WhatsApp Business Manager and update WA_ACCESS_TOKEN in your .env file. IMPORTANT: You must restart the application after updating the .env file for changes to take effect.'
        });
        
        // Create a custom error with more context
        const customError = new Error(`WhatsApp access token expired or invalid. Error: ${errorMessage}. Please generate a new token from WhatsApp Business Manager and restart the application.`);
        customError.code = errorCode || 190;
        customError.isTokenError = true;
        customError.originalMessage = errorMessage;
        throw customError;
      }

      // Special handling for phone number ID errors (invalid or missing permissions)
      if (this._isPhoneNumberIdError(error)) {
        const phoneNumberId = config.whatsapp.phoneNumberId;
        const phoneNumberIdPreview = phoneNumberId ? 
          `${phoneNumberId.substring(0, 5)}...${phoneNumberId.substring(phoneNumberId.length - 5)}` : 
          'NOT SET';
        
        logger.error('❌ WhatsApp Phone Number ID Error', {
          errorCode,
          errorSubcode: errorData.error_subcode,
          errorType,
          errorMessage,
          phoneNumberId: phoneNumberIdPreview,
          phoneNumberIdLength: phoneNumberId?.length || 0,
          help: 'Your WhatsApp phone number ID is invalid, does not exist, or your access token does not have permissions to access it. Verify WA_PHONE_NUMBER_ID in your .env file matches the phone number ID from WhatsApp Business Manager. Ensure your access token has permissions for this phone number. IMPORTANT: You must restart the application after updating the .env file.'
        });
        
        // Create a custom error with more context
        const customError = new Error(`WhatsApp phone number ID is invalid or inaccessible. Error: ${errorMessage}. Please verify WA_PHONE_NUMBER_ID in your .env file and ensure your access token has permissions for this phone number ID.`);
        customError.code = errorCode || 100;
        customError.isPhoneNumberIdError = true;
        customError.originalMessage = errorMessage;
        throw customError;
      }

      // Special handling for recipient not allowed error
      if (this._isRecipientNotAllowedError(error)) {
        logger.error('❌ Recipient phone number not in allowed list', {
          phoneNumber: phoneNumberDisplay,
          normalized: normalizedPayload.to,
          errorCode,
          errorMessage,
          help: 'Add this phone number to the allowed recipient list in WhatsApp Business Manager'
        });
        
        // Create a custom error with more context
        const customError = new Error(`Recipient ${phoneNumberDisplay} is not in the allowed list. Please add it in WhatsApp Business Manager.`);
        customError.code = 131030;
        customError.isRecipientNotAllowed = true;
        customError.phoneNumber = phoneNumberDisplay;
        customError.normalizedPhoneNumber = normalizedPayload.to;
        throw customError;
      }

      logger.error('Failed to send WhatsApp message', {
        phoneNumber: phoneNumberDisplay,
        normalized: normalizedPayload.to,
        error: errorData || error.message,
        status: error.response?.status,
        errorCode,
        errorType
      });
      throw error;
    }
  }

  /**
   * Send text message
   * @param {string} to - Recipient phone number
   * @param {string} text - Message text
   * @returns {Promise<Object>}
   */
  async sendText(to, text) {
    const normalizedTo = normalizePhoneNumber(to);
    
    // WhatsApp text message limit: 4096 characters
    const MAX_TEXT_LENGTH = 4096;
    let messageText = text;
    
    if (text && text.length > MAX_TEXT_LENGTH) {
      logger.warn('Text message too long, truncating', {
        originalLength: text.length,
        maxLength: MAX_TEXT_LENGTH
      });
      messageText = text.substring(0, MAX_TEXT_LENGTH - 3) + '...';
    }
    
    return this.send({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: normalizedTo,
      type: 'text',
      text: { body: messageText }
    });
  }

  /**
   * Send image message
   * @param {string} to - Recipient phone number
   * @param {string} imageUrl - Image URL
   * @param {string} [caption] - Optional caption
   * @returns {Promise<Object>}
   */
  async sendImage(to, imageUrl, caption = '') {
    const normalizedTo = normalizePhoneNumber(to);
    return this.send({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: normalizedTo,
      type: 'image',
      image: {
        link: imageUrl,
        caption: caption
      }
    });
  }

  /**
   * Send interactive button message
   * @param {string} to - Recipient phone number
   * @param {string} bodyText - Message body
   * @param {Array<{id: string, title: string}>} buttons - Up to 3 buttons
   * @param {string} [header] - Optional header text
   * @param {string} [footer] - Optional footer text
   * @returns {Promise<Object>}
   */
  async sendButtons(to, bodyText, buttons, header = null, footer = null) {
    const normalizedTo = normalizePhoneNumber(to);
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: normalizedTo,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: bodyText },
        action: {
          buttons: buttons.slice(0, 3).map(btn => ({
            type: 'reply',
            reply: { id: btn.id, title: btn.title.slice(0, 20) }
          }))
        }
      }
    };

    if (header) {
      payload.interactive.header = { type: 'text', text: header };
    }
    if (footer) {
      payload.interactive.footer = { text: footer };
    }

    return this.send(payload);
  }

  /**
   * Send interactive list message
   * @param {string} to - Recipient phone number
   * @param {string} bodyText - Message body
   * @param {string} buttonText - Button text to open list
   * @param {Array<{title: string, rows: Array<{id: string, title: string, description?: string}>}>} sections
   * @returns {Promise<Object>}
   */
  async sendList(to, bodyText, buttonText, sections) {
    const normalizedTo = normalizePhoneNumber(to);
    return this.send({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: normalizedTo,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: bodyText },
        action: {
          button: buttonText.slice(0, 20),
          sections: sections.map(section => ({
            title: section.title.slice(0, 24),
            rows: section.rows.slice(0, 10).map(row => ({
              id: row.id,
              title: row.title.slice(0, 24),
              description: row.description?.slice(0, 72)
            }))
          }))
        }
      }
    });
  }

  /**
   * Send image with interactive buttons (for carousel items)
   * @param {string} to - Recipient phone number
   * @param {string} imageUrl - Image URL
   * @param {string} caption - Image caption
   * @param {Array<{id: string, title: string, url?: string}>} buttons - Up to 3 buttons
   *   If button has 'url' property, it will be a URL button that opens the link directly
   *   Otherwise, it will be a reply button that sends the id back to webhook
   * @returns {Promise<Object>}
   */
  async sendImageWithButtons(to, imageUrl, caption, buttons) {
    const normalizedTo = normalizePhoneNumber(to);
    return this.send({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: normalizedTo,
      type: 'interactive',
      interactive: {
        type: 'button',
        header: {
          type: 'image',
          image: { link: imageUrl }
        },
        body: { text: caption },
        action: {
          buttons: buttons.slice(0, 3).map(btn => ({
            type: 'reply',
            reply: { id: btn.id, title: btn.title.slice(0, 20) }
          }))
        }
      }
    });
  }

  /**
   * Send typing indicator (shows "typing..." in WhatsApp)
   * @param {string} to - Recipient phone number
   * @param {boolean} typing - true to start typing, false to stop
   * @param {string} [messageId] - Optional message ID from incoming message (required for some API versions)
   * @returns {Promise<Object>}
   */
  async sendTypingIndicator(to, typing = true, messageId = null) {
    const normalizedTo = normalizePhoneNumber(to);
    const phoneNumberDisplay = formatPhoneNumber(normalizedTo);

    // Test mode: Skip actual API call in development
    if (config.isDev && !config.whatsapp.accessToken) {
      logger.info('🧪 TEST MODE: Skipping typing indicator', {
        to: phoneNumberDisplay,
        typing,
        messageId
      });
      return { success: true };
    }

    try {
      logger.info('📝 Sending typing indicator', {
        to: phoneNumberDisplay,
        normalized: normalizedTo,
        typing,
        messageId,
        hasMessageId: !!messageId
      });

      const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: normalizedTo,
        type: 'typing',
        typing: typing
      };

      // Include message_id if provided (some API versions require it)
      if (messageId) {
        payload.context = {
          message_id: messageId
        };
      }

      logger.debug('Typing indicator payload', {
        payload: JSON.stringify(payload, null, 2)
      });

      const response = await axios.post(this.baseUrl, payload, {
        headers: this._getHeaders()
      });

      logger.info('✅ Typing indicator sent successfully', {
        to: phoneNumberDisplay,
        typing,
        status: response.status,
        responseData: JSON.stringify(response.data, null, 2)
      });

      return response.data;
    } catch (error) {
      // Don't throw errors for typing indicators - they're not critical
      // Just log and continue
      const errorData = error.response?.data?.error || {};
      const errorCode = errorData.code;
      const errorMessage = errorData.message || error.message;
      
      logger.warn('⚠️ Failed to send typing indicator (non-critical)', {
        to: phoneNumberDisplay,
        typing,
        messageId,
        errorCode,
        errorMessage,
        errorType: errorData.type,
        fullError: error.response?.data ? JSON.stringify(error.response.data, null, 2) : error.message
      });
      return { success: false, error: errorMessage, errorCode };
    }
  }
}

module.exports = new WhatsAppClient();
