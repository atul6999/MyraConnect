/**
 * Webhook Routes
 * Express routes for WhatsApp webhook and test endpoints
 */

const express = require('express');
const router = express.Router();
const { handleVerification, handleIncoming } = require('../whatsapp/webhookHandler');
const { normalizeMessage } = require('../whatsapp/normalizer');
const orchestrator = require('../logic/orchestrator');
const logger = require('../utils/logger');
const config = require('../config');

// WhatsApp webhook verification
router.get('/webhook', handleVerification);

// WhatsApp webhook incoming messages
router.post('/webhook', handleIncoming);

/**
 * Test endpoint - Simulate WhatsApp message (bypasses verification)
 * Useful for local development without real WhatsApp API
 */
router.post('/test/message', async (req, res) => {
  const startTime = Date.now();
  try {
    logger.info('=== TEST ENDPOINT CALLED ===', { 
      body: req.body,
      timestamp: new Date().toISOString()
    });
    const { from, text, buttonId, listId } = req.body;
    
    if (!from) {
      logger.warn('Test endpoint: Missing "from" field');
      return res.status(400).json({ error: 'Missing "from" field (phone number)' });
    }
    
    // Build normalized message directly
    const normalizedMessage = {
      userId: from,
      messageId: `test_${Date.now()}`,
      timestamp: Date.now(),
      type: buttonId ? 'button' : (listId ? 'list' : 'text'),
      text,
      buttonId,
      buttonText: buttonId,
      listId,
      listTitle: listId
    };
    
    logger.info('✅ Test message received and normalized', normalizedMessage);
    
    // Process through orchestrator (with timeout protection)
    logger.info('🔄 Starting message processing...');
    
    // Set a timeout for the entire processing (configurable, default 70 seconds)
    const processingTimeoutMs = config.processing.timeoutMs;
    const processingTimeoutSeconds = processingTimeoutMs / 1000;
    const processingPromise = orchestrator.processMessage(normalizedMessage);
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Message processing timeout after ${processingTimeoutSeconds} seconds`));
      }, processingTimeoutMs);
    });
    
    await Promise.race([processingPromise, timeoutPromise]);
    
    const processingTime = Date.now() - startTime;
    logger.info('✅ Message processing completed', { 
      processingTimeMs: processingTime,
      processingTimeSeconds: (processingTime / 1000).toFixed(2)
    });
    
    res.json({ 
      success: true, 
      message: 'Message processed',
      processingTimeMs: processingTime,
      note: 'Check logs for outgoing messages (real WhatsApp API not called in test mode)'
    });
    
  } catch (error) {
    const processingTime = Date.now() - startTime;
    logger.error('❌ Test endpoint error', { 
      error: error.message, 
      stack: error.stack,
      processingTimeMs: processingTime,
      errorType: error.constructor.name,
      fullError: error 
    });
    res.status(500).json({ 
      error: error.message,
      processingTimeMs: processingTime
    });
  }
});

/**
 * Get session info for a user (debug)
 */
router.get('/test/session/:userId', async (req, res) => {
  try {
    const session = await orchestrator.sessionManager.get(req.params.userId);
    res.json({ session: session || null });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
