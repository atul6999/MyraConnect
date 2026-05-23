/**
 * GenAI Configuration
 * Export configuration for AI comparison features
 */

module.exports = {
  provider: process.env.GENAI_PROVIDER || 'gemini',
  apiKey: process.env.GENAI_API_KEY,
  // Use gemini-2.5-flash (latest) or 1.5 versions only
  model: process.env.GENAI_MODEL || 'models/gemini-2.5-flash',
  comparisonEnabled: process.env.GENAI_COMPARISON_ENABLED !== 'false',
  maxOutputTokens: 500,
  temperature: 0.7,
};
