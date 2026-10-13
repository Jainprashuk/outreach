const mongoose = require('mongoose');

// Each user's settings for the Leads sources (lib/sources/): what they're looking
// for, and which automatic sources are on. Both automatic sources are OFF until the
// user turns them on — nothing runs on an upgrade.
const MAX_PER_DAY = 20;

const sourceConfigSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  // "Your target", shared by every source's fit score.
  roles:     { type: [String], default: [] },
  locations: { type: [String], default: ['india', 'remote'] },
  maxYears:  { type: Number, default: null },

  // Hiring-post finder (Tavily). Each search spends one credit of the user's own key.
  webOn:     { type: Boolean, default: false },
  webPerDay: { type: Number, default: 6, min: 1, max: MAX_PER_DAY },

  // HN "Who is hiring?"
  hnOn:      { type: Boolean, default: false },
}, { timestamps: true });

sourceConfigSchema.index({ userId: 1 }, { unique: true });

/**
 * The user's config, created on first read. A new config starts with the roles
 * already typed for Discover, so nobody types them twice.
 */
sourceConfigSchema.statics.getForUser = async function (userId) {
  const found = await this.findOne({ userId });
  if (found) return found;
  const DiscoveryConfig = require('./DiscoveryConfig');
  const disc = await DiscoveryConfig.findOne({ userId }, { defaultRoles: 1 }).lean();
  try {
    return await this.create({ userId, roles: (disc && disc.defaultRoles) || [] });
  } catch (err) {
    if (err && err.code === 11000) return this.findOne({ userId }); // created by a parallel request
    throw err;
  }
};

sourceConfigSchema.set('toJSON', {
  transform: (doc, ret) => ({
    roles: ret.roles || [],
    locations: ret.locations || [],
    maxYears: ret.maxYears == null ? null : ret.maxYears,
    webOn: !!ret.webOn,
    webPerDay: ret.webPerDay,
    hnOn: !!ret.hnOn,
  }),
});

const SourceConfig = mongoose.model('SourceConfig', sourceConfigSchema);
SourceConfig.MAX_PER_DAY = MAX_PER_DAY;
module.exports = SourceConfig;
