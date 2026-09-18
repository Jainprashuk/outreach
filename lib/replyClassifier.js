const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');
const { logEvent } = require('./activityLog');

const MODEL_NAME = 'gemini-3-flash-preview';

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

// Classifies a single inbound reply. Never throws — on any missing key, API error (e.g. a
// free-tier rate limit), or malformed response it returns `success: false` so a classifier
// failure never blocks the mailbox scan from completing. `success` is the caller's signal for
// whether this was a REAL model answer or just a fallback — without it, a rate-limited call
// and a genuine "needs-attention" verdict from Gemini would look identical.
// contactEmail/contactName are only used for logging (see below) — not sent to Gemini.
async function classifyReply({ subject, body, contactEmail, contactName, userId }) {
  const client = getClient();
  if (!client) return { ...FALLBACK, success: false }; // no key configured — no request is made, so nothing to log

  const startedAt = Date.now();
  let result = null;
  let errorMessage = null;
  let success = false;

  try {
    const model = client.getGenerativeModel({
      model: MODEL_NAME,
      systemInstruction: SYSTEM_INSTRUCTION,
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
      },
    });

    const prompt = `Subject: ${subject || '(no subject)'}\n\nBody:\n${(body || '').slice(0, 8000)}`;
    const response = await model.generateContent(prompt);
    const parsed = JSON.parse(response.response.text());

    if (CATEGORIES.includes(parsed.category)) {
      result = { category: parsed.category, reasoning: String(parsed.reasoning || '').slice(0, 200) };
      success = true;
    } else {
      result = FALLBACK;
      errorMessage = `model returned an unrecognized category: ${parsed.category}`;
    }
  } catch (err) {
    console.error('[replyClassifier] classification failed:', err.message);
    errorMessage = err.message;
    result = FALLBACK;
  }

  const latencyMs = Date.now() - startedAt;
  const who = contactName || contactEmail || 'unknown contact';

  logEvent({
    userId,
    category: 'gemini',
    action: success ? 'classify' : 'classify_failed',
    message: success
      ? `Classified reply from ${who} as "${result.category}"`
      : `Gemini classification failed for ${who}: ${errorMessage}`,
    meta: {
      contactEmail: contactEmail || null,
      contactName: contactName || null,
      subject: subject || null,
      category: result.category,
      reasoning: result.reasoning,
      model: MODEL_NAME,
      latencyMs,
      error: errorMessage,
    },
  }).catch(err => console.error('Activity log write failed:', err.message));

  return { ...result, success };
}

module.exports = { classifyReply, CATEGORIES };
