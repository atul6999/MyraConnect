/**
 * Travel Content Filter
 * Uses Gemini to check if user's query is travel-related (MakeMyTrip domain)
 */

const geminiClient = require('./geminiClient');
const logger = require('../utils/logger');

/**
 * System prompt for travel content detection
 */
const TRAVEL_FILTER_SYSTEM_PROMPT = `You are a content classifier for MakeMyTrip travel assistant. Your job is to determine if a user's question is related to travel, tourism, or hospitality services that MakeMyTrip provides.

## MakeMyTrip Services (TRAVEL-RELATED):
- Hotels, resorts, homestays, accommodations, bookings
- Flights, airlines, airports, air travel, flight bookings
- Buses, trains, transport booking, cab services
- Travel packages, tours, itineraries, holiday packages
- Travel destinations, cities, tourist places, places to visit
- Travel dates, bookings, reservations, cancellations
- Travel-related questions, trip planning, vacation planning
- Hotel amenities, room types, check-in/check-out
- Flight schedules, routes, prices
- Travel deals, offers, discounts

## NON-TRAVEL Content (NOT MakeMyTrip domain):
- General greetings ("hello", "how are you", "hi")
- Small talk, casual conversation
- Technical support questions
- Off-topic questions (weather, news, sports, general knowledge)
- Questions about the chatbot itself ("who are you", "what can you do")
- Non-travel products or services
- Personal questions unrelated to travel

## Your Task:
Analyze the user's question and determine if it's travel-related (MakeMyTrip domain). Return ONLY a valid JSON object:

{
  "isTravelRelated": true/false,
  "confidence": 0.0-1.0,
  "reason": "brief explanation"
}

Be strict - only mark as travel-related if it's clearly about travel, tourism, or hospitality services.`;

/**
 * Quick keyword-based check (faster, no API call)
 * Use this as a first pass before calling Gemini
 * @param {string} userQuery
 * @returns {boolean}
 */
function quickTravelCheck(userQuery) {
  if (!userQuery || typeof userQuery !== 'string') {
    return false;
  }

  const query = userQuery.toLowerCase().trim();
  
  // Very short queries are likely greetings
  if (query.length < 10) {
    const greetings = ['hi', 'hello', 'hey', 'hii', 'hiii', 'hola', 'namaste'];
    if (greetings.some(g => query === g || query.startsWith(g + ' '))) {
      return false;
    }
  }

  // Travel keywords
  const travelKeywords = [
    'hotel', 'flight', 'bus', 'train', 'travel', 'booking', 'reservation',
    'destination', 'trip', 'vacation', 'tour', 'itinerary', 'package',
    'accommodation', 'resort', 'homestay', 'airport', 'airline',
    'check-in', 'check-out', 'checkin', 'checkout', 'stay', 'journey',
    'visit', 'tourist', 'tourism', 'holiday', 'book', 'cancel',
    'amenities', 'room', 'suite', 'price', 'fare', 'route', 'schedule',
    'jaipur', 'mumbai', 'delhi', 'goa', 'kerala', 'city', 'place',
    'makemytrip', 'mmt', 'deals', 'offers', 'discount'
  ];

  // Check if query contains travel keywords
  const hasTravelKeyword = travelKeywords.some(keyword => query.includes(keyword));
  
  // Check for common non-travel patterns
  const nonTravelPatterns = [
    /^how are you/i,
    /^who are you/i,
    /^what are you/i,
    /^what can you do/i,
    /^tell me about yourself/i,
    /^what's the weather/i,
    /^what time is it/i,
    /^what date is it/i
  ];

  const isNonTravelPattern = nonTravelPatterns.some(pattern => pattern.test(query));
  
  if (isNonTravelPattern) {
    return false;
  }

  return hasTravelKeyword;
}

/**
 * Check if user's query is travel-related using Gemini
 * @param {string} userQuery - User's question/query
 * @returns {Promise<{isTravelRelated: boolean, confidence: number, reason: string}|null>}
 */
async function checkIfTravelRelated(userQuery) {
  if (!userQuery || typeof userQuery !== 'string' || userQuery.trim().length === 0) {
    return {
      isTravelRelated: false,
      confidence: 0.0,
      reason: 'Empty or invalid query'
    };
  }

  // Quick check first (faster, no API call)
  const quickResult = quickTravelCheck(userQuery);
  if (!quickResult) {
    // If quick check says non-travel, verify with Gemini for accuracy
    // But if quick check says travel, we can trust it
    logger.debug('Quick check: Non-travel query detected', { query: userQuery.substring(0, 50) });
  } else {
    logger.debug('Quick check: Travel-related query detected', { query: userQuery.substring(0, 50) });
    // For travel queries, we can trust quick check to save API calls
    return {
      isTravelRelated: true,
      confidence: 0.9,
      reason: 'Contains travel-related keywords'
    };
  }

  // If Gemini is not ready, use quick check result
  if (!geminiClient.isReady()) {
    logger.warn('Gemini client not ready, using quick check result');
    return {
      isTravelRelated: quickResult,
      confidence: quickResult ? 0.7 : 0.6,
      reason: 'Quick check (Gemini not available)'
    };
  }

  try {
    // Build prompt for Gemini
    const prompt = `Analyze this user question and determine if it's travel-related (MakeMyTrip domain):

"${userQuery}"

Return ONLY a valid JSON object with isTravelRelated (boolean), confidence (0.0-1.0), and reason (string).`;

    logger.info('🔍 [GEMINI] Checking if query is travel-related...', {
      queryLength: userQuery.length,
      queryPreview: userQuery.substring(0, 100),
      source: 'GEMINI_FILTER'
    });

    // Call Gemini
    const result = await geminiClient.generate(prompt, TRAVEL_FILTER_SYSTEM_PROMPT);
    
    if (!result) {
      logger.warn('Travel filter: Gemini returned null, using quick check');
      return {
        isTravelRelated: quickResult,
        confidence: quickResult ? 0.7 : 0.6,
        reason: 'Quick check (Gemini returned null)'
      };
    }

    // Parse JSON response
    let filterResult;
    try {
      // Try to extract JSON from response (in case Gemini adds extra text)
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        filterResult = JSON.parse(jsonMatch[0]);
      } else {
        filterResult = JSON.parse(result);
      }
    } catch (parseError) {
      logger.error('Travel filter: Failed to parse Gemini response', {
        error: parseError.message,
        rawResponse: result.substring(0, 200)
      });
      // Fallback to quick check
      return {
        isTravelRelated: quickResult,
        confidence: quickResult ? 0.7 : 0.6,
        reason: 'Quick check (failed to parse Gemini response)'
      };
    }

    // Validate result structure
    if (typeof filterResult.isTravelRelated !== 'boolean') {
      logger.warn('Travel filter: Invalid response structure, using quick check', { filterResult });
      return {
        isTravelRelated: quickResult,
        confidence: quickResult ? 0.7 : 0.6,
        reason: 'Quick check (invalid Gemini response)'
      };
    }

    logger.info('✅ [GEMINI] Travel filter result', {
      isTravelRelated: filterResult.isTravelRelated,
      confidence: filterResult.confidence,
      reason: filterResult.reason,
      queryPreview: userQuery.substring(0, 50),
      source: 'GEMINI_FILTER',
      routingTo: filterResult.isTravelRelated ? 'MYRA' : 'GEMINI'
    });

    return {
      isTravelRelated: filterResult.isTravelRelated,
      confidence: filterResult.confidence || 0.5,
      reason: filterResult.reason || 'Analyzed by Gemini'
    };

  } catch (error) {
    logger.error('Failed to check travel content with Gemini', {
      error: error.message,
      stack: error.stack
    });
    // Fallback to quick check
    return {
      isTravelRelated: quickResult,
      confidence: quickResult ? 0.7 : 0.6,
      reason: 'Quick check (Gemini error)'
    };
  }
}

module.exports = {
  checkIfTravelRelated,
  quickTravelCheck,
  TRAVEL_FILTER_SYSTEM_PROMPT
};
