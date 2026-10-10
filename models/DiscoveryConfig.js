const mongoose = require('mongoose');

// Each user's own keys for the free discovery services, and how much of each free
// allowance they've used this month. A collection of its own rather than fields on
// Settings, so the existing /api/settings response is untouched and a key can't
// reach the browser through any existing Settings read.
//
// Keys are encrypted with lib/credentials.js, like the Gmail App Password. There is
// deliberately no env-var fallback: a shared key would spend one person's free
// allowance on everyone.
const PROVIDERS = ['tavily', 'serpapi', 'hunter', 'github'];

// Free monthly allowances. Stopping a little short of the real limit leaves room for
// a request the provider counted but we didn't see succeed.
const MONTHLY_CAPS = { tavily: 950, serpapi: 240, hunter: 45, github: Infinity };

const discoveryConfigSchema = new mongoose.Schema({
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  tavilyEnc:  { type: String, default: '' },
  serpapiEnc: { type: String, default: '' },
  hunterEnc:  { type: String, default: '' },
  githubEnc:  { type: String, default: '' },
  // Roles the Discover search box starts filled with. Optional: empty finds anyone.
  defaultRoles: { type: [String], default: [] },
  // Outside-signal sources you switched off for "Worth searching" (news, hn,
  // careers, github, fit). Empty = all on.
  enrichOff: { type: [String], default: [] },
  usage: {
    month:   { type: String, default: '' }, // YYYY-MM (Asia/Kolkata)
    tavily:  { type: Number, default: 0 },
    serpapi: { type: Number, default: 0 },
    hunter:  { type: Number, default: 0 },
  },
}, { timestamps: true });

discoveryConfigSchema.index({ userId: 1 }, { unique: true });

discoveryConfigSchema.set('toJSON', {
  transform: (doc, ret) => {
    const out = { usage: ret.usage || {}, defaultRoles: ret.defaultRoles || [], enrichOff: ret.enrichOff || [] };
    for (const p of PROVIDERS) out[p] = !!ret[`${p}Enc`];
    return out;
  },
});

const DiscoveryConfig = mongoose.model('DiscoveryConfig', discoveryConfigSchema);
DiscoveryConfig.PROVIDERS = PROVIDERS;
DiscoveryConfig.MONTHLY_CAPS = MONTHLY_CAPS;
module.exports = DiscoveryConfig;
