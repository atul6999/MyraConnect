/**
 * Comparison Generator
 * Generates intelligent comparisons for travel options
 */

const geminiClient = require('./geminiClient');
const genaiConfig = require('./config');
const { COMPARISON_SYSTEM_PROMPT, buildComparisonPrompt } = require('./prompts');
const logger = require('../utils/logger');

/**
 * Check if comparison should be generated for this response
 * @param {Object} myraResponse - Response data from Myra
 * @returns {boolean}
 */
function shouldGenerateComparison(myraResponse) {
  // Check if comparison is enabled
  if (!genaiConfig.comparisonEnabled) {
    return false;
  }

  // Check if we have product cards
  const cards = myraResponse.hotelCards || [];
  
  if (cards.length < 2) {
    logger.debug('Comparison skipped: less than 2 options');
    return false;
  }

  if (cards.length > 5) {
    logger.debug('Comparison skipped: too many options (>5)');
    return false;
  }

  // Check if cards have comparable data (at least price OR rating)
  const hasComparableData = cards.some(card => card.price || card.rating);
  if (!hasComparableData) {
    logger.debug('Comparison skipped: no comparable data in cards');
    return false;
  }

  return true;
}

/**
 * Extract comparison-relevant data from Myra response
 * @param {Object} myraResponse - Response data from Myra
 * @returns {Array<Object>}
 */
function extractComparisonOptions(myraResponse) {
  const cards = myraResponse.hotelCards || [];

  return cards.map(card => ({
    id: card.id,
    title: card.title || 'Unknown',
    price: card.price || null,
    priceNumeric: extractNumericPrice(card.price),
    rating: card.rating ? parseFloat(card.rating) : null,
    reviewCount: formatReviewCount(card.ratingCount),
    location: card.location || card.subtitle || null,
    amenities: extractAmenities(card),
    description: card.description || null,
    bookingLink: card.bookingLink || null,
    productType: card.productType || 'hotel',
  }));
}

/**
 * Extract numeric price from price string
 * @param {string} priceStr - e.g., "Starting at ₹5,000/night"
 * @returns {number|null}
 */
function extractNumericPrice(priceStr) {
  if (!priceStr) return null;
  const match = priceStr.match(/[\d,]+/);
  if (match) {
    return parseInt(match[0].replace(/,/g, ''), 10);
  }
  return null;
}

/**
 * Format review count for display
 * @param {string|number} count - e.g., "2.8k" or 2800
 * @returns {string|null}
 */
function formatReviewCount(count) {
  if (!count) return null;
  if (typeof count === 'number') {
    if (count >= 1000) {
      return `${(count / 1000).toFixed(1)}k`;
    }
    return count.toString();
  }
  return count.toString();
}

/**
 * Extract amenities from card description or data
 * @param {Object} card 
 * @returns {Array<string>}
 */
function extractAmenities(card) {
  const amenities = [];
  const description = (card.description || '').toLowerCase();
  const title = (card.title || '').toLowerCase();

  const amenityKeywords = [
    'pool', 'swimming pool', 'spa', 'gym', 'wifi', 'free wifi',
    'parking', 'restaurant', 'bar', 'beach', 'lake view', 'mountain view',
    'breakfast', 'airport shuttle', 'pet-friendly', 'rooftop'
  ];

  amenityKeywords.forEach(keyword => {
    if (description.includes(keyword) || title.includes(keyword)) {
      // Capitalize first letter
      amenities.push(keyword.charAt(0).toUpperCase() + keyword.slice(1));
    }
  });

  return [...new Set(amenities)]; // Remove duplicates
}

/**
 * Generate comparison for travel options
 * @param {string} userQuery - User's original query
 * @param {Object} myraResponse - Response data from Myra
 * @param {Object} session - User session for context
 * @returns {Promise<string|null>}
 */
async function generateComparison(userQuery, myraResponse, session = {}) {
  // Check if comparison is applicable
  if (!shouldGenerateComparison(myraResponse)) {
    return null;
  }

  // Check if Gemini client is ready
  if (!geminiClient.isReady()) {
    logger.warn('Gemini client not ready, skipping comparison');
    return null;
  }

  try {
    logger.info('🔄 Generating comparison...', {
      optionCount: myraResponse.hotelCards?.length,
      userQuery: userQuery.substring(0, 50),
    });

    // Extract comparison options
    const options = extractComparisonOptions(myraResponse);

    // Build conversation history for context
    const conversationHistory = [];
    if (session.lastQuery && session.lastQuery !== userQuery) {
      conversationHistory.push(`Previous query: "${session.lastQuery}"`);
    }

    // Build prompt
    const comparisonData = {
      userQuery,
      conversationHistory,
      options,
    };

    const prompt = buildComparisonPrompt(comparisonData);

    // Generate comparison
    const comparison = await geminiClient.generate(prompt, COMPARISON_SYSTEM_PROMPT);

    if (!comparison) {
      logger.warn('Comparison generation returned null');
      return null;
    }

    // Validate and clean output
    const cleanedComparison = cleanComparisonOutput(comparison);

    logger.info('✅ Comparison generated', {
      length: cleanedComparison.length,
    });

    return cleanedComparison;
  } catch (error) {
    logger.error('Failed to generate comparison', {
      error: error.message,
      stack: error.stack,
    });
    return null;
  }
}

/**
 * Clean and validate comparison output
 * @param {string} comparison - Raw comparison from Gemini
 * @returns {string}
 */
function cleanComparisonOutput(comparison) {
  let cleaned = comparison.trim();

  // Replace ** with * for WhatsApp bold
  cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, '*$1*');

  // Ensure no double asterisks remain
  cleaned = cleaned.replace(/\*\*/g, '*');

  // Truncate if too long (WhatsApp has ~65k char limit, but we want it short)
  if (cleaned.length > 600) {
    // Find last complete sentence before 600 chars
    const truncated = cleaned.substring(0, 600);
    const lastPeriod = truncated.lastIndexOf('.');
    const lastNewline = truncated.lastIndexOf('\n');
    const cutPoint = Math.max(lastPeriod, lastNewline);
    
    if (cutPoint > 300) {
      cleaned = cleaned.substring(0, cutPoint + 1);
    } else {
      cleaned = truncated + '...';
    }
  }

  return cleaned;
}

module.exports = {
  generateComparison,
  shouldGenerateComparison,
  extractComparisonOptions,
};
