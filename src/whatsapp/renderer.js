/**
 * WhatsApp Message Renderer
 * Converts Myra AI responses to WhatsApp message format
 */

const whatsappClient = require('./client');
const logger = require('../utils/logger');

/**
 * Render Myra AI response to WhatsApp messages
 * @param {string} to - Recipient phone number
 * @param {Object} myraResponse - Response from Myra AI
 * @param {Object} [carouselItem] - Current carousel item if in carousel mode
 * @param {Object} [carouselMeta] - Carousel metadata (index, total)
 * @returns {Promise<void>}
 */
async function renderResponse(to, myraResponse, carouselItem = null, carouselMeta = null) {
  try {
    // If we have a carousel item, render it
    if (carouselItem && carouselMeta) {
      await renderCarouselItem(to, carouselItem, carouselMeta);
      return;
    }

    // Handle product cards with images (hotels, flights, buses, packages, etc.)
    // Priority - most visual content
    if (myraResponse.hotelCards && myraResponse.hotelCards.length > 0) {
      await renderHotelCards(to, myraResponse.hotelCards, myraResponse.text);
      // Render suggestions after products if available
      if (myraResponse.suggestions && myraResponse.suggestions.length > 0) {
        await renderSuggestions(to, myraResponse.suggestions);
      }
      return;
    }

    // Send intro text if present (make it concise)
    if (myraResponse.text || myraResponse.leadingQuestion) {
      const text = formatTextMessage(myraResponse.text || myraResponse.leadingQuestion);
      await whatsappClient.sendText(to, text);
    }

    // Handle items array (potential carousel)
    if (myraResponse.items && myraResponse.items.length > 0) {
      // If many items, use list view
      if (myraResponse.items.length > 5) {
        await renderItemsAsList(to, myraResponse.items);
      } else {
        // Return items for carousel initialization (handled by orchestrator)
        return { initCarousel: true, items: myraResponse.items };
      }
    }

    // Handle standalone actions as buttons
    if (myraResponse.actions && myraResponse.actions.length > 0 && !myraResponse.items) {
      await renderActionsAsButtons(to, myraResponse.actions);
    }

    // Handle suggestions array
    if (myraResponse.suggestions && myraResponse.suggestions.length > 0) {
      await renderSuggestions(to, myraResponse.suggestions);
    }

  } catch (error) {
    logger.error('Error rendering response', { 
      error: error.message,
      errorCode: error.code,
      isRecipientNotAllowed: error.isRecipientNotAllowed,
      phoneNumber: error.phoneNumber
    });
    throw error;
  }
}

/**
 * Render a single carousel item with navigation buttons
 * @param {string} to - Recipient phone number
 * @param {Object} item - Carousel item
 * @param {Object} meta - { index, total }
 */
async function renderCarouselItem(to, item, meta) {
  const { index, total } = meta;
  
  // Build caption
  const caption = buildItemCaption(item, index, total);
  
  // Build navigation buttons
  const buttons = [];
  
  // Previous button (if not first item)
  if (index > 0) {
    buttons.push({ id: 'carousel_prev', title: '◀️ Previous' });
  }
  
  // Book/Select button
  buttons.push({ id: `select_${item.id}`, title: '📅 Book' });
  
  // Next button (if not last item)
  if (index < total - 1) {
    buttons.push({ id: 'carousel_next', title: 'Next ▶️' });
  }
  
  // Send image with buttons if image exists
  if (item.image) {
    await whatsappClient.sendImageWithButtons(to, item.image, caption, buttons);
  } else {
    // Fallback to text with buttons
    await whatsappClient.sendButtons(to, caption, buttons);
  }
}

/**
 * Build caption for carousel item
 * @param {Object} item
 * @param {number} index
 * @param {number} total
 * @returns {string}
 */
function buildItemCaption(item, index, total) {
  const parts = [];
  
  // Progress indicator
  parts.push(`📍 ${index + 1} of ${total}`);
  parts.push('');
  
  // Title
  if (item.title) {
    parts.push(`*${item.title}*`);
  }
  
  // Subtitle
  if (item.subtitle) {
    parts.push(item.subtitle);
  }
  
  // Price
  if (item.price) {
    parts.push(`💰 ${item.price}`);
  }
  
  // Rating
  if (item.rating) {
    parts.push(`⭐ ${item.rating}`);
  }
  
  return parts.join('\n');
}

/**
 * Render items as WhatsApp list
 * @param {string} to
 * @param {Array} items
 */
async function renderItemsAsList(to, items) {
  const sections = [{
    title: 'Options',
    rows: items.slice(0, 10).map(item => ({
      id: `select_${item.id}`,
      title: item.title?.slice(0, 24) || 'Item',
      description: item.subtitle || item.price || ''
    }))
  }];
  
  await whatsappClient.sendList(
    to,
    'Here are your options. Tap below to view:',
    'View Options',
    sections
  );
}

/**
 * Render actions as buttons
 * @param {string} to
 * @param {Array} actions
 */
async function renderActionsAsButtons(to, actions) {
  const buttons = actions.slice(0, 3).map(action => ({
    id: `action_${action.action}_${action.payload || ''}`,
    title: action.label
  }));
  
  await whatsappClient.sendButtons(to, 'What would you like to do?', buttons);
}

/**
 * Render suggestions as quick reply buttons
 * @param {string} to
 * @param {Array<string>} suggestions
 */
async function renderSuggestions(to, suggestions) {
  const buttons = suggestions.slice(0, 3).map((suggestion, i) => ({
    id: `suggestion_${i}`,
    title: suggestion.slice(0, 20)
  }));
  
  await whatsappClient.sendButtons(to, 'You might also want to explore:', buttons);
}

/**
 * Format text message to be more concise and beautiful
 * @param {string} text - Original text message
 * @returns {string} Formatted text
 */
function formatTextMessage(text) {
  if (!text) return '';
  
  // Extract the main header (first line or first sentence)
  const lines = text.split('\n');
  const header = lines[0] || text.split('–')[0] || text.split('.')[0];
  
  // If message is too long, make it concise
  if (text.length > 200) {
    // Return just the header with a note
    return `${header}\n\n📋 Showing ${text.match(/\*\*/g)?.length / 2 || 0} options below 👇`;
  }
  
  return text;
}

/**
 * Render hotel cards with images
 * @param {string} to - Recipient phone number
 * @param {Array} hotelCards - Array of hotel card objects
 * @param {string} introText - Optional introductory text
 */
async function renderHotelCards(to, hotelCards, introText = null) {
  // Send concise intro if provided
  if (introText) {
    const formattedIntro = formatTextMessage(introText);
    await whatsappClient.sendText(to, formattedIntro);
    // Small delay to ensure message order
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  // Send loading message if we have multiple products
  if (hotelCards.length > 1) {
    await whatsappClient.sendText(to, '⏳ Loading more options for you...');
    await new Promise(resolve => setTimeout(resolve, 800));
  }
  
  // Send each product as an image with formatted caption and clickable booking link
  for (let i = 0; i < hotelCards.length; i++) {
    const product = hotelCards[i];
    // Include booking link directly in caption (WhatsApp makes it clickable)
    const caption = buildProductCaption(product, i + 1, hotelCards.length, true);
    
    if (product.image) {
      // Send image with caption (booking link in caption is clickable)
      await whatsappClient.sendImage(to, product.image, caption);
    } else {
      // No image - send text with clickable booking link
      await whatsappClient.sendText(to, caption);
    }
    
    // Small delay between messages to avoid rate limiting
    if (i < hotelCards.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 800));
    }
  }
}

/**
 * Build beautiful caption for product card (hotels, flights, buses, packages, etc.)
 * @param {Object} product - Product object
 * @param {number} index - Current index (1-based)
 * @param {number} total - Total number of products
 * @param {boolean} includeBookingLink - Whether to include booking link in caption (default: true)
 * @returns {string} Formatted caption
 */
function buildProductCaption(product, index, total, includeBookingLink = true) {
  const parts = [];
  
  // WhatsApp image caption limit: 1024 characters
  const MAX_CAPTION_LENGTH = 1024;
  
  // Get product type and icon
  const productType = product.productType || 'product';
  const icon = productType === 'hotel' ? '🏨' :
               productType === 'flight' ? '✈️' :
               productType === 'bus' ? '🚌' :
               productType === 'package' ? '📦' :
               '🎯';
  
  // Header with product title
  const title = product.title || (productType === 'hotel' ? 'Hotel' : 'Product');
  parts.push(`${icon} *${title}*`);
  parts.push('');
  
  // Product-specific information
  if (productType === 'flight' || productType === 'bus') {
    // For flights/buses: show route, time, duration
    if (product.subtitle) {
      // Format: "22:30 - 00:50 | 02h 20m"
      const timeParts = product.subtitle.split('|');
      if (timeParts.length >= 2) {
        parts.push(`🕐 ${timeParts[0].trim()}`);
        parts.push(`⏱️ Duration: ${timeParts[1].trim()}`);
      } else {
        parts.push(`📍 ${product.subtitle}`);
      }
    }
    
    // Price for flights/buses
    if (product.price) {
      parts.push(`💰 ${product.price}`);
    }
    
    // Description (flight details)
    if (product.description) {
      // Remove markdown formatting for cleaner display
      let cleanDesc = product.description
        .replace(/\*\*/g, '')
        .replace(/\n/g, ' ')
        .trim();
      
      // Truncate if too long
      if (cleanDesc.length > 200) {
        cleanDesc = cleanDesc.substring(0, 197) + '...';
      }
      
      if (cleanDesc) {
        parts.push('');
        parts.push(cleanDesc);
      }
    }
  } else if (productType === 'hotel') {
    // For hotels: show location, rating, price
    if (product.location) {
      parts.push(`📍 ${product.location}`);
    }
    
    // Rating
    if (product.rating) {
      const ratingText = product.ratingCount 
        ? `⭐ ${product.rating} (${product.ratingCount} reviews)`
        : `⭐ ${product.rating}`;
      parts.push(ratingText);
    }
    
    // Price
    if (product.price) {
      parts.push(`💰 ${product.price}`);
    }
    
    // Description (if available and not too long)
    if (product.description) {
      let cleanDesc = product.description
        .replace(/\*\*/g, '')
        .replace(/\n/g, ' ')
        .trim();
      
      if (cleanDesc.length > 200) {
        cleanDesc = cleanDesc.substring(0, 197) + '...';
      }
      
      if (cleanDesc) {
        parts.push('');
        parts.push(cleanDesc);
      }
    }
  } else {
    // Generic product (packages, itineraries, etc.)
    if (product.location || product.subtitle) {
      parts.push(`📍 ${product.location || product.subtitle}`);
    }
    
    if (product.rating) {
      parts.push(`⭐ ${product.rating}`);
    }
    
    if (product.price) {
      parts.push(`💰 ${product.price}`);
    }
    
    if (product.description) {
      let cleanDesc = product.description
        .replace(/\*\*/g, '')
        .replace(/\n/g, ' ')
        .trim();
      
      if (cleanDesc.length > 200) {
        cleanDesc = cleanDesc.substring(0, 197) + '...';
      }
      
      if (cleanDesc) {
        parts.push('');
        parts.push(cleanDesc);
      }
    }
  }
  
  // Booking link - make it prominent and clickable
  // WhatsApp automatically makes URLs in messages clickable
  // Put link directly in caption for instant access (no button click needed)
  if (includeBookingLink && product.bookingLink) {
    parts.push('');
    // Format: "📅 Book Now" on one line, link on next line (WhatsApp makes it clickable)
    // This is faster than buttons - user can click link immediately
    parts.push(`📅 *Book Now:*`);
    parts.push(product.bookingLink);
  }
  
  // Footer with product number
  parts.push('');
  parts.push(`📋 ${index} of ${total}`);
  
  // Final caption
  let caption = parts.join('\n');
  
  // Ensure we don't exceed WhatsApp limit
  // Calculate space needed for URL (if included) and footer
  const urlPart = (includeBookingLink && product.bookingLink) ? `\n\n🔗 Book now: ${product.bookingLink}` : '';
  const footerPart = `\n\n📋 ${index} of ${total}`;
  const reservedLength = urlPart.length + footerPart.length;
  
  if (caption.length > MAX_CAPTION_LENGTH) {
    logger.warn('Caption too long, truncating', { 
      originalLength: caption.length,
      maxLength: MAX_CAPTION_LENGTH,
      productType: productType
    });
    
    // Truncate description or other parts, but preserve URL and footer
    const maxContentLength = MAX_CAPTION_LENGTH - reservedLength - 10; // 10 chars buffer
    const contentParts = parts.slice(0, -2); // All parts except URL and footer
    let content = contentParts.join('\n');
    
    if (content.length > maxContentLength) {
      content = content.substring(0, maxContentLength - 3) + '...';
    }
    
    // Rebuild with truncated content + URL + footer
    caption = content + urlPart + footerPart;
  }
  
  return caption;
}

module.exports = {
  renderResponse,
  renderCarouselItem,
  buildItemCaption,
  renderHotelCards,
  buildProductCaption
};
