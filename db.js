const mongoose = require('mongoose');
const Template = require('./models/Template');
const Settings = require('./models/Settings');

const DEFAULT_TEMPLATES = [
  {
    key: 'intro-v2',
    name: 'Intro v2',
    subject: 'Quick intro — {{sender}} from {{senderCompany}}',
    body: `Hi {{name}},\n\nI came across {{company}} and was genuinely impressed by what you're building. I'd love to connect for a quick 15-minute call to explore if there's a mutual fit.\n\nWould next week work for you?\n\nBest,\n{{sender}}`
  },
  {
    key: 'follow-up',
    name: 'Follow-up',
    subject: 'Following up — {{sender}}',
    body: `Hi {{name}},\n\nJust circling back on my previous note. I understand you're busy, but I believe what we're working on at {{senderCompany}} could genuinely add value to {{company}}.\n\nHappy to keep it brief — even 10 minutes would be great.\n\nBest,\n{{sender}}`
  },
  {
    key: 'cold',
    name: 'Cold outreach',
    subject: 'A thought on {{company}}',
    body: `Hi {{name}},\n\nCold email, I know — but I'll keep it short. We help companies like {{company}} with [value proposition]. Given your role as {{role}}, I thought this might be relevant.\n\nOpen to a quick chat?\n\n{{sender}}`
  }
];

async function seed() {
  for (const tpl of DEFAULT_TEMPLATES) {
    await Template.updateOne({ key: tpl.key }, { $setOnInsert: tpl }, { upsert: true });
  }
  await Settings.getSingleton();
}

async function connect() {
  const env = process.env.NODE_ENV === 'prod' ? 'prod' : 'dev';
  const uri = env === 'prod' ? process.env.MONGODB_URI_PROD : process.env.MONGODB_URI_DEV;

  if (!uri) {
    console.warn(`⚠️  MONGODB_URI_${env.toUpperCase()} is not set — contacts/templates/settings API will not work.`);
    return;
  }

  // bufferCommands: false — fail fast instead of queuing ops when DB is not connected
  mongoose.set('bufferCommands', false);

  await mongoose.connect(uri, {
    maxPoolSize: 5,              // keep pool small for serverless (each instance has its own)
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  });
  console.log(`✅  Connected to MongoDB (${env} database)`);
  await seed();
}

module.exports = { connect };
