const { openaiCompatProvider } = require('./openaiCompat');

module.exports = openaiCompatProvider({
  name: 'cerebras',
  url: 'https://api.cerebras.ai/v1/chat/completions',
  keyEnv: 'CEREBRAS_API_KEY',
  modelEnv: 'CEREBRAS_MODEL',
  defaultModel: 'gpt-oss-120b',
});
