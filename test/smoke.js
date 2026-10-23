'use strict';
// Headless smoke test of the capture engine against local fixtures.
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runJob } = require('../lib/capture');
const { writeOutputs } = require('../lib/output');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-smoke-'));

const slides = [1, 2, 3, 4, 5].map((n) => `<div class="s" style="display:${n === 1 ? 'block' : 'none'}"><h1>Slide ${n}</h1></div>`).join('');
fs.writeFileSync(path.join(tmp, 'paged.html'), `<!doctype html><body style="margin:0;font:60px sans-serif">
${slides}<button class="next" style="position:fixed;right:10px;bottom:10px">Next</button>
<script>let i=0;const s=[...document.querySelectorAll('.s')];
function go(d){if(i+d<0||i+d>=s.length)return;s[i].style.display='none';i+=d;s[i].style.display='block';document.body.style.background=['#fff','#fcc','#cfc','#ccf','#ffc'][i]}
addEventListener('keydown',e=>{if(e.key==='ArrowRight')go(1)});
document.querySelector('.next').onclick=()=>go(1);</script>`);

fs.writeFileSync(path.join(tmp, 'scroll.html'), `<!doctype html><title>Scroll Treatment</title><body style="margin:0;font:48px sans-serif">
${[1, 2, 3, 4].map((n) => `<section style="height:900px;background:hsl(${n * 70},70%,80%)">Section ${n}</section>`).join('')}`);

const gate = (inner) => `<!doctype html><title>Locked Deck</title><body style="margin:0;font:48px sans-serif">
<form id="g" style="padding:40px"><input type="password" id="pw" placeholder="password"><button type="submit">Open</button><p id="msg"></p></form>
<div id="content" style="display:none;padding:40px">SECRET CONTENT</div>
<script>document.getElementById('g').addEventListener('submit',e=>{e.preventDefault();
if(document.getElementById('pw').value==='sesame'){document.getElementById('g').remove();document.getElementById('content').style.display='block'}
else document.getElementById('msg').textContent='wrong password'})</script>`;
fs.writeFileSync(path.join(tmp, 'locked.html'), gate());
fs.writeFileSync(path.join(tmp, 'locked-frame.html'), `<!doctype html><body style="margin:0"><iframe style="width:780px;height:420px;border:0" srcdoc="${gate().replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></iframe>`);
// Strict + late gate: ignores programmatic input (isTrusted check) and appears after 2.5s,
// like a single-page app that renders its password prompt after loading.
fs.writeFileSync(path.join(tmp, 'locked-strict.html'), `<!doctype html><title>Strict Deck</title><body style="margin:0;font:48px sans-serif"><div id="app" style="padding:40px">Loading…</div>
<script>setTimeout(()=>{document.getElementById('app').innerHTML='<input type="password" id="pw" placeholder="password"><button id="go">View</button><p id="msg"></p>';
let v='';const pw=document.getElementById('pw');
pw.addEventListener('input',e=>{if(e.isTrusted)v=pw.value});
function tryIt(){if(v==='sesame'){document.getElementById('app').textContent='SECRET CONTENT'}else document.getElementById('msg').textContent='wrong'}
pw.addEventListener('keydown',e=>{if(e.key==='Enter')tryIt()});
document.getElementById('go').onclick=tryIt},2500)</script>`);
// Pitch-style gate: plain text box with a "Passcode" placeholder, Continue disabled until typed.
fs.writeFileSync(path.join(tmp, 'locked-passcode.html'), `<!doctype html><title>Passcode Deck</title><body style="margin:0;font:40px sans-serif"><div id="app" style="padding:40px">Loading…</div>
<script>setTimeout(()=>{const a=document.getElementById('app');a.innerHTML='<h2>This presentation requires a passcode</h2><input type="text" id="pc" placeholder="Passcode"><br><button id="c" disabled>Continue</button><p id="m"></p>';
const pc=document.getElementById('pc'),c=document.getElementById('c');let v='';
pc.addEventListener('input',e=>{if(e.isTrusted)v=pc.value;c.disabled=!v});
function go(){if(v==='Octane-test')a.textContent='SECRET CONTENT';else document.getElementById('m').textContent='Wrong passcode'}
pc.addEventListener('keydown',e=>{if(e.key==='Enter'&&v)go()});c.onclick=go},2000)</script>`);
app.on('window-all-closed', () => {});
(async () => {
  await app.whenReady();
  const fails = [];
  const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails.push(m); };
  const emit = () => {};
  try {
    const base = { width: 800, height: 450, scale: 1, maxPages: 20, settleMs: 600, wantText: true, autoSize: false };

    let r = await runJob({ ...base, url: 'file://' + path.join(tmp, 'paged.html'), mode: 'paged' }, emit, () => false);
    check(r.pages.length === 5, `paged captured ${r.pages.length} pages (expected 5)`);
    check(r.pages[0].text.includes('Slide 1') && r.pages[4].text.includes('Slide 5'), 'paged text extracted');
    const out = await writeOutputs({ outDir: path.join(tmp, 'out'), title: r.title || 'paged', pages: r.pages, formats: { pdf: true, png: true, text: true } });
    check(out.files.every((f) => fs.existsSync(f)), 'paged outputs written: ' + out.files.map((f) => path.basename(f)).join(', '));
    check(fs.readdirSync(path.join(out.dir, 'pages')).length === 5, 'paged PNG count');

    r = await runJob({ ...base, scale: 2, url: 'file://' + path.join(tmp, 'scroll.html'), mode: 'scroll' }, emit, () => false);
    check(r.pages.length >= 6, `scroll captured ${r.pages.length} sections (expected ~7)`);
    const { nativeImage } = require('electron');
    const sz = nativeImage.createFromBuffer(r.pages[0].png).getSize();
    check(sz.width === 1600, `2x scale output width ${sz.width} (expected 1600)`);

    r = await runJob({ ...base, url: 'file://' + path.join(tmp, 'scroll.html'), mode: 'auto' }, emit, () => false);
    check(r.pages.length >= 6, `auto-detect chose scroll (${r.pages.length} pages)`);

    // Password-protected pages
    const lockedUrl = 'file://' + path.join(tmp, 'locked.html');
    r = await runJob({ ...base, url: lockedUrl, mode: 'paged', password: 'sesame' }, emit, () => false);
    check(r.pages[0].text.includes('SECRET CONTENT'), 'correct password unlocks the page');
    let err = null;
    try { await runJob({ ...base, url: lockedUrl, mode: 'paged' }, emit, () => false); } catch (e) { err = e; }
    check(err && /password protected/i.test(err.message), 'missing password gives a clear error');
    err = null;
    try { await runJob({ ...base, url: lockedUrl, mode: 'paged', password: 'nope' }, emit, () => false); } catch (e) { err = e; }
    check(err && /not accepted/i.test(err.message) && !err.message.includes('nope'), 'wrong password gives a clear error without echoing it');
    r = await runJob({ ...base, url: 'file://' + path.join(tmp, 'locked-frame.html'), mode: 'paged', password: 'sesame' }, emit, () => false);
    // passGate only returns once the password box has disappeared, so reaching here
    // means the gate inside the iframe was filled and accepted.
    check(r.pages.length >= 1, 'password gate inside an iframe is unlocked');

    // Strict, late-appearing gate (needs real typing and patience)
    const events = [];
    r = await runJob({ ...base, url: 'file://' + path.join(tmp, 'locked-strict.html'), mode: 'paged', password: 'sesame' }, (m) => events.push(m), () => false);
    check(r.pages[0].text.includes('SECRET CONTENT'), 'strict + late password gate unlocked with real typing');
    check(events.some((m) => m.thumb && m.phase === 'capture'), 'capture events carry preview thumbnails');
    check(!JSON.stringify(events).includes('sesame'), 'password never appears in progress events');

    // Pitch-style passcode box (type=text)
    r = await runJob({ ...base, url: 'file://' + path.join(tmp, 'locked-passcode.html'), mode: 'paged', password: 'Octane-test' }, emit, () => false);
    check(r.pages[0].text.includes('SECRET CONTENT'), 'text-type "Passcode" box is detected and unlocked');
    err = null;
    try { await runJob({ ...base, url: 'file://' + path.join(tmp, 'locked-passcode.html'), mode: 'paged', password: 'bad' }, emit, () => false); } catch (e) { err = e; }
    check(err && /not accepted/i.test(err.message), 'wrong passcode on text-type box is rejected');
  } catch (e) {
    console.log('ERROR ' + (e.stack || e));
    fails.push('exception');
  }
  console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASSED');
  app.exit(fails.length ? 1 : 0);
})();
