# Outreach — Email Campaign Tool

A lightweight HTML/CSS/JS email outreach tool with a Node/Express + MongoDB backend. Contacts, templates, and sender settings are persisted in MongoDB Atlas; emails are sent via Gmail (nodemailer + an App Password).

## Backend setup

```bash
cp .env.example .env   # then fill in MONGODB_URI (and optionally Gmail creds)
npm install
npm start
```

This starts a server at `http://localhost:3000` that also serves the UI — open that URL in your browser.

On first run, the database is seeded with the three default email templates (Intro v2, Follow-up, Cold outreach) and a default settings document.

### API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/contacts` | GET | List all contacts |
| `/api/contacts` | POST | `[{ name, email, company, role, template }, ...]` — bulk create contacts |
| `/api/contacts/:id` | PATCH | `{ approvalStatus?, status?, editedSubject?, editedBody?, template? }` — update a contact |
| `/api/contacts/stats` | GET | `{ total, sent, pending, remaining }` — dashboard stats |
| `/api/templates` | GET | List all email templates |
| `/api/templates` | POST | `{ name, subject, body }` — create a new template (key is derived from the name) |
| `/api/templates/:key` | PATCH | `{ name?, subject?, body? }` — update a template |
| `/api/templates/:key` | DELETE | Delete a template |
| `/api/settings` | GET | `{ senderName, senderCompany, gmailEmail, customVariables, resume }` |
| `/api/settings` | PUT | Update sender settings, incl. `customVariables: [{ key, value }]` |
| `/api/settings/resume` | POST | Multipart upload (field `resume`, PDF/Word, max 5MB) — stores your resume |
| `/api/settings/resume` | GET | Downloads the stored resume |
| `/api/settings/resume` | DELETE | Removes the stored resume |
| `/api/config` | POST | `{ email, appPassword, name }` — verifies and stores Gmail credentials for the session |
| `/api/send` | POST | `{ to, subject, body, attachResume? }` — sends a single email, optionally attaching your resume |
| `/api/bulk-send` | POST | `{ contacts: [{to, subject, body, name}], delayMs, attachResume? }` — sends a batch with a delay between each |
| `/api/status` | GET | `{ configured, email, name }` — current sender status |

The Gmail App Password is kept in memory only (never written to disk or the database). Optionally, set `GMAIL_EMAIL` / `GMAIL_APP_PASSWORD` in `.env` to pre-configure the sender at startup.

## Pages

| File | Description |
|------|-------------|
| `index.html` | Dashboard — stats + contact table |
| `step1.html` | Add contacts (CSV upload or manual entry) |
| `step2.html` | Approve templates per contact |
| `step3.html` | Send via Gmail App Password |
| `done.html` | Success screen |
| `contacts.html` | Full contacts list with search |
| `templates.html` | View email templates + variables |
| `settings.html` | Sender name, company, Gmail address, resume upload, custom variables |

## How to use

1. Start the server (`npm start`) and open `http://localhost:3000`
2. Go to **Settings** and enter your name, company, and Gmail address
3. Click **New Entry** to start a batch:
   - **Step 1** — Upload a CSV (Name, Email, Company, Role columns) or enter contacts manually
   - **Step 2** — Preview personalised emails for each contact; Approve, Edit, or Reject
   - **Step 3** — Enter your Gmail App Password and hit Send
4. Watch the live send log, then land on the Done screen

## Gmail App Password setup

1. Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
2. Create a new App Password (name it "Outreach" or anything)
3. Copy the 16-character password — enter it at Step 3

> The app password is used only during the send and is never stored to disk.

## CSV format

```
Name,Email,Company,Role
Rahul Sharma,rahul@acme.in,Acme Corp,VP Sales
Priya Kaur,priya@startup.io,Startup.io,Co-founder
```

A ready-made [sample-contacts.csv](sample-contacts.csv) is available to download from the **Add contacts** step — it opens fine in Excel/Google Sheets too.

## Attaching your resume

Upload a resume (PDF or Word, max 5MB) on the **Settings** page. When it's present, **Step 3 — Send** shows an "Attach my resume" checkbox — check it to include the resume as an attachment on every email in that batch.

## Template variables

| Variable | Replaced with |
|----------|--------------|
| `{{name}}` | Contact's first name |
| `{{company}}` | Contact's company |
| `{{role}}` | Contact's role |
| `{{sender}}` | Your name (from Settings) |
| `{{senderCompany}}` | Your company (from Settings) |
| `{{yourVariable}}` | Any custom variable defined in Settings → Custom variables |

### Custom templates & variables

- **Templates** page lets you create, edit and delete templates — each gets a unique key derived from its name and immediately shows up in the template picker on Step 1.
- **Settings → Custom variables** lets you define your own merge tags (e.g. `calendlyLink`, `phone`) with a global value. Use them as `{{calendlyLink}}` in any template, alongside the built-in variables above. Variable names must start with a letter and contain only letters, numbers and underscores, and can't reuse a built-in name.
