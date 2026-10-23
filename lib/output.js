'use strict';
const fs = require('fs');
const path = require('path');
const { nativeImage } = require('electron');
const { PDFDocument } = require('pdf-lib');

function safeName(s) {
  const n = String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return n || 'Storyboard';
}

async function writeOutputs({ outDir, title, pages, formats }) {
  const name = safeName(title);
  const dir = path.join(outDir, name);
  fs.mkdirSync(dir, { recursive: true });
  const files = [];

  if (formats.pdf) {
    const pdf = await PDFDocument.create();
    pdf.setTitle(name);
    pdf.setProducer('Board Daddy');
    for (const p of pages) {
      const jpg = nativeImage.createFromBuffer(p.png).toJPEG(92);
      const img = await pdf.embedJpg(jpg);
      const page = pdf.addPage([p.w, p.h]);
      page.drawImage(img, { x: 0, y: 0, width: p.w, height: p.h });
    }
    const f = path.join(dir, name + '.pdf');
    fs.writeFileSync(f, await pdf.save());
    files.push(f);
  }

  if (formats.png) {
    const pdir = path.join(dir, 'pages');
    fs.mkdirSync(pdir, { recursive: true });
    const pad = Math.max(3, String(pages.length).length);
    pages.forEach((p, i) => {
      const f = path.join(pdir, `page-${String(i + 1).padStart(pad, '0')}.png`);
      fs.writeFileSync(f, p.png);
    });
    files.push(pdir);
  }

  if (formats.text) {
    const body = pages.map((p, i) => `--- Page ${i + 1} ---\n${p.text || ''}`).join('\n\n');
    const f = path.join(dir, name + '.txt');
    fs.writeFileSync(f, body + '\n');
    files.push(f);
  }
  return { dir, files, pageCount: pages.length };
}

module.exports = { writeOutputs, safeName };
