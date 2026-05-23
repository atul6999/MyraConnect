/**
 * Gemini Response Generator
 * Generates responses for non-travel queries using Gemini
 */

const geminiClient = require('./geminiClient');
const logger = require('../utils/logger');

/**
 * System prompt for general assistant responses
 */
const GENERAL_ASSISTANT_SYSTEM_PROMPT = `You are Myra, a friendly and helpful AI assistant created by MakeMyTrip. You are designed to help users with travel-related queries, but you can also engage in friendly conversation.

## Your Personality:
- Friendly, warm, and approachable
- Professional but conversational
- Helpful and informative
- Keep responses concise (2-3 sentences max)
- Use emojis sparingly and appropriately

## Guidelines:
- For non-travel questions: Answer briefly and politely redirect to travel topics
- For greetings: Respond warmly and ask how you can help with their travel plans
- For questions about yourself: Explain you're Myra, MakeMyTrip's travel assistant
- Always end by offering to help with travel-related queries

## Response Format:
- Keep it short and WhatsApp-friendly
- Use simple language
- No markdown formatting (use *bold* for emphasis if needed)
- Be natural and conversational`;

/**
 * Generate response for non-travel queries using Gemini
 * @param {string} userQuery - User's question
 * @param {Object} session - User session for context
 * @returns {Promise<string|null>}
 */
async function generateGeneralResponse(userQuery, session = {}) {
  if (!geminiClient.isReady()) {
    logger.warn('Gemini client not ready, cannot generate general response');
    return null;
  }

  try {
    logger.info('🤖 [GEMINI] Generating general response...', {
      queryLength: userQuery.length,
      queryPreview: userQuery.substring(0, 50),
      source: 'GEMINI'
    });

    // Build context-aware prompt
    let prompt = `User asked: "${userQuery}"\n\nProvide a friendly, helpful response. `;
    
    // Add context if available
    if (session.lastQuery) {
      prompt += `Previous conversation context: "${session.lastQuery}". `;
    }
    
    prompt += `Keep response under 150 characters and end by offering to help with travel.`;

    // Generate response
    const response = await geminiClient.generate(prompt, GENERAL_ASSISTANT_SYSTEM_PROMPT);

    if (!response) {
      logger.warn('Gemini response generation returned null');
      return null;
    }

    // Clean and format response
    const cleanedResponse = cleanResponse(response);

    logger.info('✅ [GEMINI] General response generated', {
      length: cleanedResponse.length,
      preview: cleanedResponse.substring(0, 50),
      source: 'GEMINI'
    });

    return cleanedResponse;

  } catch (error) {
    logger.error('Failed to generate general response', {
      error: error.message,
      stack: error.stack
    });
    return null;
  }
}

/**
 * Clean and format response for WhatsApp
 * @param {string} response - Raw response from Gemini
 * @returns {string}
 */
function cleanResponse(response) {
  if (!response) return '';

  let cleaned = response.trim();

  // Remove markdown code blocks
  cleaned = cleaned.replace(/```[\s\S]*?```/g, '');
  
  // Replace ** with * for WhatsApp bold
  cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, '*$1*');
  
  // Remove any remaining markdown
  cleaned = cleaned.replace(/#{1,6}\s+/g, ''); // Headers
  cleaned = cleaned.replace(/\*\*/g, '*'); // Bold
  
  // Truncate if too long (WhatsApp limit is 4096, but keep it concise)
  if (cleaned.length > 500) {
    // Find last complete sentence before 500 chars
    const truncated = cleaned.substring(0, 500);
    const lastPeriod = truncated.lastIndexOf('.');
    const lastExclamation = truncated.lastIndexOf('!');
    const lastQuestion = truncated.lastIndexOf('?');
    const cutPoint = Math.max(lastPeriod, lastExclamation, lastQuestion);
    
    if (cutPoint > 200) {
      cleaned = cleaned.substring(0, cutPoint + 1);
    } else {
      cleaned = truncated + '...';
    }
  }

  return cleaned;
}

/**
 * Generate a fallback response when Gemini is unavailable
 * @param {string} userQuery
 * @returns {string}
 */
function generateFallbackResponse(userQuery) {
  const query = userQuery.toLowerCase().trim();
  
  // Greetings
  if (/^(hi|hello|hey|hii|hiii|hola|namaste)/i.test(query)) {
    return "Hello! 👋 I'm Myra, your travel assistant from MakeMyTrip. How can I help you plan your trip today?";
  }
  
  // How are you
  if (/how are you/i.test(query)) {
    return "I'm doing great, thank you! 😊 I'm here to help you with all your travel needs. What would you like to know?";
  }
  
  // Who are you / What are you
  if (/who are you|what are you/i.test(query)) {
    return "I'm Myra, your personal travel assistant from MakeMyTrip! ✈️ I can help you find hotels, flights, buses, and plan your perfect trip. What would you like to explore?";
  }
  
  // Default
  return "I'm Myra, your travel assistant! 🌍 I specialize in helping with hotels, flights, buses, and travel planning. How can I assist you with your travel needs today?";
}

module.exports = {
  generateGeneralResponse,
  generateFallbackResponse,
  GENERAL_ASSISTANT_SYSTEM_PROMPT
};
