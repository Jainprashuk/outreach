const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');

const CATEGORIES = ['reviewing', 'stay-in-touch', 'no', 'resume-requested', 'needs-attention', 'other'];

const SYSTEM_INSTRUCTION = `You classify a single email reply to a cold outreach message into exactly one category:
- reviewing: they're reviewing the profile/application, will get back to us later
- stay-in-touch: no current openings, but asked to stay in touch / reach out later
- no: a clear rejection, not interested
- resume-requested: asking for a resume, portfolio, or more info to move forward
- needs-attention: anything that doesn't confidently fit the above — questions, negotiation, unusual tone, or ambiguous replies. Use this whenever you are not confident.
- other: auto-replies, unsubscribe requests, or anything clearly irrelevant to a job-outreach conversation

Always pick exactly one category. If uncertain, pick "needs-attention". Give a one-sentence reason (under 200 characters).`;

const RESPONSE_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    category: { type: SchemaType.STRING, enum: CATEGORIES, format: 'enum' },
    reasoning: { type: SchemaType.STRING },
  },
  required: ['category', 'reasoning'],
};

let _client = null;
const getClient = () => {
  if (!process.env.GEMINI_API_KEY) return null;
  if (!_client) _client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return _client;
};

const FALLBACK = { category: 'needs-attention', reasoning: 'classification failed' };

// Classifies a single inbound reply. Never throws — falls back to
// needs-attention on any missing key, API error, or malformed response so a
// classifier failure never blocks the mailbox scan from completing.
async function classifyReply({ subject, body }) {
  const client = getClient();
  if (!client) return FALLBACK;

  try {
    const model = client.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction: SYSTEM_INSTRUCTION,
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
      },
    });

    const prompt = `Subject: ${subject || '(no subject)'}\n\nBody:\n${(body || '').slice(0, 8000)}`;
    const result = await model.generateContent(prompt);
    const parsed = JSON.parse(result.response.text());

    if (!CATEGORIES.includes(parsed.category)) return FALLBACK;
    return {
      category: parsed.category,
      reasoning: String(parsed.reasoning || '').slice(0, 200),
    };
  } catch (err) {
    console.error('[replyClassifier] classification failed:', err.message);
    return FALLBACK;
  }
}

module.exports = { classifyReply, CATEGORIES };
