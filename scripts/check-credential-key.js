// READ-ONLY: does the local CREDENTIAL_KEY decrypt the Gmail app passwords
// stored in the database? Run before moving hosts: a different key means every
// user has to reconnect Gmail. Prints counts only, never a secret. Writes nothing.
//
//   node scripts/check-credential-key.js [dev|prod]   (default prod)
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const { decrypt } = require('../lib/credentials');
(async () => {
  await mongoose.connect(process.env[process.argv[2] === 'dev' ? 'MONGODB_URI_DEV' : 'MONGODB_URI_PROD']);
  const rows = await mongoose.connection.db.collection('settings')
    .find({ gmailAppPasswordEnc: { $nin: [null, ''] } }, { projection: { gmailAppPasswordEnc: 1 } }).toArray();
  let ok = 0, bad = 0;
  for (const r of rows) {
    try { decrypt(r.gmailAppPasswordEnc) ? ok++ : bad++; } catch (_) { bad++; }
  }
  console.log(`stored Gmail credentials: ${rows.length}, decrypt OK: ${ok}, FAIL: ${bad}`);
  console.log(rows.length && ok === rows.length ? 'MATCH: local CREDENTIAL_KEY is the deployed one'
    : rows.length ? 'MISMATCH: local CREDENTIAL_KEY differs from the deployed one'
    : 'No stored credentials to test against');
  await mongoose.disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
