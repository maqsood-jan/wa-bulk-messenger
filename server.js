const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const multer = require('multer');
const XLSX = require('xlsx');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const upload = multer({ storage: multer.memoryStorage() });

// ── WhatsApp Client ──
let client = null;
let qrCodeData = null;
let clientStatus = 'disconnected'; // disconnected | qr | ready
let sendingStatus = {
  running: false,
  paused: false,
  total: 0,
  sent: 0,
  failed: 0,
  skipped: 0,
  current: '',
  log: []
};

function initClient() {
  clientStatus = 'loading';
  qrCodeData = null;

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: './wa-session' }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu'
      ]
    }
  });

  client.on('qr', async (qr) => {
    console.log('QR received');
    clientStatus = 'qr';
    qrCodeData = await qrcode.toDataURL(qr);
  });

  client.on('ready', () => {
    console.log('WhatsApp connected!');
    clientStatus = 'ready';
    qrCodeData = null;
  });

  client.on('authenticated', () => {
    console.log('Authenticated');
    clientStatus = 'authenticated';
  });

  client.on('auth_failure', () => {
    console.log('Auth failed');
    clientStatus = 'disconnected';
  });

  client.on('disconnected', () => {
    console.log('Disconnected');
    clientStatus = 'disconnected';
    client = null;
  });

  client.initialize();
}

// Start client on boot
initClient();

// ── Helper: clean phone number ──
function cleanPhone(phone) {
  let n = phone.toString().replace(/[\s\-\(\)\+\.]/g, '');
  // Pakistan number fix
  if (n.startsWith('0')) n = '92' + n.slice(1);
  if (!n.endsWith('@c.us')) n = n + '@c.us';
  return n;
}

// ── Helper: random delay ──
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randDelay(min, max) { return Math.floor(Math.random() * (max - min + 1) + min) * 1000; }

// ── Helper: build message ──
function buildMessage(template, row) {
  let msg = template;
  for (const [key, val] of Object.entries(row)) {
    msg = msg.replaceAll(`{${key}}`, val || '');
  }
  return msg;
}

// ── ROUTES ──

// Status
app.get('/api/status', (req, res) => {
  res.json({
    status: clientStatus,
    qr: qrCodeData,
    sending: sendingStatus
  });
});

// Reconnect / logout
app.post('/api/reconnect', async (req, res) => {
  try {
    if (client) {
      await client.destroy();
      client = null;
    }
    setTimeout(() => initClient(), 1000);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: true });
  }
});

app.post('/api/logout', async (req, res) => {
  try {
    if (client) {
      await client.logout();
      await client.destroy();
      client = null;
    }
    // Clear session
    const sessionDir = './wa-session';
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
    clientStatus = 'disconnected';
    setTimeout(() => initClient(), 1000);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: true });
  }
});

// Upload & parse file
app.post('/api/upload', upload.single('file'), (req, res) => {
  try {
    const buffer = req.file.buffer;
    const filename = req.file.originalname.toLowerCase();
    let rows = [];

    if (filename.endsWith('.csv')) {
      const text = buffer.toString('utf8');
      const lines = text.trim().split('\n');
      const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
      rows = lines.slice(1).map(line => {
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

// Download template
app.get('/api/template/:type', (req, res) => {
  const templates = {
    1: { name: 'Balance-Reminder', cols: ['Date', 'Phone Number', 'Customer Name', 'Balance Amount'] },
    2: { name: 'Recovery-Reminder', cols: ['Date', 'Phone Number', 'Customer Name', 'Recovery Amount'] },
    3: { name: 'Sale-Purchase', cols: ['Date', 'Phone Number', 'Customer Name', 'Weight', 'Rate', 'Amount'] }
  };
  const t = templates[req.params.type];
  if (!t) return res.status(404).json({ error: 'Not found' });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([t.cols, t.cols.map(() => 'Sample Data')]);
  XLSX.utils.book_append_sheet(wb, ws, t.name);
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename="${t.name}-template.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// Send messages
app.post('/api/send', async (req, res) => {
  if (clientStatus !== 'ready') {
    return res.status(400).json({ ok: false, error: 'WhatsApp not connected' });
  }
  if (sendingStatus.running) {
    return res.status(400).json({ ok: false, error: 'Already sending' });
  }

  const { rows, template, delayMin, delayMax, busyEvery, busyDuration } = req.body;

  sendingStatus = {
    running: true,
    paused: false,
    total: rows.length,
    sent: 0,
    failed: 0,
    skipped: 0,
    current: '',
    log: []
  };

  res.json({ ok: true, message: 'Sending started' });

  // Process in background
  (async () => {
    let msgCount = 0;
    const min = parseInt(delayMin) || 8;
    const max = parseInt(delayMax) || 15;
    const bEvery = parseInt(busyEvery) || 25;
    const bDur = parseInt(busyDuration) || 45;

    for (let i = 0; i < rows.length; i++) {
      // Check if stopped
      if (!sendingStatus.running) break;

      // Wait if paused
      while (sendingStatus.paused) await sleep(500);
      if (!sendingStatus.running) break;

      const row = rows[i];
      const phone = row['Phone Number'] || row['phone'] || row['PHONE'] || '';
      const name = row['Customer Name'] || row['Name'] || 'Customer';
      const cleanedPhone = cleanPhone(phone);

      sendingStatus.current = `${name} (${phone})`;

      // Human busy break
      if (msgCount > 0 && msgCount % bEvery === 0) {
        const breakTime = bDur * 1000;
        sendingStatus.log.unshift({ time: new Date().toLocaleTimeString(), name, phone, status: 'break', msg: `⏸️ Human break for ${bDur}s` });
        await sleep(breakTime);
        if (!sendingStatus.running) break;
      }

      try {
        // Check if number is on WhatsApp
        const isRegistered = await client.isRegisteredUser(cleanedPhone);
        if (!isRegistered) {
          sendingStatus.skipped++;
          sendingStatus.log.unshift({ time: new Date().toLocaleTimeString(), name, phone, status: 'skipped', msg: '⛔ Not on WhatsApp' });
          continue;
        }

        // Build message
        const message = buildMessage(template, row);

        // Simulate typing delay (human-like)
        const typingDelay = Math.min(message.length * 35 + Math.random() * 1500, 6000);
        await client.sendPresenceAvailable();
        await sleep(typingDelay);

        // Send message
        await client.sendMessage(cleanedPhone, message);
        sendingStatus.sent++;
        msgCount++;
        sendingStatus.log.unshift({ time: new Date().toLocaleTimeString(), name, phone, status: 'sent', msg: '✅ Sent successfully' });

      } catch (err) {
        sendingStatus.failed++;
        sendingStatus.log.unshift({ time: new Date().toLocaleTimeString(), name, phone, status: 'failed', msg: `❌ Failed: ${err.message}` });
      }

      // Keep log max 500
      if (sendingStatus.log.length > 500) sendingStatus.log = sendingStatus.log.slice(0, 500);

      // Random delay between messages
      if (i < rows.length - 1) {
        await sleep(randDelay(min, max));
      }
    }

    sendingStatus.running = false;
    sendingStatus.current = '';
    sendingStatus.log.unshift({ time: new Date().toLocaleTimeString(), name: 'System', phone: '', status: 'done', msg: `🎉 Done! Sent: ${sendingStatus.sent}, Failed: ${sendingStatus.failed}, Skipped: ${sendingStatus.skipped}` });
  })();
});

// Pause / Resume / Stop
app.post('/api/pause', (req, res) => { sendingStatus.paused = true; res.json({ ok: true }); });
app.post('/api/resume', (req, res) => { sendingStatus.paused = false; res.json({ ok: true }); });
app.post('/api/stop', (req, res) => { sendingStatus.running = false; sendingStatus.paused = false; res.json({ ok: true }); });

// Export report
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
