// The category vocabulary, the instruction every provider is given, and a parser tolerant
// enough to accept what a small open-weights model actually returns.

const CATEGORIES = ['reviewing', 'stay-in-touch', 'no', 'resume-requested', 'needs-attention', 'other'];

const SYSTEM_INSTRUCTION = `You classify a single email reply to a cold outreach message into exactly one category:
- reviewing: they're reviewing the profile/application, will get back to us later
- stay-in-touch: no current openings, but asked to stay in touch / reach out later
- no: a clear rejection, not interested
- resume-requested: asking for a resume, portfolio, or more info to move forward
- needs-attention: anything that doesn't confidently fit the above — questions, negotiation, unusual tone, or ambiguous replies. Use this whenever you are not confident.
- other: auto-replies, unsubscribe requests, or anything clearly irrelevant to a job-outreach conversation

Always pick exactly one category. If uncertain, pick "needs-attention". Give a one-sentence reason (under 200 characters).`;

// Gemini gets a real response schema, so it never needs telling. The OpenAI-compatible
// providers use `response_format: json_object`, which on most implementations REQUIRES the
// literal word "JSON" somewhere in the messages — hence this suffix rather than a bare
// schema hint.
const JSON_INSTRUCTION = `Respond with a single JSON object and nothing else:
{"category": "<one of: ${CATEGORIES.join(' | ')}>", "reasoning": "<one sentence, under 200 characters>"}`;

const MAX_BODY_CHARS = 8000;

/** The user-turn content: the reply itself, bounded. */
function buildPrompt({ subject, body }) {
  return `Subject: ${subject || '(no subject)'}\n\nBody:\n${(body || '').slice(0, MAX_BODY_CHARS)}`;
}

/**
 * A verdict from whatever a model emitted, or null if it isn't one.
 *
 * Null is a real answer here: the orchestrator reads it as "this provider babbled" and
 * moves to the next one, which is strictly better than coercing junk into a category.
 */
function parseVerdict(text) {
  let raw = String(text || '').trim();
  if (!raw) return null;

  const fenced = /^```[a-z]*\s*([\s\S]*?)\s*```$/i.exec(raw);
  if (fenced) raw = fenced[1].trim();

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    // Some models prepend a sentence before the object. Take the outermost braces.
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      parsed = JSON.parse(raw.slice(start, end + 1));
    } catch (_) {
      return null;
    }
  }

  if (!parsed || typeof parsed !== 'object') return null;

  const category = normalizeCategory(parsed.category);
  if (!category) return null;

  return { category, reasoning: String(parsed.reasoning ?? '').trim().slice(0, 200) };
}

/** 'Stay_In_Touch' / ' NO ' -> a member of CATEGORIES, or null. */
function normalizeCategory(value) {
  if (typeof value !== 'string') return null;
  const slug = value.trim().toLowerCase().replace(/[\s_]+/g, '-');
  return CATEGORIES.includes(slug) ? slug : null;
}

module.exports = {
  CATEGORIES, SYSTEM_INSTRUCTION, JSON_INSTRUCTION, MAX_BODY_CHARS,
  buildPrompt, parseVerdict, normalizeCategory,
};
