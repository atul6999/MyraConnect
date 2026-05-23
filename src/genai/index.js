/**
 * GenAI Module Index
 * Main exports for AI-powered features
 */

const geminiClient = require('./geminiClient');
const comparisonGenerator = require('./comparisonGenerator');
const genaiConfig = require('./config');
const travelFilter = require('./travelFilter');
const responseGenerator = require('./responseGenerator');

module.exports = {
  // Client
  geminiClient,
  
  // Comparison features
  generateComparison: comparisonGenerator.generateComparison,
  shouldGenerateComparison: comparisonGenerator.shouldGenerateComparison,
  
  // Travel filtering
  checkIfTravelRelated: travelFilter.checkIfTravelRelated,
  quickTravelCheck: travelFilter.quickTravelCheck,
  
  // Response generation
  generateGeneralResponse: responseGenerator.generateGeneralResponse,
  generateFallbackResponse: responseGenerator.generateFallbackResponse,
  
  // Config
  config: genaiConfig,
  
  // Utility to check if GenAI is available
  isAvailable: () => geminiClient.isReady(),
};
