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
  // 1. Check environment variable (user override)
  const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (envPath) {
    try {
      fs.accessSync(envPath, fs.constants.X_OK);
      console.log('✅ Using Chrome from PUPPETEER_EXECUTABLE_PATH:', envPath);
      return envPath;
    } catch (e) {
      console.warn('⚠️ PUPPETEER_EXECUTABLE_PATH set but not executable, ignoring');
    }
  }
  
  // 2. Check Render cache directory (where build script installs Chrome)
  const renderCacheBase = '/opt/render/.cache/puppeteer/chrome';
  if (fs.existsSync(renderCacheBase)) {
    try {
      const dirs = fs.readdirSync(renderCacheBase);
      for (const dir of dirs) {
        const chromePath = `${renderCacheBase}/${dir}/chrome-linux64/chrome`;
        try {
          fs.accessSync(chromePath, fs.constants.X_OK);
          console.log('✅ Using Chrome from Render cache:', chromePath);
          return chromePath;
        } catch (e) {
          // not executable, try next
        }
      }
    } catch (e) {
      console.warn('⚠️ Could not read Render cache directory:', e.message);
    }
  }
  
  // 3. Try common system paths
  const systemPaths = [
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium'
  ];
  for (const p of systemPaths) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      console.log('✅ Found system Chrome:', p);
      return p;
    } catch (e) { /* ignore */ }
  }
  
  // 4. Let Puppeteer use its own discovery (cache dir)
  console.log('ℹ️ No executable path found – Puppeteer will use its cache.');
  return null;
}

function initClient() {
  clientStatus = 'loading';
  qrCodeData = null;
  
  const chromePath = getChromePath();
  console.log('Chrome path:', chromePath || 'using default Puppeteer discovery');
  
  const puppeteerConfig = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      // Removed --single-process for stability
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
                      puppeteer: puppeteerConfig,
                      // Increase timeouts
                      qrMaxRetries: 3,
                      takeoverOnConflict: true,
                      takeoverTimeoutMs: 60000,
  });
  
  client.on('qr', async (qr) => {
    console.log('✅ QR received – scan it with WhatsApp mobile');
    clientStatus = 'qr';
    try {
      qrCodeData = await qrcode.toDataURL(qr);
    } catch(e) {
      console.error('QR generation error:', e);
    }
  });
  
  client.on('ready', () => {
    console.log('✅ WhatsApp client is ready!');
    clientStatus = 'ready';
    qrCodeData = null;
  });
  
  client.on('authenticated', () => {
    console.log('✅ Authenticated successfully');
    clientStatus = 'authenticated';
  });
  
  client.on('auth_failure', (msg) => {
    console.log('❌ Auth failed:', msg);
    clientStatus = 'disconnected';
  });
  
  client.on('disconnected', (reason) => {
    console.log('❌ Disconnected:', reason);
    clientStatus = 'disconnected';
    client = null;
    // Do not auto-reconnect immediately; let the user trigger via /api/reconnect
  });
  
  client.initialize()
  .then(() => {
    console.log('✅ Client initialization started');
  })
  .catch(err => {
    console.error('❌ Init error:', err.message);
    clientStatus = 'error';
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

// ── ROUTES ── (unchanged except small logging)

app.get('/api/status', (req, res) => {
  res.json({ status: clientStatus, qr: qrCodeData, sending: sendingStatus });
});

app.post('/api/reconnect', async (req, res) => {
  try {
    if (client) {
      try { await client.destroy(); } catch(e) {}
      client = null;
    }
    clientStatus = 'disconnected';
    setTimeout(() => initClient(), 1000);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: true });
  }
});

app.post('/api/logout', async (req, res) => {
  try {
    if (client) {
      try { await client.logout(); } catch(e) {}
      try { await client.destroy(); } catch(e) {}
      client = null;
    }
    const sessionDir = './wa-session';
    if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
    clientStatus = 'disconnected';
    setTimeout(() => initClient(), 1000);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: true });
  }
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  // ... same as before
});

app.get('/api/template/:type', (req, res) => {
  // ... same as before
});

app.post('/api/send', async (req, res) => {
  // ... same as before
});

app.post('/api/pause', (req, res) => { sendingStatus.paused = true; res.json({ ok: true }); });
app.post('/api/resume', (req, res) => { sendingStatus.paused = false; res.json({ ok: true }); });
app.post('/api/stop', (req, res) => { sendingStatus.running = false; sendingStatus.paused = false; res.json({ ok: true }); });

app.post('/api/export', (req, res) => {
  // ... same as before
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
