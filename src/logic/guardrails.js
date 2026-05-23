/**
 * Guardrails Logic
 * Decision logic for handling AI responses and actions
 */

const logger = require('../utils/logger');

// Confidence threshold for asking clarifying questions
const LOW_CONFIDENCE_THRESHOLD = 0.5;

/**
 * @typedef {Object} GuardrailResult
 * @property {'normal'|'clarify'|'book'|'escalate'} action
 * @property {string} [message] - Override message if needed
 * @property {Object} [data] - Additional data
 */

/**
 * Apply guardrails to Myra response
 * @param {Object} myraResponse - Response from Myra AI
 * @param {Object} session - User session
 * @returns {GuardrailResult}
 */
function applyGuardrails(myraResponse, session) {
  // Check for low confidence
  if (myraResponse.confidence && myraResponse.confidence < LOW_CONFIDENCE_THRESHOLD) {
    logger.info('Low confidence response, asking clarification');
    return {
      action: 'clarify',
      message: "I'm not quite sure I understood. Could you please provide more details about what you're looking for?"
    };
  }

  // Check for explicit actions in response
  if (myraResponse.actions && myraResponse.actions.length > 0) {
    const actionResult = checkActions(myraResponse.actions);
    if (actionResult) {
      return actionResult;
    }
  }

  // Check for booking intent in text
  if (hasBookingIntent(myraResponse)) {
    return {
      action: 'book',
      data: extractBookingData(myraResponse)
    };
  }

  // Check for escalation keywords
  if (hasEscalationIntent(myraResponse)) {
    return {
      action: 'escalate',
      message: "I'll connect you with a human agent who can better assist you. Please wait a moment."
    };
  }

  // Normal flow
  return { action: 'normal' };
}

/**
 * Check actions array for special actions
 * @param {Array} actions
 * @returns {GuardrailResult|null}
 */
function checkActions(actions) {
  for (const action of actions) {
    switch (action.action?.toUpperCase()) {
      case 'BOOK':
      case 'BOOKING':
        return {
          action: 'book',
          data: { itemId: action.payload }
        };

      case 'HUMAN':
      case 'AGENT':
      case 'ESCALATE':
        return {
          action: 'escalate',
          message: "I'll connect you with a human agent. Please wait."
        };
    }
  }
  return null;
}

/**
 * Check if response indicates booking intent
 * @param {Object} response
 * @returns {boolean}
 */
function hasBookingIntent(response) {
  const text = (response.text || response.leadingQuestion || '').toLowerCase();
  const bookingKeywords = ['proceed with booking', 'confirm your booking', 'let me book', 'booking confirmed'];
  
  return bookingKeywords.some(keyword => text.includes(keyword));
}

/**
 * Check if response indicates escalation need
 * @param {Object} response
 * @returns {boolean}
 */
function hasEscalationIntent(response) {
  const text = (response.text || response.leadingQuestion || '').toLowerCase();
  const escalationKeywords = ['speak to agent', 'human agent', 'escalating', 'connect you with'];
  
  return escalationKeywords.some(keyword => text.includes(keyword));
}

/**
 * Extract booking data from response
 * @param {Object} response
 * @returns {Object}
 */
function extractBookingData(response) {
  // Extract relevant booking information
  return {
    timestamp: Date.now(),
    text: response.text || response.leadingQuestion
  };
}

/**
 * Check button click for special actions
 * @param {string} buttonId
 * @returns {Object|null}
 */
function checkButtonAction(buttonId) {
  if (!buttonId) return null;

  // Carousel navigation
  if (buttonId === 'carousel_next') {
    return { type: 'carousel', direction: 'next' };
  }
  if (buttonId === 'carousel_prev') {
    return { type: 'carousel', direction: 'prev' };
  }

  // Item selection
  if (buttonId.startsWith('select_')) {
    const itemId = buttonId.replace('select_', '');
    return { type: 'select', itemId };
  }

  // Action buttons
  if (buttonId.startsWith('action_')) {
    const parts = buttonId.split('_');
    return { type: 'action', action: parts[1], payload: parts.slice(2).join('_') };
  }

  // Suggestion buttons
  if (buttonId.startsWith('suggestion_')) {
    const index = parseInt(buttonId.replace('suggestion_', ''), 10);
    return { type: 'suggestion', index };
  }

  // View hotel details button
  if (buttonId.startsWith('view_hotel_')) {
    const hotelId = buttonId.replace('view_hotel_', '');
    return { type: 'viewHotel', hotelId };
  }

  // Book Now button (for products with booking links)
  if (buttonId.startsWith('book_')) {
    const productId = buttonId.replace('book_', '');
    return { type: 'bookNow', productId };
  }

  return null;
}

module.exports = {
  applyGuardrails,
  checkButtonAction,
  LOW_CONFIDENCE_THRESHOLD
};
