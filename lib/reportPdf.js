/**
 * Renders a report (lib/reportStats.js output) as a PDF Buffer.
 *
 * pdfkit, not a headless browser: Chromium on Vercel blows the bundle limit and
 * the 60s budget, and the repo avoids native modules. The charts are drawn with
 * pdfkit's own rectangles — two bar charts do not justify a chart library.
 *
 * Built-in Helvetica only. Embedding a font would add ~100KB to every report,
 * and Helvetica's WinAnsi encoding covers everything drawn here — which is also
 * why the arrows and dashes below are ASCII-safe characters.
 */
const PDFDocument = require('pdfkit');
const { labelFor } = require('./reportPeriod');

const C = {
  ink: '#111827', text: '#374151', muted: '#6b7280', faint: '#9ca3af', rule: '#e5e7eb',
  panel: '#f6f7f9', accent: '#4f46e5', reply: '#0f766e', up: '#15803d', down: '#b91c1c',
};
const M = 48;                       // page margin
const n = (v) => Number(v || 0).toLocaleString('en-IN');
const when = (d, withTime = false) => new Date(d).toLocaleString('en-IN', {
  timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}),
});

function deltaText(h, isRate) {
  if (h.previous === 0 && h.value === 0) return { text: 'no change', color: C.faint };
  const d = h.delta;
  if (d === 0) return { text: 'same as before', color: C.faint };
  const abs = isRate ? `${Math.abs(d)} pts` : n(Math.abs(d));
  return d > 0 ? { text: `+${abs} vs before`, color: C.up } : { text: `-${abs} vs before`, color: C.down };
}

function renderReportPdf(stats, { name = '', email = '' } = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: M, bufferPages: true, info: { Title: `Outreach report ${labelFor({ from: new Date(stats.period.from), to: new Date(stats.period.to) })}`, Author: 'Outreach' } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width - M * 2;
    const bottom = () => doc.page.height - M;
    const ensure = (h) => { if (doc.y + h > bottom()) doc.addPage(); };
    const section = (title) => {
      ensure(60);
      doc.moveDown(0.8);
      doc.font('Helvetica-Bold').fontSize(12).fillColor(C.ink).text(title, M, doc.y);
      const y = doc.y + 3;
      doc.moveTo(M, y).lineTo(M + W, y).lineWidth(0.5).strokeColor(C.rule).stroke();
      doc.y = y + 8;
    };
    const line = (label, value) => {
      ensure(18);
      const y = doc.y;
      doc.font('Helvetica').fontSize(10).fillColor(C.text).text(label, M, y, { width: W - 120 });
      doc.font('Helvetica-Bold').fillColor(C.ink).text(value, M + W - 120, y, { width: 120, align: 'right' });
      doc.y = Math.max(doc.y, y + 15);
    };
    const empty = (msg) => { doc.font('Helvetica-Oblique').fontSize(10).fillColor(C.faint).text(msg, M, doc.y); doc.moveDown(0.3); };

    const period = { from: new Date(stats.period.from), to: new Date(stats.period.to) };

    // ── Header ──
    doc.rect(0, 0, doc.page.width, 92).fill(C.accent);
    doc.font('Helvetica-Bold').fontSize(20).fillColor('#ffffff').text('Your outreach report', M, 30);
    doc.font('Helvetica').fontSize(11).fillColor('#e0e7ff')
      .text(`${labelFor(period)}${name ? '  ·  ' + name : ''}${email && !name ? '  ·  ' + email : ''}`, M, 58);
    doc.y = 116;

    // ── Headline tiles ──
    const tiles = [
      ['Emails sent', n(stats.headline.sent.value), deltaText(stats.headline.sent)],
      ['Replies', n(stats.headline.replies.value), deltaText(stats.headline.replies)],
      ['Reply rate', `${stats.headline.replyRate.value}%`, deltaText(stats.headline.replyRate, true)],
      ['Interviews', n(stats.headline.interviews.value), deltaText(stats.headline.interviews)],
    ];
    const gap = 10, tw = (W - gap * 3) / 4, ty = doc.y;
    tiles.forEach(([label, value, d], i) => {
      const x = M + i * (tw + gap);
      doc.roundedRect(x, ty, tw, 70, 6).fill(C.panel);
      doc.font('Helvetica').fontSize(9).fillColor(C.muted).text(label.toUpperCase(), x + 10, ty + 10, { width: tw - 20 });
      doc.font('Helvetica-Bold').fontSize(20).fillColor(C.ink).text(value, x + 10, ty + 24, { width: tw - 20 });
      doc.font('Helvetica').fontSize(8.5).fillColor(d.color).text(d.text, x + 10, ty + 51, { width: tw - 20 });
    });
    doc.y = ty + 82;
    doc.font('Helvetica').fontSize(8.5).fillColor(C.faint)
      .text(`Compared with the ${stats.period.days}-day period just before. Reply rate = replies received / emails sent in the period.`, M, doc.y, { width: W });

    // ── Chart: sent vs replies ──
    section(stats.series.unit === 'day' ? 'Day by day' : 'Week by week');
    {
      const pts = stats.series.points;
      const h = 120, top = doc.y + 4, baseY = top + h;
      ensure(h + 40);
      const max = Math.max(1, ...pts.map(p => Math.max(p.sent, p.replies)));
      const slot = W / Math.max(1, pts.length);
      const bw = Math.min(16, slot / 3);
      doc.moveTo(M, baseY).lineTo(M + W, baseY).lineWidth(0.5).strokeColor(C.rule).stroke();
      pts.forEach((p, i) => {
        const cx = M + slot * i + slot / 2;
        const hs = (p.sent / max) * h, hr = (p.replies / max) * h;
        if (hs > 0) doc.rect(cx - bw - 1, baseY - hs, bw, hs).fill(C.accent);
        if (hr > 0) doc.rect(cx + 1, baseY - hr, bw, hr).fill(C.reply);
        if (p.sent) doc.font('Helvetica').fontSize(7).fillColor(C.muted).text(String(p.sent), cx - bw - 6, baseY - hs - 10, { width: bw + 10, align: 'center' });
        const lab = stats.series.unit === 'day'
          ? new Date(`${p.day}T12:00:00+05:30`).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric' })
          : `w/c ${new Date(`${p.day}T12:00:00+05:30`).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' })}`;
        doc.font('Helvetica').fontSize(7.5).fillColor(C.muted).text(lab, cx - slot / 2, baseY + 4, { width: slot, align: 'center' });
      });
      const ly = baseY + 20;
      doc.rect(M, ly, 8, 8).fill(C.accent);
      doc.font('Helvetica').fontSize(8.5).fillColor(C.text).text('Emails sent', M + 12, ly - 1);
      doc.rect(M + 90, ly, 8, 8).fill(C.reply);
      doc.text('Replies', M + 102, ly - 1);
      doc.y = ly + 16;
    }

    // ── Replies by type ──
    section('Replies by type');
    if (!stats.replyCategories.length) empty('No replies in this period.');
    else {
      const max = Math.max(...stats.replyCategories.map(r => r.n));
      for (const r of stats.replyCategories) {
        ensure(18);
        const y = doc.y;
        doc.font('Helvetica').fontSize(10).fillColor(C.text).text(r.label, M, y, { width: 150 });
        doc.rect(M + 155, y + 2, Math.max(2, ((W - 205) * r.n) / max), 9).fill(C.reply);
        doc.font('Helvetica-Bold').fontSize(10).fillColor(C.ink).text(n(r.n), M + W - 40, y, { width: 40, align: 'right' });
        doc.y = y + 16;
      }
    }

    // ── Campaigns ──
    section('Campaigns');
    if (!stats.campaigns.length) empty('No campaign activity in this period.');
    else {
      const cols = [M, M + W - 210, M + W - 140, M + W - 70];
      ensure(16);
      const hy = doc.y;
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.muted);
      doc.text('CAMPAIGN', cols[0], hy); doc.text('STATUS', cols[1], hy, { width: 65 });
      doc.text('SENT', cols[2], hy, { width: 65, align: 'right' }); doc.text('REMAINING', cols[3], hy, { width: 70, align: 'right' });
      doc.y = hy + 14;
      for (const c of stats.campaigns.slice(0, 12)) {
        ensure(16);
        const y = doc.y;
        doc.font('Helvetica').fontSize(9.5).fillColor(C.ink).text(c.name, cols[0], y, { width: cols[1] - cols[0] - 8, lineBreak: false, ellipsis: true });
        doc.fillColor(C.text).text(c.finishedInPeriod ? 'finished' : c.status, cols[1], y, { width: 65 });
        doc.text(n(c.sent), cols[2], y, { width: 65, align: 'right' });
        doc.text(n(c.remaining), cols[3], y, { width: 70, align: 'right' });
        doc.y = y + 15;
      }
    }

    // ── Deliverability ──
    section('Deliverability');
    line('First emails sent', n(stats.outreach.firstSends));
    line('Follow-ups sent', n(stats.outreach.followUps));
    line('Bounced', n(stats.outreach.bounced));
    line('Failed to send', n(stats.outreach.failed));
    if (stats.headline.sent.value > 0 && stats.outreach.bounced / stats.headline.sent.value > 0.05) {
      doc.font('Helvetica-Oblique').fontSize(9).fillColor(C.down)
        .text('More than 5% of emails bounced. Check your contact list before sending more, it affects your Gmail reputation.', M, doc.y + 2, { width: W });
    }

    // ── By source ──
    if ((stats.bySource || []).length) {
      section('Results by source');
      for (const r of stats.bySource) line(r.label, `${n(r.sent)} sent · ${n(r.replies)} replies (${r.replyRate}%) · ${n(r.bounced)} bounced`);
    }

    // ── Pipeline ──
    section('Job pipeline');
    line('Leads added', n(stats.pipeline.leadsAdded));
    line('Leads applied to', n(stats.pipeline.leadsApplied));
    line('Naukri applications', n(stats.pipeline.naukriApplied));
    line('New interview entries', n(stats.pipeline.interviewsNew));
    for (const m of stats.pipeline.interviewMoves) line(`Interviews moved to "${m.status}"`, n(m.n));

    // ── Coming up ──
    section('Coming up');
    if (!stats.upcomingInterviews.length && !stats.waiting.count) empty('Nothing scheduled and no replies waiting on you.');
    for (const i of stats.upcomingInterviews) {
      line(`${[i.company, i.role].filter(Boolean).join(' · ') || i.name}${i.round ? ` (${i.round})` : ''}`, when(i.interviewAt, true));
    }
    if (stats.waiting.count) line('Replies waiting on you', n(stats.waiting.count));
    for (const w of stats.waiting.items) line(`  ${w.name}${w.company ? ' · ' + w.company : ''}`, w.categoryLabel);

    // ── Top replies ──
    section('Top replies');
    if (!stats.topReplies.length) empty('No replies in this period.');
    for (const r of stats.topReplies) line(`${r.name}${r.company ? ' · ' + r.company : ''}  (${when(r.repliedAt)})`, r.categoryLabel);

    // ── Footer on every page ──
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      // Writing inside the bottom margin would make pdfkit start a new page.
      doc.page.margins.bottom = 0;
      doc.font('Helvetica').fontSize(8).fillColor(C.faint).text(
        `Generated ${when(stats.generatedAt, true)} IST  ·  Page ${i + 1} of ${range.count}`,
        M, doc.page.height - M + 16, { width: W, align: 'center', lineBreak: false },
      );
    }
    doc.end();
  });
}

module.exports = { renderReportPdf };
