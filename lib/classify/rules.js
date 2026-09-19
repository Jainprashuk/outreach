// The zero-quota pass. Most inbound mail on a cold-outreach campaign is out-of-office
// autoreplies, unsubscribe requests and flat rejections — all decidable from text, none
// worth an API call. Everything this module settles is a reply no provider ever sees.
//
// THE ASYMMETRY THAT GOVERNS EVERY RULE HERE: a wrong confident verdict is invisible and
// permanent — a false `no` silently closes a live lead and nobody ever looks at it again.
// Abstaining costs one request on a path that has three providers behind it. So every rule
// is a strong pattern plus a generous veto list, and when the two disagree the veto wins.
// The vetoes will abstain on a fair share of genuine rejections. That is the correct trade,
// not a bug to tune out.
//
// Rules may only decide `other` and `no`. The remaining categories are separated by intent
// rather than vocabulary — "we already have your resume" and "send us your resume" share
// every keyword and mean opposite things — so they always go to a model.

const { normalizeBody } = require('./text');

// Kept verbatim: server.js's one-time replyClassifierOk migration uses this exact reasoning
// string to tell a real verdict apart from a disguised failure on pre-existing rows.
const FALLBACK = { category: 'needs-attention', reasoning: 'classification failed' };

// ---------------------------------------------------------------- OTHER-1: auto-reply / OOO

const OOO_SUBJECT = /^\s*(re:\s*)*(auto(matic)?[-\s]?(reply|response)|out[-\s]?of[-\s]?(the[-\s]?)?office|away from (the )?office|on (vacation|holiday|leave)|automatic reply)\b/i;
const OOO_SUBJECT_ANYWHERE = /\bout of (the )?office\b|\bauto(matic)?[-\s]?reply\b/i;

const OOO_BODY = [
  /\b(i am|i'm|i will be|he is|she is|they are|our team is)\s+(currently\s+)?(out of (the )?office|on (annual |parental |sick |maternity |paternity )?leave|on (vacation|holiday)|away from (my |the )?(desk|office|email))\b/i,
  /\bthis is an automat(ed|ic) (reply|response|message)\b/i,
  /\b(limited|no) access to (my )?e?mail\b/i,
  /\b(i will be |i'll be )?(back|returning) (in the office |to the office |at work )?on\b/i,
  /\bwill (respond|reply|get back to you) (when i return|upon my return|on my return)\b/i,
  /\byour (message|email) has been received\b/i,
];

// An autoreply that ALSO asks for something is not an autoreply for our purposes —
// "I'm out until Monday, but send your resume to X" is a live lead.
const OOO_VETO = /\b(resume|cv|portfolio|schedul|calendly|interview|interested|let'?s (chat|talk|connect)|send (me|us|over))\b/i;

// ------------------------------------------------------- OTHER-2: unsubscribe / do-not-contact

const UNSUB = [
  /\bunsubscribe\b/i,
  /\bremove me from (your )?(the )?(mailing |email |distribution |contact )?list\b/i,
  /\btake me off\b[\s\S]{0,30}\blist\b/i,
  /\bstop (emailing|e-mailing|contacting|messaging) me\b/i,
  /\bdo not (contact|email|e-mail|message) me\b/i,
  /\bopt[-\s]?out\b/i,
];

// The match has to be part of what they wrote, not part of the furniture: essentially every
// corporate signature and marketing footer carries a trailing "unsubscribe" link, and a
// normal, positive reply from such an address would otherwise be filed as `other`.
const UNSUB_HEAD_CHARS = 400;
const UNSUB_LINE_VETO = /https?:\/\/|\bclick here\b|\bview (this|in) browser\b|\bmanage (your )?preferences\b/i;

// ------------------------------------------------------------------- NO-1: flat rejection

const REJECTION = [
  /\bwe(?:'| a)?re not (currently )?(hiring|looking|interested)\b/i,
  /\bnot interested\b/i,
  /\b(we|i) (have )?(decided to )?(moved? forward|proceed(ed)?) with (an)?other candidates?\b/i,
  /\bwe will not be (moving forward|proceeding)\b/i,
  /\bwe(?:'| a)?re unable to (move forward|proceed)\b/i,
  /\byour (application|profile|candidacy) (was|has been) (unsuccessful|rejected|declined)\b/i,
  /\bno (current(ly)? )?(open (roles|positions)|openings|vacancies|positions|roles|opportunities)\b/i,
  /\bwe (are|'re) not a (good )?(fit|match)\b/i,
];

const REJECTION_VETOES = [
  // A door left open is `stay-in-touch`, not `no` — and that distinction is the whole
  // reason those are separate categories.
  /\bstay in touch\b/i,
  /\bkeep (you|your (resume|cv|profile|details|application|cv))\b[\s\S]{0,40}\b(in mind|on file|posted|for future)\b/i,
  /\bin the future\b/i,
  /\breach (out|back)\b/i,
  /\bnext (month|quarter|year)\b/i,
  /\bfor now\b/i,
  /\bat (the|this) moment\b/i,
  /\blater\b/i,
  // Anything asking us for something is still a live thread.
  /\bsend\b[\s\S]{0,30}\b(resume|cv|portfolio)\b/i,
  /\bschedul|\bcalendly\b|\bbook a (call|time)\b|\blet'?s (chat|talk|connect|meet)\b/i,
  // A hedge means the sentence turns somewhere we can't see.
  /\bhowever\b/i,
  /\bbut\b/i,
  /\bthat said\b/i,
  /\balthough\b/i,
  /\bunless\b/i,
];

const MAX_RULE_BODY_CHARS = 1500; // a long reply is nuanced by construction

/**
 * A verdict decidable without a model, or null to defer to one.
 *
 * @returns {{category: string, reasoning: string, rule: string} | null}
 */
function decide(subject, body) {
  const subj = String(subject || '').trim();
  const text = normalizeBody(body);
  if (!subj && !text) return null;

  const head = text.slice(0, UNSUB_HEAD_CHARS);

  // Unsubscribe first: it outranks an autoreply, and a do-not-contact wrapped in an
  // out-of-office is still a do-not-contact.
  if (matchesUnsubscribe(subj, head)) {
    return { category: 'other', reasoning: 'Unsubscribe / do-not-contact request (rule OTHER-2)', rule: 'OTHER-2' };
  }

  if (matchesAutoReply(subj, text) && !OOO_VETO.test(text)) {
    return { category: 'other', reasoning: 'Out-of-office or automated reply (rule OTHER-1)', rule: 'OTHER-1' };
  }

  if (matchesFlatRejection(text)) {
    return { category: 'no', reasoning: 'Unambiguous rejection with no opening left (rule NO-1)', rule: 'NO-1' };
  }

  return null;
}

function matchesUnsubscribe(subj, head) {
  if (UNSUB.some(re => re.test(subj))) return true;
  return head.split('\n').some(line =>
    !UNSUB_LINE_VETO.test(line) && UNSUB.some(re => re.test(line)));
}

function matchesAutoReply(subj, text) {
  if (OOO_SUBJECT.test(subj) || OOO_SUBJECT_ANYWHERE.test(subj)) return true;
  const head = text.slice(0, 600);
  return OOO_BODY.some(re => re.test(head));
}

function matchesFlatRejection(text) {
  if (!text || text.length > MAX_RULE_BODY_CHARS) return false;
  if (!REJECTION.some(re => re.test(text))) return false;
  if (text.includes('?')) return false; // a question is a conversation, not a close
  return !REJECTION_VETOES.some(re => re.test(text));
}

module.exports = { decide, FALLBACK };
