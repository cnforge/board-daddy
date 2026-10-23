'use strict';
// Local mock of Pitch (same hostnames over HTTPS via a CONNECT proxy): imgproxy originals,
// Mux HLS video, the editor slide list and the login wall. Used by pitch-smoke and e2e.
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const netm = require('net');
const { spawnSync } = require('child_process');

async function startPitchMock(tmp, partition) {
  const { session } = require('electron');
  const ff = (args) => spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args]);
  // ---- assets ----
  const A = path.join(tmp, 'assets'); fs.mkdirSync(A);
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=3000x2000', '-frames:v', '1', path.join(A, 'orig1.png')]);
  ff(['-f', 'lavfi', '-i', 'smptebars=s=2400x1600', '-frames:v', '1', '-q:v', '2', path.join(A, 'orig2.jpg')]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=600x400', '-frames:v', '1', path.join(A, 'small.jpg')]);
  ff(['-f', 'lavfi', '-i', 'color=c=gray:s=24x24', '-frames:v', '1', path.join(A, 'icon.png')]);
  const V = path.join(A, 'VID123'); fs.mkdirSync(V);
  for (const [n, s] of [['low', '640x360'], ['high', '1920x1080']]) {
    ff(['-f', 'lavfi', '-t', '3', '-i', `testsrc2=s=${s}:r=24`, '-f', 'lavfi', '-t', '3', '-i', 'sine=f=440', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      '-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'vod', '-hls_segment_filename', path.join(V, n + '%d.ts'), path.join(V, n + '.m3u8')]);
  }
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=600000,RESOLUTION=640x360\nVID123/low.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080\nVID123/high.m3u8\n';
  const U1 = 'pitch-assets-aaaa/11111111-1111-1111-1111-111111111111';
  const U2 = 'pitch-assets-aaaa/22222222-2222-2222-2222-222222222222';
  const U3 = 'pitch-assets-aaaa/33333333-3333-3333-3333-333333333333'; // tiny logo: must be skipped
  const ip = (u, opts = 'w:1336/h:748/resizing_type:fit/q:50/format:avif') => `https://cdn2.imgproxy.services.pitch.com/_/${opts}/plain/${u}`;
  const editor = `<!doctype html><title>Mock Deck | Pitch</title><body style="margin:0;font:20px sans-serif">
  <div style="position:fixed;left:0;top:0;width:200px">${[1, 2, 3].map((n) => `<div data-test-id="editor-sidebar-slides-item" style="height:80px;border:1px solid #ccc" data-n="${n}">Slide ${n}</div>`).join('')}</div>
  <img src="https://app.pitch.com/static/app/logo.png" width=24>
  <div id="stage" style="margin-left:220px"></div>
  <script>
  const slides={1:'<img src="${ip(U1)}" width=600><img src="${ip(U3)}" width=24>',
   2:'<div style="width:600px;height:400px;background-image:url(${ip(U2)})"></div><iframe src="https://www.youtube-nocookie.com/embed/abc123"></iframe>',
   3:'<img src="https://image.mux.com/VID123/thumbnail.jpg?token=t1"><video id=v></video>'};
  function show(n){document.getElementById('stage').innerHTML=slides[n];if(n==3)fetch('https://stream.mux.com/VID123.m3u8?token=v1').then(r=>r.text())}
  document.querySelectorAll('[data-test-id="editor-sidebar-slides-item"]').forEach(e=>e.onclick=()=>show(+e.dataset.n));
  show(1);
  </script>`;

  const serve = (req, res) => {
    const host = (req.headers.host || '').split(':')[0];
    const u = new URL(req.url, 'https://' + host);
    const send = (type, file, extra = {}) => { const b = fs.readFileSync(file); res.writeHead(200, { 'Content-Type': type, 'Content-Length': b.length, 'Access-Control-Allow-Origin': '*', ...extra }); res.end(b); };
    if (/imgproxy\.services\.pitch\.com$/.test(host)) {
      const src = u.pathname.split('/plain/')[1];
      const orig = { [U1]: ['image/png', 'orig1.png'], [U2]: ['image/jpeg', 'orig2.jpg'], [U3]: ['image/png', 'icon.png'] }[src];
      if (!orig) { res.writeHead(404); return res.end(); }
      if (/\/raw:1\//.test(u.pathname)) return send(orig[0], path.join(A, orig[1]));
      if (src === U3) return send('image/png', path.join(A, 'icon.png'));
      return send('image/jpeg', path.join(A, 'small.jpg'));
    }
    if (host === 'image.mux.com') return send('image/jpeg', path.join(A, 'small.jpg'));
    if (host === 'stream.mux.com') {
      if (u.pathname === '/VID123.m3u8') { res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': '*' }); return res.end(master); }
      const f = path.join(A, u.pathname); if (fs.existsSync(f)) return send(f.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t', f);
    }
    if (host === 'app.pitch.com') {
      if (u.pathname.startsWith('/app/presentation/LOCKED')) { res.writeHead(302, { Location: 'https://auth.pitch.com/login' }); return res.end(); }
      if (u.pathname.startsWith('/app/presentation/')) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(editor); }
      if (u.pathname.startsWith('/static/')) return send('image/png', path.join(A, 'small.jpg'));
    }
    if (host === 'auth.pitch.com') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<title>Login to Pitch</title><input type=email placeholder="Work email"><button>Continue with email</button><button>Continue with Google</button>'); }
    if (/youtube/.test(host)) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<p>yt</p>'); }
    res.writeHead(404); res.end();
  };


  // TLS for every hostname via one self-signed cert; a CONNECT proxy routes all hosts to it.
  spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=mock', '-days', '2', '-keyout', path.join(tmp, 'k.pem'), '-out', path.join(tmp, 'c.pem')]);
  const tls = https.createServer({ key: fs.readFileSync(path.join(tmp, 'k.pem')), cert: fs.readFileSync(path.join(tmp, 'c.pem')) }, serve);
  await new Promise((r) => tls.listen(0, '127.0.0.1', r));
  const proxy = http.createServer((q, s) => { s.writeHead(400); s.end(); });
  proxy.on('connect', (req, sock, head) => {
    const up = netm.connect(tls.address().port, '127.0.0.1', () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.write(head); up.pipe(sock); sock.pipe(up); });
    up.on('error', () => sock.destroy()); sock.on('error', () => up.destroy());
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const pp = `127.0.0.1:${proxy.address().port}`;
  const ses = session.fromPartition(partition);
  await ses.setProxy({ proxyRules: `https=${pp};http=${pp}` });
  ses.setCertificateVerifyProc((_r, cb) => cb(0));
  process.env.http_proxy = 'http://' + pp; process.env.https_proxy = 'http://' + pp; // ffmpeg

  return { A, ses, close: () => { tls.close(); proxy.close(); } };
}
module.exports = { startPitchMock };
