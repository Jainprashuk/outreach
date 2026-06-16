const nodemailer = require('nodemailer');
const Settings = require('../models/Settings');

let transporter = null;
let senderConfig = { email: '', name: 'Prashuk Jain' };
let senderAppPassword = '';

const buildTransporter = (email, appPassword) =>
  nodemailer.createTransport({
    service: 'gmail',
    auth: { user: email, pass: appPassword }
  });

// Pre-configure from .env if credentials are present
if (process.env.GMAIL_EMAIL && process.env.GMAIL_APP_PASSWORD) {
  transporter = buildTransporter(process.env.GMAIL_EMAIL, process.env.GMAIL_APP_PASSWORD);
  senderConfig = {
    email: process.env.GMAIL_EMAIL,
    name: process.env.SENDER_NAME || 'Prashuk Jain'
  };
  senderAppPassword = process.env.GMAIL_APP_PASSWORD;
}

const getResumeAttachment = async (attachResume) => {
  if (!attachResume) return undefined;
  const settings = await Settings.getSingleton();
  if (!settings.resume) return undefined;
  return [{
    filename: settings.resume.filename,
    content: settings.resume.data,
    contentType: settings.resume.contentType,
  }];
};

module.exports = {
  get transporter() { return transporter; },
  get senderConfig() { return senderConfig; },
  get senderAppPassword() { return senderAppPassword; },
  set transporter(v) { transporter = v; },
  set senderConfig(v) { senderConfig = v; },
  set senderAppPassword(v) { senderAppPassword = v; },
  buildTransporter,
  getResumeAttachment,
};
