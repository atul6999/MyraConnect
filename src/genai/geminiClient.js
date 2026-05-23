/**
 * Gemini AI Client
 * Wrapper for Google Generative AI SDK
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const genaiConfig = require('./config');
const logger = require('../utils/logger');

class GeminiClient {
  constructor() {
    this.client = null;
    this.model = null;
    this.modelName = null;
    this.initialized = false;
    this.fallbackModels = ['models/gemini-2.5-flash', 'models/gemini-1.5-flash', 'models/gemini-1.5-pro'];
  }

  /**
   * List available models from the API
   * This helps diagnose API key and model availability issues
   */
  async listAvailableModels() {
    if (!this.client) {
      logger.error('❌ [GEMINI] Client not initialized, cannot list models');
      return null;
    }

    try {
      // Use the SDK's listModels method if available
      // Note: This might not be available in all SDK versions
      const models = await this.client.listModels();
      logger.info('✅ [GEMINI] Available models retrieved', {
        modelCount: models?.length || 0,
        models: models?.map(m => m.name) || []
      });
      return models;
    } catch (error) {
      logger.warn('⚠️ [GEMINI] Could not list models via SDK', {
        error: error.message,
        note: 'This is normal if SDK version does not support listModels'
      });
      return null;
    }
  }

  /**
   * Validate API key by making a simple test call
   */
  async validateApiKey() {
    if (!this.client) {
      return { valid: false, error: 'Client not initialized' };
    }

      // Try the most common model name first (using models/ prefix)
      const testModels = ['models/gemini-2.5-flash', 'models/gemini-1.5-flash', 'models/gemini-1.5-pro'];
    
    for (const testModel of testModels) {
      try {
        const testModelInstance = this.client.getGenerativeModel({
          model: testModel,
          generationConfig: { maxOutputTokens: 5, temperature: 0.1 }
        });

        // Make a minimal test call
        const result = await testModelInstance.generateContent({
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }]
        });

        const response = result.response.text();
        logger.info(`✅ [GEMINI] API key validated with model: ${testModel}`, {
          testResponse: response.substring(0, 20)
        });
        return { valid: true, workingModel: testModel };
      } catch (error) {
        const errorMsg = error.message || String(error);
        // Check if it's an authentication error (401/403)
        if (errorMsg.includes('401') || errorMsg.includes('403') || errorMsg.includes('API key') || errorMsg.includes('authentication')) {
          logger.error('❌ [GEMINI] API key authentication failed', {
            error: errorMsg,
            model: testModel
          });
          return { valid: false, error: 'API key authentication failed', details: errorMsg };
        }
        // Continue to next model if it's just a 404
        continue;
      }
    }

    return { valid: false, error: 'No working models found - check API key and model availability' };
  }

  /**
   * Initialize the Gemini client
   * Called lazily on first use
   */
  initialize() {
    if (this.initialized) return;

    if (!genaiConfig.apiKey) {
      logger.warn('⚠️ [GEMINI] GENAI_API_KEY not set - comparison features disabled', { source: 'GEMINI' });
      return;
    }

    // Check API key format
    if (genaiConfig.apiKey.length < 20) {
      logger.error('❌ [GEMINI] API key appears to be invalid (too short)', {
        keyLength: genaiConfig.apiKey.length,
        keyPreview: genaiConfig.apiKey.substring(0, 10) + '...',
        source: 'GEMINI_ERROR'
      });
      return;
    }

    try {
      this.client = new GoogleGenerativeAI(genaiConfig.apiKey);
      
      // Create model instance (validation happens on first API call)
      // Use the configured model or default to gemini-2.5-flash
      const modelName = genaiConfig.model || 'models/gemini-2.5-flash';
      
      this.model = this.client.getGenerativeModel({
        model: modelName,
        generationConfig: {
          maxOutputTokens: genaiConfig.maxOutputTokens,
          temperature: genaiConfig.temperature,
        },
      });
      
      this.initialized = true;
      this.modelName = modelName;
      logger.info('✅ [GEMINI] Client initialized (will validate on first API call)', { 
        model: modelName,
        apiKeyPreview: genaiConfig.apiKey.substring(0, 10) + '...' + genaiConfig.apiKey.substring(genaiConfig.apiKey.length - 5),
        source: 'GEMINI'
      });
    } catch (error) {
      logger.error('❌ [GEMINI] Failed to initialize client', { 
        error: error.message,
        stack: error.stack,
        source: 'GEMINI_ERROR'
      });
    }
  }

  /**
   * Check if client is ready
   * @returns {boolean}
   */
  isReady() {
    if (!this.initialized) {
      this.initialize();
    }
    return this.initialized && this.model !== null;
  }

  /**
   * Try to find a working model by testing API calls
   * @param {string} testPrompt - Simple test prompt
   * @returns {Promise<string|null>} Working model name or null
   */
  async findWorkingModel(testPrompt = 'hi') {
    if (!this.client) {
      logger.error('❌ Gemini client not initialized');
      return null;
    }

    // Try each model with a simple API call
    for (const tryModel of this.fallbackModels) {
      try {
        logger.info(`🔍 [GEMINI] Testing model: ${tryModel}`, { source: 'GEMINI' });
        const testModel = this.client.getGenerativeModel({
          model: tryModel,
          generationConfig: {
            maxOutputTokens: 10,
            temperature: 0.1,
          },
        });

        // Try a minimal API call to validate the model (no system instruction for test)
        const result = await testModel.generateContent({
          contents: [{ role: 'user', parts: [{ text: testPrompt }] }],
        });

        // If we get here, the model works
        const response = result.response.text();
        logger.info(`✅ [GEMINI] Found working model: ${tryModel}`, { 
          testResponse: response.substring(0, 20),
          source: 'GEMINI'
        });
        return tryModel;
      } catch (error) {
        const errorMsg = error.message || String(error);
        logger.debug(`⚠️ [GEMINI] Model ${tryModel} failed`, { 
          error: errorMsg.substring(0, 100),
          source: 'GEMINI'
        });
        continue;
      }
    }

    logger.error('❌ [GEMINI] No working Gemini model found after testing all fallbacks', {
      testedModels: this.fallbackModels,
      source: 'GEMINI_ERROR'
    });
    return null;
  }

  /**
   * Generate content with system instruction
   * @param {string} userPrompt - User/context prompt
   * @param {string} systemPrompt - System instruction
   * @returns {Promise<string|null>}
   */
  async generate(userPrompt, systemPrompt) {
    if (!this.isReady()) {
      logger.warn('Gemini client not ready, skipping generation');
      return null;
    }

    try {
      const startTime = Date.now();

      const result = await this.model.generateContent({
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        systemInstruction: systemPrompt,
      });

      const response = result.response.text();
      const duration = Date.now() - startTime;

      logger.debug('Gemini generation complete', {
        promptLength: userPrompt.length,
        responseLength: response.length,
        durationMs: duration,
      });

      return response;
    } catch (error) {
      const errorMsg = error.message || String(error);
      
      // Check for authentication errors first
      if (errorMsg.includes('401') || errorMsg.includes('403') || errorMsg.includes('API key') || errorMsg.includes('authentication') || errorMsg.includes('permission')) {
        logger.error('❌ [GEMINI] API key authentication error', {
          error: errorMsg,
          model: this.modelName,
          help: 'Check if your GENAI_API_KEY is valid and has Gemini API access enabled',
          source: 'GEMINI_ERROR'
        });
        return null;
      }

      // If model not found error, try to find a working model
      if (errorMsg.includes('not found') || errorMsg.includes('404')) {
        logger.warn('⚠️ [GEMINI] Current model not available, validating API key and searching for working model...', {
          currentModel: this.modelName,
          error: errorMsg.substring(0, 200),
          source: 'GEMINI'
        });

        // First validate the API key
        const validation = await this.validateApiKey();
        if (!validation.valid) {
          logger.error('❌ [GEMINI] API key validation failed', {
            error: validation.error,
            details: validation.details,
            help: 'Please check your GENAI_API_KEY in .env file. Get a new key from https://aistudio.google.com/apikey',
            source: 'GEMINI_ERROR'
          });
          return null;
        }

        // If we found a working model during validation, use it
        if (validation.workingModel && validation.workingModel !== this.modelName) {
          this.modelName = validation.workingModel;
          this.model = this.client.getGenerativeModel({
            model: validation.workingModel,
            generationConfig: {
              maxOutputTokens: genaiConfig.maxOutputTokens,
              temperature: genaiConfig.temperature,
            },
          });
          logger.info(`🔄 [GEMINI] Switched to working model: ${validation.workingModel}`, { source: 'GEMINI' });

          // Retry the generation
          try {
            const retryResult = await this.model.generateContent({
              contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
              systemInstruction: systemPrompt,
            });
            logger.info('✅ [GEMINI] Generation succeeded after model switch', { source: 'GEMINI' });
            return retryResult.response.text();
          } catch (retryError) {
            logger.error('❌ [GEMINI] Generation failed even after model switch', {
              error: retryError.message,
              source: 'GEMINI_ERROR'
            });
            return null;
          }
        }

        // If validation didn't find a model, try findWorkingModel as fallback
        const workingModel = await this.findWorkingModel('test');
        if (workingModel && workingModel !== this.modelName) {
          this.modelName = workingModel;
          this.model = this.client.getGenerativeModel({
            model: workingModel,
            generationConfig: {
              maxOutputTokens: genaiConfig.maxOutputTokens,
              temperature: genaiConfig.temperature,
            },
          });
          logger.info(`🔄 [GEMINI] Switched to working model: ${workingModel}`, { source: 'GEMINI' });

          // Retry the generation
          try {
            const retryResult = await this.model.generateContent({
              contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
              systemInstruction: systemPrompt,
            });
            return retryResult.response.text();
          } catch (retryError) {
            logger.error('❌ [GEMINI] Generation failed even after model switch', {
              error: retryError.message,
              source: 'GEMINI_ERROR'
            });
            return null;
          }
        }
      }

      logger.error('❌ [GEMINI] Generation failed', {
        error: errorMsg.substring(0, 300),
        code: error.code,
        model: this.modelName,
        help: 'Check your API key at https://aistudio.google.com/apikey and ensure Gemini API is enabled',
        source: 'GEMINI_ERROR'
      });
      return null;
    }
  }
}

// Export singleton instance
module.exports = new GeminiClient();
