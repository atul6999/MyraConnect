/**
 * Message Orchestrator
 * Main coordinator for message processing flow
 */

const logger = require('../utils/logger');
const SessionManager = require('../session/SessionManager');
const MemoryStore = require('../session/MemoryStore');
const myraClient = require('../myra/wsClient');
const whatsappClient = require('../whatsapp/client');
const { renderResponse, renderCarouselItem } = require('../whatsapp/renderer');
const { applyGuardrails, checkButtonAction } = require('./guardrails');
const carousel = require('./carousel');
const booking = require('./booking');
const genai = require('../genai');
const travelFilter = require('../genai/travelFilter');
const responseGenerator = require('../genai/responseGenerator');

// Initialize session manager
const sessionManager = new SessionManager(new MemoryStore());

/**
 * Process incoming message
 * @param {Object} normalizedMessage - Normalized WhatsApp message
 */
async function processMessage(normalizedMessage) {
  const { userId, type, text, buttonId, listId, messageId } = normalizedMessage;
  
  logger.info('🎯 Orchestrator: processMessage called', { 
    userId, 
    type, 
    text: text?.substring(0, 50),
    hasButtonId: !!buttonId,
    hasListId: !!listId
  });
  
  try {
    // Load or create session
    let session = await sessionManager.get(userId) || {
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    logger.info('📋 Processing message', { 
      userId, 
      type, 
      hasSession: !!session.conversationId,
      sessionKeys: Object.keys(session)
    });

    // Check if booking is in progress
    if (booking.hasActiveBooking(session)) {
      session = await booking.processBookingStep(userId, session, normalizedMessage);
      await sessionManager.set(userId, session);
      return;
    }

    // Handle button/list interactions
    if (type === 'button' || type === 'list') {
      session = await handleInteraction(userId, session, buttonId || listId, normalizedMessage);
      await sessionManager.set(userId, session);
      return;
    }

    // Handle text message
    if (type === 'text' && text) {
      session = await handleTextMessage(userId, session, text, messageId);
      await sessionManager.set(userId, session);
      return;
    }

    logger.warn('Unhandled message type', { type });
    
  } catch (error) {
        logger.error('Error processing message', { 
      error: error.message, 
      stack: error.stack,
      errorCode: error.code,
      isRecipientNotAllowed: error.isRecipientNotAllowed,
      isTokenError: error.isTokenError,
      isPhoneNumberIdError: error.isPhoneNumberIdError
    });
    
    // Don't send error messages for token errors, phone number ID errors, or recipient not allowed errors
    // (to prevent infinite loops when error messages also fail)
    if (error.isTokenError) {
      // For token errors, just log - don't try to send message (it will fail anyway)
      logger.warn('Cannot send error message - access token expired/invalid', {
        errorCode: error.code,
        originalMessage: error.originalMessage
      });
    } else if (error.isPhoneNumberIdError) {
      // For phone number ID errors, just log - don't try to send message (it will fail anyway)
      logger.warn('Cannot send error message - phone number ID invalid or inaccessible', {
        errorCode: error.code,
        originalMessage: error.originalMessage
      });
    } else if (error.isRecipientNotAllowed) {
      // For recipient not allowed errors, just log - don't try to send message
      logger.warn('Cannot send error message - recipient not in allowed list', {
        phoneNumber: error.phoneNumber,
        normalizedPhoneNumber: error.normalizedPhoneNumber
      });
    } else {
      // For other errors, try to send error message
      // Note: Processing message was already sent, so user will see that followed by error message
      try {
        await whatsappClient.sendText(userId, 
          "I'm sorry, I encountered an issue. Please try again in a moment."
        );
      } catch (sendError) {
        // If sending error message fails, log but don't throw
        // This prevents cascading failures
        logger.error('Failed to send error message', { 
          error: sendError.message,
          originalError: error.message,
          // Don't try to send another error message if this fails
          isRecipientNotAllowed: sendError.isRecipientNotAllowed,
          isTokenError: sendError.isTokenError,
          isPhoneNumberIdError: sendError.isPhoneNumberIdError
        });
      }
    }
  }
}

/**
 * Handle text message
 * @param {string} userId
 * @param {Object} session
 * @param {string} text
 * @returns {Promise<Object>} Updated session
 */
async function handleTextMessage(userId, session, text, messageId = null) {
  let myraResponse;
  let processingMessageSent = false;

  // Check if query is travel-related BEFORE sending to Myra
  logger.info('🔍 [ROUTING] Checking if query is travel-related...', { 
    userId, 
    queryPreview: text.substring(0, 50) 
  });
  
  const travelCheck = await travelFilter.checkIfTravelRelated(text);
  
  if (travelCheck && !travelCheck.isTravelRelated) {
    // Non-travel query - use Gemini to generate response
    logger.info('🤖 [GEMINI] Non-travel query detected - Routing to Gemini AI', {
      userId,
      query: text.substring(0, 100),
      confidence: travelCheck.confidence,
      reason: travelCheck.reason,
      source: 'GEMINI'
    });
    
    try {
      // Generate response with Gemini
      logger.info('🤖 [GEMINI] Generating response...', { userId, queryPreview: text.substring(0, 50) });
      const geminiResponse = await responseGenerator.generateGeneralResponse(text, session);
      
      if (geminiResponse) {
        await whatsappClient.sendText(userId, geminiResponse);
        logger.info('✅ [GEMINI] Response sent to user', { 
          userId,
          responseLength: geminiResponse.length,
          responsePreview: geminiResponse.substring(0, 100),
          source: 'GEMINI'
        });
      } else {
        // Fallback if Gemini fails
        logger.warn('⚠️ [GEMINI] Response generation returned null, using fallback', { userId });
        const fallbackResponse = responseGenerator.generateFallbackResponse(text);
        await whatsappClient.sendText(userId, fallbackResponse);
        logger.info('✅ [GEMINI] Fallback response sent to user', { 
          userId,
          source: 'GEMINI_FALLBACK'
        });
      }
      
      // Update session (don't create Myra conversation for non-travel queries)
      session.updatedAt = Date.now();
      session.lastQuery = text;
      logger.info('📝 [GEMINI] Session updated (no Myra conversation created)', { userId });
      return session;
      
    } catch (error) {
      logger.error('❌ [GEMINI] Error generating response, falling back to Myra', {
        userId,
        error: error.message,
        stack: error.stack,
        source: 'GEMINI_ERROR'
      });
      // Fall through to Myra as backup
      logger.info('🔄 [MYRA] Falling back to Myra due to Gemini error', { userId });
    }
  } else {
    // Travel-related query - proceed with Myra
    logger.info('✈️ [MYRA] Travel-related query detected - Routing to Myra AI', {
      userId,
      query: text.substring(0, 100),
      confidence: travelCheck?.confidence || 'N/A',
      reason: travelCheck?.reason || 'Quick check',
      source: 'MYRA'
    });
  }

  // Send a quick "Processing..." message to show user that response is coming
  // This provides visual feedback since typing indicators aren't supported
  try {
    await whatsappClient.sendText(userId, '⏳ Processing your request...');
    processingMessageSent = true;
    logger.info('⏳ [MYRA] Sent processing message', { userId, messageId, source: 'MYRA' });
  } catch (error) {
    // Non-critical, continue processing even if this fails
    logger.debug('⚠️ [MYRA] Failed to send processing message (non-critical)', { error: error.message });
  }

  // Ensure WebSocket is connected
  if (!myraClient.isConnected) {
    logger.info('🔌 [MYRA] Connecting to Myra WebSocket...', { userId });
    await myraClient.connect();
  }

  // Send to Myra AI
  if (!session.conversationId) {
    // New conversation
    logger.info('🆕 [MYRA] Creating new Myra conversation', { 
      userId,
      userMessage: text.substring(0, 100),
      source: 'MYRA'
    });
    try {
      logger.info('⏳ [MYRA] Waiting for Myra response (newChat)...', { userId });
      myraResponse = await myraClient.newChat(text);
      logger.info('✅ [MYRA] newChat response received', { 
        userId,
        hasData: !!myraResponse,
        hasDataData: !!myraResponse?.data,
        conversationId: myraResponse?.data?.conversationId,
        eventType: myraResponse?.eventType,
        responseKeys: myraResponse ? Object.keys(myraResponse) : [],
        source: 'MYRA'
      });
    } catch (error) {
      logger.error('❌ [MYRA] Error getting Myra response (newChat)', { 
        userId,
        error: error.message,
        stack: error.stack,
        errorType: error.constructor.name,
        source: 'MYRA_ERROR'
      });
      throw error;
    }
    
    // Extract conversation ID from NEW_CHAT_CREATED or NEW_MESSAGE
    if (myraResponse.data?.conversationId) {
      session.conversationId = myraResponse.data.conversationId;
      logger.info('💾 [MYRA] Conversation ID saved to session', { 
        userId,
        conversationId: session.conversationId,
        source: 'MYRA'
      });
    }
  } else {
    // Existing conversation
    logger.info('💬 [MYRA] Sending message to existing Myra conversation', { 
      userId,
      conversationId: session.conversationId,
      userMessage: text.substring(0, 100),
      source: 'MYRA'
    });
    try {
      logger.info('⏳ [MYRA] Waiting for Myra response (postMessage)...', { userId });
      myraResponse = await myraClient.postMessage(session.conversationId, text);
      logger.info('✅ [MYRA] postMessage response received', { 
        userId,
        hasData: !!myraResponse,
        hasDataData: !!myraResponse?.data,
        conversationId: myraResponse?.data?.conversationId,
        eventType: myraResponse?.eventType,
        source: 'MYRA'
      });
    } catch (error) {
      logger.error('❌ [MYRA] Error getting Myra response (postMessage)', { 
        userId,
        error: error.message,
        stack: error.stack,
        source: 'MYRA_ERROR'
      });
      throw error;
    }
  }

  // Extract response content
  const responseData = extractResponseData(myraResponse);
  
  // Log Myra's response for debugging
  logger.info('📥 [MYRA] Response data extracted', {
    userId,
    conversationId: responseData.conversationId,
    text: responseData.text?.substring(0, 100),
    hasItems: !!responseData.items,
    itemCount: responseData.items?.length || 0,
    hasSuggestions: !!responseData.suggestions,
    suggestionCount: responseData.suggestions?.length || 0,
    hasHotelCards: !!responseData.hotelCards,
    hotelCardCount: responseData.hotelCards?.length || 0,
    eventType: myraResponse?.eventType,
    hasLeadingQuestion: !!myraResponse?.data?.leadingQuestion,
    source: 'MYRA'
  });
  
  // Warn if we got NEW_CHAT_CREATED instead of NEW_MESSAGE (shouldn't happen now, but good to check)
  if (myraResponse?.eventType === 'NEW_CHAT_CREATED' && !myraResponse?.data?.leadingQuestion) {
    logger.warn('⚠️ [MYRA] Received NEW_CHAT_CREATED but no assistant reply yet. This might indicate NEW_MESSAGE is coming separately.', { userId });
  }
  
  // Apply guardrails
  logger.info('🛡️ [MYRA] Applying guardrails to response', { userId });
  const guardrailResult = applyGuardrails(responseData, session);
  
  switch (guardrailResult.action) {
    case 'clarify':
      logger.info('💬 [MYRA] Guardrail: Clarification needed', { userId });
      await whatsappClient.sendText(userId, guardrailResult.message);
      break;
      
    case 'escalate':
      logger.info('📞 [MYRA] Guardrail: Escalation triggered', { userId });
      await whatsappClient.sendText(userId, guardrailResult.message);
      // Could add escalation tracking here
      break;
      
    case 'book':
      logger.info('📅 [MYRA] Guardrail: Booking flow initiated', { userId });
      // Extract item and start booking
      if (guardrailResult.data?.itemId && session.carousel) {
        const item = carousel.getItemById(session, guardrailResult.data.itemId);
        if (item) {
          session = carousel.clearCarousel(session);
          session = booking.startBooking(session, item);
          await booking.processBookingStep(userId, session, { buttonId: 'confirm_prompt' });
        }
      }
      break;
      
    case 'normal':
    default:
      // Render response
      logger.info('🎨 [MYRA] Rendering response to WhatsApp', { userId });
      const renderResult = await renderResponse(userId, responseData);
      
      // Store product cards in session for button click handling
      // Only store essential data to minimize session size
      if (responseData.hotelCards && responseData.hotelCards.length > 0) {
        session.hotelCards = responseData.hotelCards.map(product => ({
          id: product.id,
          title: product.title,
          bookingLink: product.bookingLink,
          productType: product.productType
          // Only store minimal data needed for button clicks
        }));
        logger.info('💾 [MYRA] Stored product cards in session', { 
          userId,
          count: responseData.hotelCards.length,
          productTypes: [...new Set(responseData.hotelCards.map(p => p.productType))],
          storedSize: JSON.stringify(session.hotelCards).length,
          source: 'MYRA'
        });
      }
      
      // Check if carousel should be initialized
      if (renderResult?.initCarousel && renderResult.items) {
        session = carousel.initCarousel(session, renderResult.items);
        const current = carousel.getCurrentItem(session);
        if (current) {
          await renderCarouselItem(userId, current.item, current.meta);
        }
      }
      
      // Generate AI comparison for multiple options
      try {
        logger.info('🔄 [GEMINI] Generating comparison for travel options', { userId });
        const comparison = await genai.generateComparison(text, responseData, session);
        if (comparison) {
          // Small delay so comparison comes after product cards
          await new Promise(resolve => setTimeout(resolve, 800));
          await whatsappClient.sendText(userId, comparison);
          logger.info('✅ [GEMINI] Comparison sent to user', { 
            userId,
            comparisonLength: comparison.length,
            source: 'GEMINI_COMPARISON'
          });
        }
      } catch (comparisonError) {
        // Non-critical - log but don't fail the response
        logger.error('❌ [GEMINI] Failed to generate comparison', { 
          userId,
          error: comparisonError.message,
          source: 'GEMINI_COMPARISON_ERROR'
        });
      }
      
      // Store last query for context in future comparisons
      session.lastQuery = text;
      logger.info('✅ [MYRA] Response processing complete', { userId, source: 'MYRA' });
      break;
  }

  session.updatedAt = Date.now();
  return session;
}

/**
 * Handle button/list interaction
 * @param {string} userId
 * @param {Object} session
 * @param {string} interactionId
 * @param {Object} message
 * @returns {Promise<Object>} Updated session
 */
async function handleInteraction(userId, session, interactionId, message) {
  const action = checkButtonAction(interactionId);
  
  if (!action) {
    // Treat as regular text message
    return handleTextMessage(userId, session, message.buttonText || message.listTitle || interactionId);
  }

  switch (action.type) {
    case 'carousel':
      if (!carousel.hasActiveCarousel(session)) {
        await whatsappClient.sendText(userId, "No items to navigate. Try searching for something!");
        return session;
      }
      
      // Navigate carousel
      if (action.direction === 'next') {
        session = carousel.nextItem(session);
      } else {
        session = carousel.prevItem(session);
      }
      
      // Show current item
      const current = carousel.getCurrentItem(session);
      if (current) {
        await renderCarouselItem(userId, current.item, current.meta);
      }
      break;

    case 'select':
      // Item selected from carousel
      const selectedItem = carousel.getItemById(session, action.itemId);
      if (selectedItem) {
        session = carousel.clearCarousel(session);
        session = booking.startBooking(session, selectedItem);
        
        // Prompt for confirmation
        await whatsappClient.sendButtons(userId,
          `You selected:\n\n*${selectedItem.title}*\n${selectedItem.subtitle || ''}\n💰 ${selectedItem.price || 'Price on request'}\n\nWould you like to proceed with booking?`,
          [
            { id: 'confirm_yes', title: '✅ Yes, Book' },
            { id: 'confirm_no', title: '❌ No, Cancel' }
          ]
        );
      }
      break;

    case 'suggestion':
      // User clicked a suggestion - send it as a message
      if (session.lastSuggestions && session.lastSuggestions[action.index]) {
        const suggestionText = session.lastSuggestions[action.index];
        return handleTextMessage(userId, session, suggestionText);
      }
      break;

    case 'action':
      // Handle custom action
      logger.info('Custom action triggered', { action: action.action, payload: action.payload });
      // Could extend this to handle various actions
      break;

    case 'viewHotel':
      // User clicked "View Details" button - send booking URL
      if (session.hotelCards && Array.isArray(session.hotelCards)) {
        const product = session.hotelCards.find(p => p.id === action.hotelId);
        if (product && product.bookingLink) {
          const productTypeLabel = product.productType === 'hotel' ? 'Hotel' :
                                   product.productType === 'flight' ? 'Flight' :
                                   product.productType === 'bus' ? 'Bus' :
                                   'Product';
          await whatsappClient.sendText(userId, 
            `🔗 *${product.title}*\n\nBook now on MakeMyTrip:\n${product.bookingLink}`
          );
        } else {
          await whatsappClient.sendText(userId, 
            'Sorry, booking link not available for this item.'
          );
        }
      } else {
        await whatsappClient.sendText(userId, 
          'Sorry, product information is no longer available. Please search again.'
        );
      }
      break;

    case 'bookNow':
      // User clicked "Book Now" button - send booking URL
      if (session.hotelCards && Array.isArray(session.hotelCards)) {
        // Try to find product by ID (productId could be the actual ID or index)
        let product = session.hotelCards.find(p => p.id === action.productId);
        
        // If not found by ID, try by index (in case productId is the index)
        if (!product) {
          const index = parseInt(action.productId, 10);
          if (!isNaN(index) && index > 0 && index <= session.hotelCards.length) {
            product = session.hotelCards[index - 1];
          }
        }
        
        if (product && product.bookingLink) {
          const productTypeLabel = product.productType === 'hotel' ? 'Hotel' :
                                   product.productType === 'flight' ? 'Flight' :
                                   product.productType === 'bus' ? 'Bus' :
                                   product.productType === 'package' ? 'Package' :
                                   'Product';
          await whatsappClient.sendText(userId, 
            `🔗 *${product.title || productTypeLabel}*\n\n📅 Book now on MakeMyTrip:\n${product.bookingLink}\n\nClick the link above to proceed with your booking!`
          );
        } else {
          await whatsappClient.sendText(userId, 
            'Sorry, booking link not available for this item.'
          );
        }
      } else {
        await whatsappClient.sendText(userId, 
          'Sorry, product information is no longer available. Please search again.'
        );
      }
      break;
  }

  session.updatedAt = Date.now();
  return session;
}

/**
 * Extract useful data from Myra response
 * @param {Object} myraResponse
 * @returns {Object}
 */
function extractResponseData(myraResponse) {
  const data = myraResponse.data || myraResponse;
  
  // Priority order for extracting text:
  // 1. leadingQuestion (from NEW_MESSAGE with ASSISTANT_REPLY) - this is the actual assistant response
  // 2. message.content[0].value (if it's from ASSISTANT role)
  // 3. message.content[0].value (fallback, but might be user's message echo)
  
  let text = null;
  let hotelCards = [];
  
  // Extract text from message content
  if (data.leadingQuestion) {
    text = data.leadingQuestion;
  } 
  // Check if message is from ASSISTANT role
  else if (data.message?.role === 'ASSISTANT' && data.message?.content?.[0]?.value) {
    text = data.message.content[0].value;
  }
  // Fallback to content value (but warn if it's USER role)
  else if (data.message?.content?.[0]?.value) {
    if (data.message?.role === 'USER') {
      logger.warn('⚠️ Extracted text from USER message - might be echo, not assistant reply');
    }
    text = data.message.content[0].value;
  }
  
  // Extract CARD content from message.content array
  if (data.message?.content) {
    for (const contentItem of data.message.content) {
      if (contentItem.type === 'CARD' && contentItem.value?.templateInfo?.payload) {
        // Extract product cards from CARD payload (hotels, flights, buses, packages, etc.)
        hotelCards = extractProductCards(contentItem.value.templateInfo.payload);
        logger.info('Extracted product cards from CARD content', { 
          cardCount: hotelCards.length,
          cardTypes: [...new Set(hotelCards.map(c => c.productType))]
        });
      }
    }
  }
  
  return {
    conversationId: data.conversationId,
    text: text,
    suggestions: data.suggestions || [],
    message: data.message,
    hotelCards: hotelCards, // Generic name but contains all product types
    // These would come from enhanced Myra responses
    items: data.items,
    actions: data.actions,
    confidence: data.confidence,
    eventType: myraResponse.eventType,
    dataEventType: data.eventType // For ASSISTANT_REPLY, etc.
  };
}

/**
 * Extract product cards from CARD payload (hotels, flights, buses, packages, etc.)
 * @param {Array} payload - Array of card objects from Myra
 * @returns {Array} Array of formatted product objects
 */
function extractProductCards(payload) {
  if (!Array.isArray(payload)) {
    return [];
  }
  
  return payload
    .filter(card => card.data && (card.type === 'detailed-card' || card.type === 'transport-card' || card.type === 'package-card' || card.type === 'itinerary-card'))
    .map(card => {
      const cardData = card.data;
      const cardType = card.type;
      
      // Handle different card types
      if (cardType === 'detailed-card') {
        // Hotels
        return {
          id: cardData.id || card.id,
          title: cardData.title || 'Hotel',
          subtitle: cardData.sub_title || '',
          price: cardData.cta_title || '',
          image: cardData.image_url || null,
          rating: cardData.info?.text || null,
          ratingCount: cardData.info?.sub_text || null,
          location: cardData.sub_title || '',
          bookingLink: cardData.cta_link || null,
          description: cardData.description || null,
          productType: 'hotel',
          lob: cardData.lob || 'HTL'
        };
      } else if (cardType === 'transport-card') {
        // Flights, Buses, Trains
        const lob = cardData.lob || 'FLT';
        const productType = lob === 'FLT' ? 'flight' : lob === 'BUS' ? 'bus' : 'transport';
        
        return {
          id: cardData.id || card.id,
          title: cardData.title || `${cardData.fare_info_text || ''} ${cardData.fare_amount_text || ''}`.trim() || 'Transport',
          subtitle: cardData.sub_title || '', // Time and duration for flights
          price: cardData.fare_amount_text || cardData.cta_title || '',
          image: cardData.image_url || null,
          rating: cardData.rating || null,
          ratingCount: cardData.total_rating_count || null,
          location: cardData.sub_title || '', // Route info
          bookingLink: cardData.cta_link || null,
          description: cardData.card_text || cardData.description || null,
          productType: productType,
          lob: lob,
          // Flight/Bus specific fields
          fareAmount: cardData.fare_amount || null,
          fareInfoText: cardData.fare_info_text || null,
          departureTime: cardData.sub_title?.split('-')[0]?.trim() || null,
          arrivalTime: cardData.sub_title?.split('-')[1]?.split('|')[0]?.trim() || null,
          duration: cardData.sub_title?.split('|')[1]?.trim() || null
        };
      } else {
        // Generic card type (packages, itineraries, etc.)
        return {
          id: cardData.id || card.id,
          title: cardData.title || 'Product',
          subtitle: cardData.sub_title || '',
          price: cardData.cta_title || cardData.fare_amount_text || '',
          image: cardData.image_url || null,
          rating: cardData.rating || cardData.info?.text || null,
          ratingCount: cardData.total_rating_count || cardData.info?.sub_text || null,
          location: cardData.sub_title || '',
          bookingLink: cardData.cta_link || null,
          description: cardData.card_text || cardData.description || null,
          productType: cardType.replace('-card', ''),
          lob: cardData.lob || 'COMMONS'
        };
      }
    });
}

module.exports = {
  processMessage,
  sessionManager
};
