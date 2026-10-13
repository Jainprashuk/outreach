#!/usr/bin/env node
// Parity: harvester imports must store exactly what they did before the Leads
// sources change. Runs explodeLead from `main` and from the working tree over real
// harvester files and compares every row. No database.
//
//   node scripts/leadimport-parity.js [file.json …]
//   (default: ../linkdin-post/data/*.json and ../linkdin-post/dump/*.json)

const fs = require('fs');
const path = require('path');
const Module = require('module');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const target = path.join(root, 'lib/leadImport.js');

function loadFrom(ref) {
  const src = execSync(`git show ${ref}:lib/leadImport.js`, { cwd: root }).toString();
  const m = new Module(target, module);
  m.filename = target;
  m.paths = Module._nodeModulePaths(path.dirname(target));
  m._compile(src, target);
  return m.exports;
}

const before = loadFrom(process.env.PARITY_REF || 'main');
const after = require('../lib/leadImport');

const defaults = ['data', 'dump'].flatMap(d => {
  const dir = path.join(root, '..', 'linkdin-post', d);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => path.join(dir, f)) : [];
});
const files = process.argv.slice(2).length ? process.argv.slice(2) : defaults;

let rows = 0;
let diffs = 0;
for (const file of files) {
  let body;
  try { body = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.log(`skip ${file}: ${e.message}`); continue; }
  const a = before.readSourceLeads(body).source.flatMap(before.explodeLead);
  const b = after.readSourceLeads(body).source.flatMap(after.explodeLead);
  if (a.length !== b.length) { diffs++; console.log(`✗ ${file}: ${a.length} rows before, ${b.length} after`); continue; }
  for (let i = 0; i < a.length; i++) {
    rows++;
    const x = JSON.stringify(a[i]);
    const y = JSON.stringify(b[i]);
    if (x !== y || before.dedupeKeyFor(a[i]) !== after.dedupeKeyFor(b[i])) {
      diffs++;
      if (diffs <= 5) console.log(`✗ ${path.basename(file)} row ${i}\n  before ${x}\n  after  ${y}`);
    }
  }
  console.log(`${path.basename(file)}: ${a.length} rows compared`);
}
console.log(`\n${rows} rows, ${diffs} differences`);
process.exit(diffs ? 1 : 0);
