const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const multer = require('multer');
const XLSX = require('xlsx');
const cors = require('cors');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const upload = multer({ storage: multer.memoryStorage() });

// ── WhatsApp Client ──
let client = null;
let qrCodeData = null;
let clientStatus = 'disconnected';
let sendingStatus = {
  running: false, paused: false,
  total: 0, sent: 0, failed: 0, skipped: 0,
  current: '', log: []
};

function getChromePath() {
  // Try environment variable first
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  // Try known Render path
  const renderPath = '/opt/render/project/src/.cache/puppeteer/chrome/linux-121.0.6167.85/chrome-linux64/chrome';
  if (fs.existsSync(renderPath)) return renderPath;
  // Try system chrome
  const systemPaths = [
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium'
  ];
  for (const p of systemPaths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function initClient() {
  clientStatus = 'loading';
  qrCodeData = null;

  const chromePath = getChromePath();
  console.log('Chrome path:', chromePath || 'using bundled');

  const puppeteerConfig = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-translate',
      '--mute-audio',
      '--safebrowsing-disable-auto-update'
    ]
  };

  if (chromePath) puppeteerConfig.executablePath = chromePath;

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: './wa-session' }),
    puppeteer: puppeteerConfig
  });

  client.on('qr', async (qr) => {
    console.log('QR received');
    clientStatus = 'qr';
    try { qrCodeData = await qrcode.toDataURL(qr); } catch(e) { console.error(e); }
  });

  client.on('ready', () => {
    console.log('WhatsApp ready!');
    clientStatus = 'ready';
    qrCodeData = null;
  });

  client.on('authenticated', () => {
    console.log('Authenticated');
    clientStatus = 'authenticated';
  });

  client.on('auth_failure', (msg) => {
    console.log('Auth failed:', msg);
    clientStatus = 'disconnected';
  });

  client.on('disconnected', (reason) => {
    console.log('Disconnected:', reason);
    clientStatus = 'disconnected';
    client = null;
    // Auto reconnect after 5 seconds
    setTimeout(() => initClient(), 5000);
  });

  client.initialize().catch(err => {
    console.error('Init error:', err.message);
    clientStatus = 'error';
    // Retry after 10 seconds
    setTimeout(() => initClient(), 10000);
  });
}

// Start on boot
initClient();

// ── Helpers ──
function cleanPhone(phone) {
  let n = phone.toString().replace(/[\s\-\(\)\+\.]/g, '');
  if (n.startsWith('0')) n = '92' + n.slice(1);
  if (!n.endsWith('@c.us')) n = n + '@c.us';
  return n;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randDelay(min, max) { return Math.floor(Math.random() * (max - min + 1) + min) * 1000; }

function buildMessage(template, row) {
  let msg = template;
  for (const [key, val] of Object.entries(row)) {
    if (!key.startsWith('_')) msg = msg.replaceAll(`{${key}}`, val || '');
  }
  return msg;
}

// ── ROUTES ──

app.get('/api/status', (req, res) => {
  res.json({ status: clientStatus, qr: qrCodeData, sending: sendingStatus });
});

app.post('/api/reconnect', async (req, res) => {
  try {
    if (client) { try { await client.destroy(); } catch(e){} client = null; }
    setTimeout(() => initClient(), 1000);
    res.json({ ok: true });
  } catch (e) { res.json({ ok: true }); }
});

app.post('/api/logout', async (req, res) => {
  try {
    if (client) {
      try { await client.logout(); } catch(e){}
      try { await client.destroy(); } catch(e){}
      client = null;
    }
    const sessionDir = './wa-session';
    if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
    clientStatus = 'disconnected';
    setTimeout(() => initClient(), 1000);
    res.json({ ok: true });
  } catch (e) { res.json({ ok: true }); }
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  try {
    const buffer = req.file.buffer;
    const filename = req.file.originalname.toLowerCase();
    let rows = [];

    if (filename.endsWith('.csv')) {
      const text = buffer.toString('utf8');
      const lines = text.trim().split('\n');
      const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
      rows = lines.slice(1).filter(l => l.trim()).map(line => {
        const vals = line.split(',').map(v => v.trim().replace(/"/g, ''));
        const obj = {};
        headers.forEach((h, i) => obj[h] = vals[i] || '');
        return obj;
      });
    } else {
      const wb = XLSX.read(buffer, { type: 'buffer' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    }

    res.json({ ok: true, rows, count: rows.length, columns: Object.keys(rows[0] || {}) });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.get('/api/template/:type', (req, res) => {
  const templates = {
    1: { name: 'Balance-Reminder', cols: ['Date', 'Phone Number', 'Customer Name', 'Balance Amount'], sample: ['23/06/2026', '923001234567', 'Ahmed Khan', 'Rs. 25,000'] },
    2: { name: 'Recovery-Reminder', cols: ['Date', 'Phone Number', 'Customer Name', 'Recovery Amount'], sample: ['23/06/2026', '923001234567', 'Fatima Malik', 'Rs. 12,500'] },
    3: { name: 'Sale-Purchase', cols: ['Date', 'Phone Number', 'Customer Name', 'Weight', 'Rate', 'Amount'], sample: ['23/06/2026', '923001234567', 'Ali Raza', '50 kg', 'Rs. 150/kg', 'Rs. 7,500'] }
  };
  const t = templates[req.params.type];
  if (!t) return res.status(404).json({ error: 'Not found' });
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([t.cols, t.sample]);
  XLSX.utils.book_append_sheet(wb, ws, t.name);
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename="${t.name}-template.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

app.post('/api/send', async (req, res) => {
  if (clientStatus !== 'ready') return res.status(400).json({ ok: false, error: 'WhatsApp not connected. Please scan QR first.' });
  if (sendingStatus.running) return res.status(400).json({ ok: false, error: 'Already sending' });

  const { rows, template, delayMin, delayMax, busyEvery, busyDuration } = req.body;

  sendingStatus = {
    running: true, paused: false,
    total: rows.length, sent: 0, failed: 0, skipped: 0,
    current: '', log: []
  };

  res.json({ ok: true, message: 'Sending started' });

  (async () => {
    let msgCount = 0;
    const min = parseInt(delayMin) || 8;
    const max = parseInt(delayMax) || 15;
    const bEvery = parseInt(busyEvery) || 25;
    const bDur = parseInt(busyDuration) || 45;

    for (let i = 0; i < rows.length; i++) {
      if (!sendingStatus.running) break;
      while (sendingStatus.paused) await sleep(500);
      if (!sendingStatus.running) break;

      const row = rows[i];
      const phone = row['Phone Number'] || row['phone'] || row['PHONE'] || row['Phone'] || '';
      const name = row['Customer Name'] || row['Name'] || row['name'] || 'Customer';
      const cleanedPhone = cleanPhone(phone);

      sendingStatus.current = `${name} (${phone})`;

      if (msgCount > 0 && msgCount % bEvery === 0) {
        sendingStatus.log.unshift({ time: new Date().toLocaleTimeString(), name, phone, status: 'break', msg: `⏸️ Human break for ${bDur}s` });
        await sleep(bDur * 1000);
        if (!sendingStatus.running) break;
      }

      try {
        const isRegistered = await client.isRegisteredUser(cleanedPhone);
        if (!isRegistered) {
          sendingStatus.skipped++;
          sendingStatus.log.unshift({ time: new Date().toLocaleTimeString(), name, phone, status: 'skipped', msg: '⛔ Not on WhatsApp' });
          continue;
        }

        const message = buildMessage(template, row);
        const typingDelay = Math.min(message.length * 35 + Math.random() * 1500, 6000);
        try { await client.sendPresenceAvailable(); } catch(e){}
        await sleep(typingDelay);

        await client.sendMessage(cleanedPhone, message);
        sendingStatus.sent++;
        msgCount++;
        sendingStatus.log.unshift({ time: new Date().toLocaleTimeString(), name, phone, status: 'sent', msg: '✅ Sent successfully' });

      } catch (err) {
        sendingStatus.failed++;
        sendingStatus.log.unshift({ time: new Date().toLocaleTimeString(), name, phone, status: 'failed', msg: `❌ Failed: ${err.message}` });
      }

      if (sendingStatus.log.length > 500) sendingStatus.log = sendingStatus.log.slice(0, 500);
      if (i < rows.length - 1) await sleep(randDelay(min, max));
    }

    sendingStatus.running = false;
    sendingStatus.current = '';
    sendingStatus.log.unshift({ time: new Date().toLocaleTimeString(), name: 'System', phone: '', status: 'done', msg: `🎉 Done! Sent: ${sendingStatus.sent}, Failed: ${sendingStatus.failed}, Skipped: ${sendingStatus.skipped}` });
  })();
});

app.post('/api/pause', (req, res) => { sendingStatus.paused = true; res.json({ ok: true }); });
app.post('/api/resume', (req, res) => { sendingStatus.paused = false; res.json({ ok: true }); });
app.post('/api/stop', (req, res) => { sendingStatus.running = false; sendingStatus.paused = false; res.json({ ok: true }); });

app.post('/api/export', (req, res) => {
  const { logs } = req.body;
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(logs);
  XLSX.utils.book_append_sheet(wb, ws, 'Report');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="wa-report.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const multer = require('multer');
const XLSX = require('xlsx');
const cors = require('cors');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const upload = multer({ storage: multer.memoryStorage() });

// ── WhatsApp Client ──
let client = null;
let qrCodeData = null;
let clientStatus = 'disconnected';
let sendingStatus = {
  running: false, paused: false,
  total: 0, sent: 0, failed: 0, skipped: 0,
  current: '', log: []
};

function getChromePath() {
  // Try environment variable first
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  // Try known Render path
  const renderPath = '/opt/render/project/src/.cache/puppeteer/chrome/linux-121.0.6167.85/chrome-linux64/chrome';
  if (fs.existsSync(renderPath)) return renderPath;
  // Try system chrome
  const systemPaths = [
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium'
  ];
  for (const p of systemPaths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function initClient() {
  clientStatus = 'loading';
  qrCodeData = null;
  
  const chromePath = getChromePath();
  console.log('Chrome path:', chromePath || 'using bundled');
  
  const puppeteerConfig = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-translate',
      '--mute-audio',
      '--safebrowsing-disable-auto-update'
    ]
  };
  
  if (chromePath) puppeteerConfig.executablePath = chromePath;
  
  client = new Client({
    authStrategy: new LocalAuth({ dataPath: './wa-session' }),
                      puppeteer: puppeteerConfig
  });
  
  client.on('qr', async (qr) => {
    console.log('QR received');
    clientStatus = 'qr';
    try { qrCodeData = await qrcode.toDataURL(qr); } catch(e) { console.error(e); }
  });
  
  client.on('ready', () => {
    console.log('WhatsApp ready!');
    clientStatus = 'ready';
    qrCodeData = null;
  });
  
  client.on('authenticated', () => {
    console.log('Authenticated');
    clientStatus = 'authenticated';
  });
  
  client.on('auth_failure', (msg) => {
    console.log('Auth failed:', msg);
    clientStatus = 'disconnected';
  });
  
  client.on('disconnected', (reason) => {
    console.log('Disconnected:', reason);
    clientStatus = 'disconnected';
    client = null;
    // Auto reconnect after 5 seconds
    setTimeout(() => initClient(), 5000);
  });
  
  client.initialize().catch(err => {
    console.error('Init error:', err.message);
    clientStatus = 'error';
    // Retry after 10 seconds
    setTimeout(() => initClient(), 10000);
  });
}

// Start on boot
initClient();

// ── Helpers ──
function cleanPhone(phone) {
  let n = phone.toString().replace(/[\s\-\(\)\+\.]/g, '');
  if (n.startsWith('0')) n = '92' + n.slice(1);
  if (!n.endsWith('@c.us')) n = n + '@c.us';
  return n;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randDelay(min, max) { return Math.floor(Math.random() * (max - min + 1) + min) * 1000; }

function buildMessage(template, row) {
  let msg = template;
  for (const [key, val] of Object.entries(row)) {
    if (!key.startsWith('_')) msg = msg.replaceAll(`{${key}}`, val || '');
  }
  return msg;
}

// ── ROUTES ──

app.get('/api/status', (req, res) => {
  res.json({ status: clientStatus, qr: qrCodeData, sending: sendingStatus });
});

app.post('/api/reconnect', async (req, res) => {
  try {
    if (client) { try { await client.destroy(); } catch(e){} client = null; }
    setTimeout(() => initClient(), 1000);
    res.json({ ok: true });
  } catch (e) { res.json({ ok: true }); }
});

app.post('/api/logout', async (req, res) => {
  try {
    if (client) {
      try { await client.logout(); } catch(e){}
      try { await client.destroy(); } catch(e){}
      client = null;
    }
    const sessionDir = './wa-session';
    if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
    clientStatus = 'disconnected';
    setTimeout(() => initClient(), 1000);
    res.json({ ok: true });
  } catch (e) { res.json({ ok: true }); }
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  try {
    const buffer = req.file.buffer;
    const filename = req.file.originalname.toLowerCase();
    let rows = [];
    
    if (filename.endsWith('.csv')) {
      const text = buffer.toString('utf8');
      const lines = text.trim().split('\n');
      const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
      rows = lines.slice(1).filter(l => l.trim()).map(line => {
        const vals = line.split(',').map(v => v.trim().replace(/"/g, ''));
        const obj = {};
        headers.forEach((h, i) => obj[h] = vals[i] || '');
        return obj;
      });
    } else {
      const wb = XLSX.read(buffer, { type: 'buffer' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    }
    
    res.json({ ok: true, rows, count: rows.length, columns: Object.keys(rows[0] || {}) });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.get('/api/template/:type', (req, res) => {
  const templates = {
    1: { name: 'Balance-Reminder', cols: ['Date', 'Phone Number', 'Customer Name', 'Balance Amount'], sample: ['23/06/2026', '923001234567', 'Ahmed Khan', 'Rs. 25,000'] },
    2: { name: 'Recovery-Reminder', cols: ['Date', 'Phone Number', 'Customer Name', 'Recovery Amount'], sample: ['23/06/2026', '923001234567', 'Fatima Malik', 'Rs. 12,500'] },
    3: { name: 'Sale-Purchase', cols: ['Date', 'Phone Number', 'Customer Name', 'Weight', 'Rate', 'Amount'], sample: ['23/06/2026', '923001234567', 'Ali Raza', '50 kg', 'Rs. 150/kg', 'Rs. 7,500'] }
  };
  const t = templates[req.params.type];
  if (!t) return res.status(404).json({ error: 'Not found' });
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([t.cols, t.sample]);
  XLSX.utils.book_append_sheet(wb, ws, t.name);
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename="${t.name}-template.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

app.post('/api/send', async (req, res) => {
  if (clientStatus !== 'ready') return res.status(400).json({ ok: false, error: 'WhatsApp not connected. Please scan QR first.' });
  if (sendingStatus.running) return res.status(400).json({ ok: false, error: 'Already sending' });
  
  const { rows, template, delayMin, delayMax, busyEvery, busyDuration } = req.body;
  
  sendingStatus = {
    running: true, paused: false,
    total: rows.length, sent: 0, failed: 0, skipped: 0,
    current: '', log: []
  };
  
  res.json({ ok: true, message: 'Sending started' });
  
  (async () => {
    let msgCount = 0;
    const min = parseInt(delayMin) || 8;
    const max = parseInt(delayMax) || 15;
    const bEvery = parseInt(busyEvery) || 25;
    const bDur = parseInt(busyDuration) || 45;
    
    for (let i = 0; i < rows.length; i++) {
      if (!sendingStatus.running) break;
      while (sendingStatus.paused) await sleep(500);
      if (!sendingStatus.running) break;
      
      const row = rows[i];
      const phone = row['Phone Number'] || row['phone'] || row['PHONE'] || row['Phone'] || '';
      const name = row['Customer Name'] || row['Name'] || row['name'] || 'Customer';
      const cleanedPhone = cleanPhone(phone);
      
      sendingStatus.current = `${name} (${phone})`;
      
      if (msgCount > 0 && msgCount % bEvery === 0) {
        sendingStatus.log.unshift({ time: new Date().toLocaleTimeString(), name, phone, status: 'break', msg: `⏸️ Human break for ${bDur}s` });
        await sleep(bDur * 1000);
        if (!sendingStatus.running) break;
      }
      
      try {
        const isRegistered = await client.isRegisteredUser(cleanedPhone);
        if (!isRegistered) {
          sendingStatus.skipped++;
          sendingStatus.log.unshift({ time: new Date().toLocaleTimeString(), name, phone, status: 'skipped', msg: '⛔ Not on WhatsApp' });
          continue;
        }
        
        const message = buildMessage(template, row);
        const typingDelay = Math.min(message.length * 35 + Math.random() * 1500, 6000);
        try { await client.sendPresenceAvailable(); } catch(e){}
        await sleep(typingDelay);
        
        await client.sendMessage(cleanedPhone, message);
        sendingStatus.sent++;
        msgCount++;
        sendingStatus.log.unshift({ time: new Date().toLocaleTimeString(), name, phone, status: 'sent', msg: '✅ Sent successfully' });
        
      } catch (err) {
        sendingStatus.failed++;
        sendingStatus.log.unshift({ time: new Date().toLocaleTimeString(), name, phone, status: 'failed', msg: `❌ Failed: ${err.message}` });
      }
      
      if (sendingStatus.log.length > 500) sendingStatus.log = sendingStatus.log.slice(0, 500);
      if (i < rows.length - 1) await sleep(randDelay(min, max));
    }
    
    sendingStatus.running = false;
    sendingStatus.current = '';
    sendingStatus.log.unshift({ time: new Date().toLocaleTimeString(), name: 'System', phone: '', status: 'done', msg: `🎉 Done! Sent: ${sendingStatus.sent}, Failed: ${sendingStatus.failed}, Skipped: ${sendingStatus.skipped}` });
  })();
});

app.post('/api/pause', (req, res) => { sendingStatus.paused = true; res.json({ ok: true }); });
app.post('/api/resume', (req, res) => { sendingStatus.paused = false; res.json({ ok: true }); });
app.post('/api/stop', (req, res) => { sendingStatus.running = false; sendingStatus.paused = false; res.json({ ok: true }); });

app.post('/api/export', (req, res) => {
  const { logs } = req.body;
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(logs);
  XLSX.utils.book_append_sheet(wb, ws, 'Report');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="wa-report.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
