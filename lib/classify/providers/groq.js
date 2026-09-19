const { openaiCompatProvider } = require('./openaiCompat');

module.exports = openaiCompatProvider({
  name: 'groq',
  url: 'https://api.groq.com/openai/v1/chat/completions',
  keyEnv: 'GROQ_API_KEY',
  modelEnv: 'GROQ_MODEL',
  defaultModel: 'openai/gpt-oss-20b',
});
