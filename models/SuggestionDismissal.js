const mongoose = require('mongoose');

// "Not worth it" on a Discover suggestion: hides that company from the "Worth
// searching" list until `until`. Only the suggestion is hidden — the company still
// shows in Hiring now and can be searched by hand.
const suggestionDismissalSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  key:    { type: String, required: true },   // the suggestion's key: d:<domain> or n:<name>
  until:  { type: Date, required: true },
}, { timestamps: true });

// Both fields always set, so a plain unique index is safe (no sparse/null trap).
suggestionDismissalSchema.index({ userId: 1, key: 1 }, { unique: true });

module.exports = mongoose.model('SuggestionDismissal', suggestionDismissalSchema);
