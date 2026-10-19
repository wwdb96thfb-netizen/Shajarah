#!/usr/bin/env node
// Shajrah server. Runs on the owner's Mac, beside the GD server.
// Holds the family tree. Phones reach it through a Cloudflare tunnel whose address is announced
// on a private ntfy topic. Phones keep a copy of the tree and a waiting list of new entries,
// and send the waiting list whenever they have internet. No external packages needed.
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os');
const { spawn } = require('child_process');

const VERSION = 1;
const ROOT = __dirname, DATA = path.join(ROOT, 'data'), BACK = path.join(DATA, 'backups');
const CFG = path.join(DATA, 'config.json'), TREE = path.join(DATA, 'tree.json'), HIST = path.join(DATA, 'history.jsonl');
const APP_URL = process.env.SJ_APP_URL || 'https://wwdb96thfb-netizen.github.io/Shajarah/';
const RAW = process.env.SJ_RAW || 'https://raw.githubusercontent.com/wwdb96thfb-netizen/Shajarah/main/server/';
const PORT = +process.env.SJ_PORT || 8790;
const CLAUDE = process.env.CLAUDE_BIN || 'claude';
const log = (...a) => console.log(new Date().toLocaleString('en-GB'), ...a);

fs.mkdirSync(BACK, { recursive: true });
const rnd = n => { const A = 'abcdefghjkmnpqrstuvwxyz23456789'; let s = ''; const b = crypto.randomBytes(n); for (let i = 0; i < n; i++) s += A[b[i] % A.length]; return s; };
const idOf = code => crypto.createHash('sha256').update(String(code)).digest('hex').slice(0, 16);
const writeJSON = (f, o) => { fs.writeFileSync(f + '.tmp', JSON.stringify(o)); fs.renameSync(f + '.tmp', f); };

// ---- settings: the owner, the people with personal links, and which phone each link is tied to
let cfg;
try { cfg = JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch (e) { cfg = { topic: 'sj' + rnd(22), ownerCode: rnd(16), people: [] }; }
if (!cfg.devs) cfg.devs = {};
if (!cfg.urdu) cfg.urdu = {};
const saveCfg = () => writeJSON(CFG, cfg);
saveCfg();

// ---- the tree: people (approved = locked, pending = new from family) and suggestions
let tree;
try { tree = JSON.parse(fs.readFileSync(TREE, 'utf8')); }
catch (e) {
  tree = { ver: 1, people: {}, suggestions: [] };
  try { const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'seed.json'), 'utf8')); Object.assign(tree, { people: seed.people || {}, start: seed.start, me: seed.me }); log('Loaded', Object.keys(tree.people).length, 'names from seed.json'); }
  catch (x) { log('No seed.json found: starting with an empty tree.'); }
}
if (!Array.isArray(tree.suggestions)) tree.suggestions = [];
const dayOf = () => new Date().toLocaleDateString('en-CA');
// A copy of the whole tree is kept for every day on which something changed (the last 120 days).
function dailyBackup() {
  const f = path.join(BACK, 'tree-' + dayOf() + '.json');
  if (fs.existsSync(f)) return;
  try { if (fs.existsSync(TREE)) fs.copyFileSync(TREE, f); else writeJSON(f, tree); } catch (e) {}
  try { const L = fs.readdirSync(BACK).filter(x => /^tree-[\d-]+\.json$/.test(x)).sort(); while (L.length > 120) fs.unlinkSync(path.join(BACK, L.shift())); } catch (e) {}
}
const saveTree = () => { tree.ver = (tree.ver || 0) + 1; writeJSON(TREE, tree); };
saveTree();
const history = (who, action, id, before, after) => {
  try { fs.appendFileSync(HIST, JSON.stringify({ at: new Date().toISOString(), who, action, id: id || '', before: before || '', after: after || '' }) + '\n'); } catch (e) {}
};

// ---- who is asking
const who = code => {
  if (!code) return null;
  if (code === cfg.ownerCode) return { name: cfg.ownerName || 'Iftikhar', role: 'owner', owner: true, code };
  const p = cfg.people.find(x => x.code === code);
  if (!p) return null;
  return { name: p.name, role: p.role === 'viewer' ? 'viewer' : 'family', code, cancelled: !!p.cancelled };
};
const clip = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const nameOf = id => (tree.people[id] && tree.people[id].name) || '';
const kidsOf = id => Object.keys(tree.people).filter(k => tree.people[k].parent === id);
const nextOrder = parent => kidsOf(parent).reduce((m, k) => Math.max(m, Number(tree.people[k].order) || 0), -1) + 1;
const isAncestor = (a, of) => { let c = of, g = 0; while (c && g++ < 600) { if (c === a) return true; c = tree.people[c] && tree.people[c].parent; } return false; };

// ---- English letters to Urdu script
const DICT = {
  syed: 'سید', sayed: 'سید', sayyid: 'سید', sayyed: 'سید', saiyid: 'سید', syeda: 'سیدہ', sayeda: 'سیدہ', sayyida: 'سیدہ',
  shah: 'شاہ', bibi: 'بی بی', begum: 'بیگم', khan: 'خان', mir: 'میر', pir: 'پیر',
  muhammad: 'محمد', mohammad: 'محمد', muhammed: 'محمد', mohammed: 'محمد', mohd: 'محمد', md: 'محمد',
  ahmed: 'احمد', ahmad: 'احمد', ali: 'علی', hussain: 'حسین', husain: 'حسین', hussein: 'حسین', hassan: 'حسن', hasan: 'حسن',
  abbas: 'عباس', abdullah: 'عبداللہ', fatima: 'فاطمہ', fatimah: 'فاطمہ', zainab: 'زینب', ayesha: 'عائشہ', aisha: 'عائشہ',
  maryam: 'مریم', mariam: 'مریم', imran: 'عمران', usman: 'عثمان', umar: 'عمر', omar: 'عمر', zain: 'زین', iftikhar: 'افتخار',
  mustafa: 'مصطفیٰ', haider: 'حیدر', hyder: 'حیدر', raza: 'رضا', jafar: 'جعفر', jaffar: 'جعفر', qasim: 'قاسم', kazim: 'کاظم',
  bukhari: 'بخاری', gillani: 'گیلانی', gilani: 'گیلانی', noor: 'نور', nur: 'نور', allah: 'اللہ', ullah: 'اللہ',
  aayan: 'آیان', ayan: 'آیان', salman: 'سلمان', ibrahim: 'ابراہیم', ismail: 'اسماعیل', yousaf: 'یوسف', yusuf: 'یوسف'
};
const hasLatin = s => /[A-Za-z]/.test(s);
const keyOf = w => w.toLowerCase().replace(/[^a-z]/g, '');
function claudeWords(words) {   // one call for all unknown words, using the Claude account signed in on this Mac
  return new Promise(resolve => {
    const prompt = 'Transliterate each of these words from Pakistani personal names (a Syed family tree, Urdu) from English letters into Urdu script, the way the name is normally written in Urdu. ' +
      'Reply with ONLY a JSON object mapping each input word exactly as given to its Urdu spelling, nothing else.\n\nWords: ' + JSON.stringify(words);
    let out = '', done = false;
    let ch; try { ch = spawn(CLAUDE, ['-p', prompt, '--output-format', 'json', '--permission-mode', 'dontAsk', '--disallowedTools', 'Bash', '--model', 'haiku'], { stdio: ['ignore', 'pipe', 'pipe'], cwd: os.tmpdir() }); }
    catch (e) { return resolve({}); }
    const t = setTimeout(() => { if (!done) { done = true; try { ch.kill('SIGKILL'); } catch (e) {} resolve({}); } }, 45e3);
    ch.stdout.on('data', d => out += d); ch.on('error', () => { if (!done) { done = true; clearTimeout(t); resolve({}); } });
    ch.on('close', () => { if (done) return; done = true; clearTimeout(t);
      try { const j = JSON.parse(out), txt = typeof j.result === 'string' ? j.result : out, a = txt.indexOf('{'), b = txt.lastIndexOf('}'); const m = JSON.parse(txt.slice(a, b + 1)); resolve(m && typeof m === 'object' ? m : {}); } catch (e) { resolve({}); } });
  });
}
async function googleWord(w) {   // fallback: Google's Urdu typing tool
  try { const r = await fetch('https://inputtools.google.com/request?text=' + encodeURIComponent(w) + '&itc=ur-t-i0-und&num=1&cp=0&cs=1&ie=utf-8&oe=utf-8&app=shajrah', { signal: AbortSignal.timeout(8000) });
    const j = await r.json(); return j[0] === 'SUCCESS' ? (j[1][0][1][0] || '') : ''; } catch (e) { return ''; }
}
async function toUrduAll(names) {
  const need = new Set();
  names.forEach(n => n.split(' ').forEach(w => { const k = keyOf(w); if (hasLatin(w) && k && !DICT[k] && !cfg.urdu[k]) need.add(k); }));
  if (need.size) {
    const list = [...need].slice(0, 60), got = await claudeWords(list);
    for (const k of list) {
      let u = clip(got[k] || got[k.charAt(0).toUpperCase() + k.slice(1)] || '', 40);
      if (!u || hasLatin(u) || !/[؀-ۿ]/.test(u)) u = clip(await googleWord(k), 40);
      if (u && !hasLatin(u) && /[؀-ۿ]/.test(u)) cfg.urdu[k] = u;
    }
    saveCfg();
  }
  return names.map(n => n.split(' ').map(w => { if (!hasLatin(w)) return w; const k = keyOf(w); return DICT[k] || cfg.urdu[k] || w; }).join(' '));
}

// ---- changes sent by phones (each one once, even if the phone sends it again)
const ID = /^[a-z0-9]{6,32}$/;
async function applyOps(user, ops) {
  const out = [];
  // convert every English name in this batch in one go
  const texts = ops.filter(o => o && (o.op === 'add' || o.op === 'edit') && typeof o.name === 'string').map(o => clip(o.name, 80));
  const conv = texts.some(hasLatin) ? await toUrduAll(texts) : texts; let ci = 0;
  let changed = false;
  for (const o of ops) {
    if (!o || typeof o !== 'object') { out.push({ error: 'bad' }); continue; }
    const urdu = (o.op === 'add' || o.op === 'edit') && typeof o.name === 'string' ? conv[ci++] : '';
    try { const r = applyOne(user, o, urdu); if (r.changed) changed = true; out.push(r.res || { ok: true }); }
    catch (e) { out.push({ error: String(e.message || e) }); }
  }
  if (changed) saveTree();
  return out;
}
function applyOne(user, o, urdu) {
  const owner = !!user.owner, P = tree.people;
  const need = c => { if (!c) throw new Error(user.role === 'viewer' ? 'Restricted: you can only view and suggest.' : 'Only Iftikhar can do this.'); };
  if (o.op === 'add') {
    need(owner || user.role === 'family');
    if (!ID.test(String(o.id || ''))) throw new Error('bad id');
    if (P[o.id]) return { res: { ok: true, id: o.id, name: P[o.id].name } };   // already received
    if (!P[o.parent]) throw new Error('The father of this entry is no longer in the tree.');
    const typed = clip(o.name, 80); if (!typed && !owner) throw new Error('The name was empty.');
    dailyBackup();
    P[o.id] = { name: clip(urdu || typed, 80), parent: o.parent, order: nextOrder(o.parent), g: o.g === 'f' ? 'f' : 'm', note: '', star: '', spouse: '', guess: '',
      status: owner ? 'approved' : 'pending', added_by: user.name, added_code: idOf(user.code), added_at: new Date().toISOString(), typed };
    history(user.name, 'added ' + (o.g === 'f' ? 'daughter' : 'son'), o.id, '', P[o.id].name + ' (under ' + nameOf(o.parent) + ')');
    log(user.name, 'added', P[o.id].name, 'under', nameOf(o.parent), owner ? '' : '(waiting for approval)');
    return { changed: true, res: { ok: true, id: o.id, name: P[o.id].name } };
  }
  if (o.op === 'edit') {
    const x = P[o.id]; if (!x) throw new Error('This name is no longer in the tree.');
    if (!owner) { if (x.status !== 'pending' || x.added_code !== idOf(user.code)) throw new Error('Names already in the Shajrah are locked. Send a suggestion instead.'); }
    const typed = clip(o.name, 80); if (!typed && !owner) throw new Error('The name was empty.');
    const before = x.name; dailyBackup();
    x.name = clip(urdu || typed, 80); x.typed = typed;
    if (owner && typeof o.note === 'string') x.note = clip(o.note, 200);
    if (before !== x.name) history(user.name, owner ? 'changed name' : 'corrected own new entry', o.id, before, x.name);
    return { changed: true, res: { ok: true, id: o.id, name: x.name } };
  }
  if (o.op === 'suggest') {
    if (!ID.test(String(o.sid || ''))) throw new Error('bad id');
    if (tree.suggestions.some(s => s.sid === o.sid)) return {};
    const text = clip(o.text, 600); if (!text) throw new Error('The suggestion was empty.');
    const kind = { name: 'Wrong spelling', father: 'Wrong father', other: 'Other' }[o.kind] || 'Other';
    tree.suggestions.push({ sid: o.sid, person: String(o.person || ''), person_name: nameOf(o.person), kind, text, by: user.name, at: new Date().toISOString(), done: false });
    history(user.name, 'suggestion: ' + kind, o.person, nameOf(o.person), text);
    log(user.name, 'sent a suggestion about', nameOf(o.person));
    return { changed: true };
  }
  need(owner);   // everything below is the owner's alone
  if (o.op === 'set') {
    const x = P[o.id]; if (!x) throw new Error('This name is no longer in the tree.');
    const f = o.f || {}; dailyBackup();
    if ('parent' in f) { if (!P[f.parent]) throw new Error('That father is not in the tree.'); if (f.parent === o.id || isAncestor(o.id, f.parent)) throw new Error('That would make him his own ancestor.');
      history('owner', 'changed father', o.id, nameOf(x.parent), nameOf(f.parent)); x.parent = f.parent; x.order = 'order' in f ? Number(f.order) || 0 : nextOrder(f.parent); }
    if ('order' in f && !('parent' in f)) x.order = Number(f.order) || 0;
    if ('g' in f) { x.g = f.g === 'f' ? 'f' : 'm'; history('owner', 'changed son/daughter', o.id, '', x.g === 'f' ? 'daughter' : 'son'); }
    if ('star' in f) x.star = ['p', 'k'].indexOf(f.star) >= 0 ? f.star : '';
    if ('spouse' in f) x.spouse = P[f.spouse] ? f.spouse : '';
    return { changed: true };
  }
  if (o.op === 'approve') {
    const x = P[o.id]; if (!x) throw new Error('This entry is no longer in the tree.');
    if (x.status !== 'pending') return {};
    if (!P[x.parent] || P[x.parent].status === 'pending') throw new Error('Approve his father first.');
    dailyBackup(); x.status = 'approved'; x.approved_at = new Date().toISOString();
    history('owner', 'approved', o.id, '', x.name + ' (added by ' + x.added_by + ')');
    return { changed: true };
  }
  if (o.op === 'reject' || o.op === 'delete') {
    const x = P[o.id]; if (!x) return {};
    if (kidsOf(o.id).length) throw new Error('Remove his children first.');
    if (o.op === 'reject' && x.status !== 'pending') throw new Error('Only new entries can be rejected.');
    dailyBackup(); history('owner', o.op === 'reject' ? 'rejected new entry' : 'deleted', o.id, JSON.stringify(x).slice(0, 400), '');
    delete P[o.id]; return { changed: true };
  }
  if (o.op === 'resolve') {
    const s = tree.suggestions.find(y => y.sid === o.sid); if (!s) return {};
    s.done = true; s.done_at = new Date().toISOString(); return { changed: true };
  }
  throw new Error('Unknown change.');
}

// ---- what a phone gets: the tree (and, for the owner, the suggestions)
function treeFor(user) {
  const people = {};
  for (const k in tree.people) { const x = tree.people[k]; people[k] = { name: x.name, parent: x.parent, order: x.order, g: x.g || '', note: x.note || '', star: x.star || '', spouse: x.spouse || '', guess: x.guess || '',
    pend: x.status === 'pending' ? 1 : 0, by: x.status === 'pending' ? x.added_by : '', mine: x.status === 'pending' && x.added_code === idOf(user.code) ? 1 : 0 }; }
  const o = { ok: true, ver: tree.ver, people, start: tree.start || 'p0084', me: { name: user.name, role: user.role, owner: !!user.owner } };
  if (user.owner) o.suggestions = tree.suggestions.filter(s => !s.done);
  return o;
}

// ---- web API
const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
const body = req => new Promise((resolve, reject) => { const ch = []; let n = 0; req.on('data', d => { n += d.length; if (n > 512e3) { reject(new Error('big')); req.destroy(); } else ch.push(d); }); req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(ch).toString('utf8') || '{}')); } catch (e) { resolve({}); } }); req.on('error', reject); });
const pinFails = new Map();
const pinHash = pin => crypto.createHash('sha256').update(cfg.ownerCode + ':' + pin).digest('hex');
const link = code => APP_URL + '?t=' + cfg.topic + '&c=' + code + (publicUrl ? '&s=' + publicUrl.replace('https://', '') : '');
const isLocal = req => !req.headers['cf-connecting-ip'] && !req.headers['x-forwarded-for'] && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].indexOf(req.socket.remoteAddress) >= 0;

async function handle(req, res) {
  const u = new URL(req.url, 'http://x'), p = u.pathname.split('/').filter(Boolean);
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type,x-code,x-dev,x-pin');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (p[0] !== 'api') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('Shajrah server is running.'); }
  // lets the app make sure this is the real server before it sends its code
  if (p[1] === 'hello') {
    const n = u.searchParams.get('n') || '', uid = u.searchParams.get('u') || '';
    if (!/^[a-f0-9]{16,64}$/.test(n)) return send(res, 404, { error: 'unknown' });
    const code = [cfg.ownerCode].concat(cfg.people.filter(x => !x.cancelled).map(x => x.code)).find(c => idOf(c) === uid);
    if (!code) return send(res, 404, { error: 'unknown', gone: crypto.createHmac('sha256', cfg.topic).update(n + ':' + uid).digest('hex') });
    return send(res, 200, { ok: true, proof: crypto.createHmac('sha256', code).update(n).digest('hex'), version: VERSION });
  }
  const user = who(String(req.headers['x-code'] || ''));
  if (!user) return send(res, 401, { error: 'code' });
  if (user.cancelled) return send(res, 401, { error: 'cancelled' });
  // One phone per link: the first phone that opens it is remembered; any other phone is refused.
  const dk = idOf(user.code), dev = String(req.headers['x-dev'] || '');
  if (user.owner && cfg.devs[dk] && fs.existsSync(path.join(ROOT, 'RESET-DEVICE.txt'))) { delete cfg.devs[dk]; saveCfg(); try { fs.unlinkSync(path.join(ROOT, 'RESET-DEVICE.txt')); } catch (e) {} log('Owner phone lock released with RESET-DEVICE.txt'); }
  if (!/^[a-f0-9]{24,64}$/.test(dev)) return send(res, 401, { error: 'device' });
  if (!cfg.devs[dk]) { cfg.devs[dk] = { id: dev, at: new Date().toISOString() }; saveCfg(); log(user.name, 'opened the link: it is now tied to this phone.'); history(user.name, 'opened personal link', '', '', ''); }
  else if (cfg.devs[dk].id !== dev) { log('REFUSED: another phone tried to use the link of', user.name); return send(res, 401, { error: 'device' }); }
  cfg.devs[dk].seen = new Date().toISOString();
  // The owner also has a PIN. Without it his link alone opens nothing.
  if (user.owner) {
    if (cfg.ownerPin && fs.existsSync(path.join(ROOT, 'RESET-PIN.txt'))) { delete cfg.ownerPin; saveCfg(); try { fs.unlinkSync(path.join(ROOT, 'RESET-PIN.txt')); } catch (e) {} log('Owner PIN reset with RESET-PIN.txt'); }
    const f = pinFails.get('o') || { n: 0, at: 0 }; if (Date.now() - f.at > 15 * 60e3) f.n = 0;
    if (p[1] === 'pin' && req.method === 'POST') {
      const b = await body(req), pin = String(b.pin || '');
      if (!/^\d{4,8}$/.test(pin)) return send(res, 400, { error: 'form' });
      if (cfg.ownerPin && cfg.ownerPin !== pinHash(String(req.headers['x-pin'] || ''))) return send(res, 401, { error: 'pin' });
      cfg.ownerPin = pinHash(pin); saveCfg(); log('Owner PIN set.'); return send(res, 200, { ok: true });
    }
    if (!cfg.ownerPin) return send(res, 401, { error: 'setpin' });
    if (f.n >= 8) return send(res, 401, { error: 'pin', locked: true });
    if (cfg.ownerPin !== pinHash(String(req.headers['x-pin'] || ''))) { f.n++; f.at = Date.now(); pinFails.set('o', f); log('Wrong owner PIN'); return send(res, 401, { error: 'pin', locked: f.n >= 8 }); }
    pinFails.delete('o');
  }
  if (p[1] === 'tree' && req.method === 'GET') {
    if (u.searchParams.get('v') === String(tree.ver)) return send(res, 200, { ok: true, same: true, ver: tree.ver, me: { name: user.name, role: user.role, owner: !!user.owner } });
    return send(res, 200, treeFor(user));
  }
  if (p[1] === 'sync' && req.method === 'POST') {
    const b = await body(req), ops = Array.isArray(b.ops) ? b.ops.slice(0, 100) : [];
    const results = await applyOps(user, ops);
    return send(res, 200, Object.assign(treeFor(user), { results }));
  }
  if (!user.owner) return send(res, 403, { error: 'owner' });
  if (p[1] === 'people' && req.method === 'GET') {
    return send(res, 200, { ok: true, people: cfg.people.map(x => ({ code: x.code, name: x.name, role: x.role, cancelled: !!x.cancelled, opened: !!cfg.devs[idOf(x.code)], seen: (cfg.devs[idOf(x.code)] || {}).seen || '', link: link(x.code) })) });
  }
  if (p[1] === 'people' && !p[2] && req.method === 'POST') {
    const b = await body(req), name = clip(b.name, 40); if (!name) return send(res, 400, { error: 'name' });
    const x = { name, code: rnd(16), role: b.role === 'viewer' ? 'viewer' : 'family', added: new Date().toISOString() };
    cfg.people.push(x); saveCfg(); writeLinks(); history('owner', 'made a personal link', '', '', name + ' (' + x.role + ')'); log('Personal link made for', name);
    return send(res, 200, { ok: true, link: link(x.code), code: x.code });
  }
  if (p[1] === 'people' && p[2] && req.method === 'POST') {
    const x = cfg.people.find(y => y.code === p[2]); if (!x) return send(res, 404, { error: 'none' });
    const b = await body(req);
    if (p[3] === 'cancel') { x.cancelled = true; history('owner', 'cancelled access', '', '', x.name); }
    else if (p[3] === 'restore') { delete x.cancelled; history('owner', 'restored access', '', '', x.name); }
    else if (p[3] === 'role') x.role = b.role === 'viewer' ? 'viewer' : 'family';
    else if (p[3] === 'renew') {   // new phone: a fresh link; the old link and old phone stop working
      delete cfg.devs[idOf(x.code)]; x.code = rnd(16); delete x.cancelled; history('owner', 'new link (new phone)', '', '', x.name);
    } else return send(res, 400, { error: 'what' });
    saveCfg(); writeLinks(); return send(res, 200, { ok: true, link: link(x.code) });
  }
  if (p[1] === 'history' && req.method === 'GET') {
    let L = []; try { L = fs.readFileSync(HIST, 'utf8').trim().split('\n').slice(-300).reverse().map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) {}
    return send(res, 200, { ok: true, history: L });
  }
  return send(res, 404, { error: 'none' });
}
const server = http.createServer((req, res) => { handle(req, res).catch(e => { log('error:', e.message); try { send(res, 500, { error: 'server' }); } catch (x) {} }); });

// ---- updates: new server versions are taken from GitHub by themselves
let pending = null;
async function selfUpdate() {
  if (process.env.SJ_NO_UPDATE) return;
  try {
    const r = await fetch(RAW + 'server.js?_=' + Date.now(), { signal: AbortSignal.timeout(20000) }); if (!r.ok) return;
    const t = await r.text(); if (t.length < 4000 || t.indexOf('Shajrah server') < 0 || t === fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')) return;
    const tmp = path.join(os.tmpdir(), 'sj-update.js'); fs.writeFileSync(tmp, t);
    const ok = await new Promise(res => { const c = spawn(process.execPath, ['--check', tmp], { stdio: 'ignore' }); c.on('close', code => res(code === 0)); c.on('error', () => res(false)); });
    if (!ok) { log('An update was found but failed its check. Keeping the current version.'); return; }
    fs.writeFileSync(path.join(ROOT, 'server.js.tmp'), t); fs.renameSync(path.join(ROOT, 'server.js.tmp'), path.join(ROOT, 'server.js'));
    log('Updated the server. Restarting.'); process.exit(0);
  } catch (e) {}
}
setInterval(selfUpdate, 10 * 60e3); setTimeout(selfUpdate, 60e3);

// ---- public address: Cloudflare quick tunnel, announced on a private ntfy topic so phones can find it
let publicUrl = '', tunnelProc = null;
function writeLinks() {
  const L = ['SHAJRAH links. Keep this file private.', '', 'YOUR OWNER LINK (open it on your own phone only):', link(cfg.ownerCode), '',
    'If you change your phone: put an empty file named RESET-DEVICE.txt in this folder, then open your link on the new phone.',
    'If you forget your PIN: put an empty file named RESET-PIN.txt in this folder, then open the app and choose a new PIN.', '', 'Family links:'];
  cfg.people.forEach(x => L.push(x.name + (x.cancelled ? ' (cancelled)' : x.role === 'viewer' ? ' (view only)' : '') + ': ' + link(x.code)));
  fs.writeFileSync(path.join(ROOT, 'LINKS.txt'), L.join('\n') + '\n');
}
async function announce() {
  if (!publicUrl) return false;
  try { const r = await fetch('https://ntfy.sh/' + cfg.topic, { method: 'POST', body: publicUrl, signal: AbortSignal.timeout(15000) }); return r.ok; }
  catch (e) { log('Could not tell phones the new address:', e.message); return false; }
}
setInterval(announce, 20 * 60e3);
let tunnelFails = 0, tunnelStart = 0;
function tunnel() {
  let ch; tunnelStart = Date.now();
  try { ch = tunnelProc = spawn('cloudflared', ['tunnel', '--url', 'http://localhost:' + PORT, '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { log('cloudflared could not start:', e.message); return; }
  const seen = d => { const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && m[0] !== publicUrl && m[0] !== 'https://api.trycloudflare.com') { publicUrl = m[0]; writeLinks(); log('Public address:', publicUrl); announce().then(ok => ok && log('Phones have been told the new address.')); } };
  ch.stdout.on('data', seen); ch.stderr.on('data', seen);
  ch.on('error', e => log(e.code === 'ENOENT' ? 'cloudflared is not installed.' : 'cloudflared error: ' + e.message));
  ch.on('close', () => { publicUrl = ''; tunnelFails = Date.now() - tunnelStart < 120e3 ? tunnelFails + 1 : 0; const wait = Math.min(300, 15 * Math.pow(2, Math.min(tunnelFails, 5))); log('Tunnel stopped. Restarting in', wait, 'seconds.'); setTimeout(tunnel, wait * 1e3); });
  if (!tunnel.hook) { tunnel.hook = true; process.on('exit', () => { try { tunnelProc && tunnelProc.kill(); } catch (e) {} }); }
}
// Watchdog: after the Mac sleeps the old address often dies; get a new one.
let lastTick = Date.now(), bad = 0;
setInterval(async () => {
  const gap = Date.now() - lastTick; lastTick = Date.now();
  if (!publicUrl || process.env.SJ_NO_TUNNEL) return;
  try { const r = await fetch(publicUrl + '/', { signal: AbortSignal.timeout(12000) }); if (!r.ok) throw new Error('status ' + r.status); bad = 0; if (gap > 6 * 60e3) announce(); }
  catch (e) { bad++; if (bad >= (gap > 6 * 60e3 ? 1 : 3)) { bad = 0; log('The public address stopped answering. Getting a new one.'); try { tunnelProc && tunnelProc.kill(); } catch (x) {} } }
}, 2 * 60e3);
if (process.platform === 'darwin') { try { spawn('caffeinate', ['-i', '-s', '-w', String(process.pid)], { stdio: 'ignore' }).on('error', () => {}); } catch (e) {} }
server.on('error', e => { if (e.code === 'EADDRINUSE') { log('Another Shajrah server is already running. This copy will stop.'); setTimeout(() => process.exit(1), 60e3); } else log('server error:', e.message); });
process.on('SIGINT', () => process.exit(0)); process.on('SIGTERM', () => process.exit(0));
server.listen(PORT, '127.0.0.1', () => {
  log('Shajrah server v' + VERSION + ' started with', Object.keys(tree.people).length, 'names.');
  writeLinks(); if (!process.env.SJ_NO_TUNNEL) tunnel();
});
module.exports = { applyOps, toUrduAll };
