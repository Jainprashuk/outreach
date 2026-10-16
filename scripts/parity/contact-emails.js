/**
 * Parity check for GET /api/contacts/emails. READ-ONLY — it never writes.
 *
 * The campaign wizard's "already in Contacts" count used to build its set from the
 * full list (GET /api/contacts): new Set(contacts.map(c => c.email.toLowerCase())).
 * This proves the endpoint returns exactly that set, for every user, on real data.
 *
 *   node scripts/parity/contact-emails.js
 *   NODE_ENV=prod node scripts/parity/contact-emails.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const express = require('express');
const Contact = require('../../models/Contact');
const router = require('../../routes/contacts');

const env = process.env.NODE_ENV === 'prod' ? 'prod' : 'dev';
const uri = env === 'prod' ? process.env.MONGODB_URI_PROD : process.env.MONGODB_URI_DEV;

// Run the real route handler for one user.
function callEmails(userId) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use((req, _res, next) => { req.userId = userId; next(); });
    app.use('/', router);
    const server = app.listen(0, async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${server.address().port}/emails`);
        const body = await r.json();
        if (!r.ok) throw new Error(body.error || r.status);
        resolve(body.emails);
      } catch (e) { reject(e); } finally { server.close(); }
    });
  });
}

(async () => {
  if (!uri) throw new Error(`MONGODB_URI_${env.toUpperCase()} is not set`);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000, socketTimeoutMS: 0 });
  console.log(`Parity (read-only) against ${env} / ${mongoose.connection.db.databaseName}`);
  const userIds = await Contact.distinct('userId');
  let failures = 0;
  for (const userId of userIds) {
    // The old source: the full list's query (GET /api/contacts), then the wizard's own code.
    const full = await Contact.find({ deleted: { $ne: true }, userId }, { 'thread.html': 0 }).sort({ createdAt: -1 }).lean();
    const missing = full.filter(c => !c.email).length;
    const oldSet = new Set(full.filter(c => c.email).map(c => c.email.toLowerCase()));
    const got = await callEmails(userId);
    const newSet = new Set(got);
    const dupes = got.length - newSet.size;
    const onlyOld = [...oldSet].filter(e => !newSet.has(e));
    const onlyNew = [...newSet].filter(e => !oldSet.has(e));
    const ok = !onlyOld.length && !onlyNew.length && !dupes;
    if (!ok) failures++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} user ${userId}: ${full.length} contacts, ${oldSet.size} addresses` +
      (missing ? `, ${missing} without email (old code would have thrown)` : '') +
      (ok ? '' : ` — onlyOld ${onlyOld.length}, onlyNew ${onlyNew.length}, dupes ${dupes}`));
  }
  console.log(failures ? `${failures} user(s) differ` : `All ${userIds.length} users match.`);
  await mongoose.disconnect();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
