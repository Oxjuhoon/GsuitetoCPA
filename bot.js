const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const http = require('http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CPA_URL = 'http://127.0.0.1:8317';
const MANAGEMENT_KEY = process.env.CPA_MANAGEMENT_KEY || 'bismillah123';
// Antigravity OAuth callback port (internal/auth/antigravity constants.go)
const AG_CALLBACK_PORT = 51121;
const AG_CALLBACK = `http://localhost:${AG_CALLBACK_PORT}/oauth-callback`;
const AKUN_FILE = path.join(__dirname, 'akun.txt');
const CONCURRENCY = 1;
const WAIT_AUTH_MS = 90000; // tunggu file auth muncul (exchange token background)

function detectBrowser() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    `${process.env.LOCALAPPDATA}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
    'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ];

  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) {
        const name = p.includes('chrome') || p.includes('Chrome') ? 'Chrome'
          : p.includes('edge') || p.includes('Edge') ? 'Edge'
          : p.includes('rave') ? 'Brave'
          : p.includes('chromium') ? 'Chromium' : 'Browser';
        return { path: p, name };
      }
    } catch {}
  }

  return { path: null, name: 'Chromium (bundled)' };
}

async function clickFirst(page, selectors) {
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        return true;
      }
    } catch {}
  }
  return false;
}

function request(method, urlStr, { body, useKey = true } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(useKey ? { 'X-Management-Key': MANAGEMENT_KEY } : {}),
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function readAccounts() {
  const content = fs.readFileSync(AKUN_FILE, 'utf-8').trim();
  if (!content) return [];
  return content
    .split('\n')
    .map((line) => {
      const [email, password] = line.trim().split('|');
      return { email, password, raw: line.trim() };
    })
    .filter((a) => a.email && a.password);
}

function removeAccount(rawLine) {
  const content = fs.readFileSync(AKUN_FILE, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim() !== rawLine);
  fs.writeFileSync(AKUN_FILE, lines.join('\n'));
}

async function startOAuth() {
  const res = await request('GET', `${CPA_URL}/v0/management/antigravity-auth-url`);

  if (res.status !== 200) {
    throw new Error(`Start OAuth gagal (${res.status}): ${JSON.stringify(res.data)}`);
  }

  const { url, state } = res.data;
  if (!url || !state) {
    throw new Error(`Response OAuth tidak lengkap: ${JSON.stringify(res.data)}`);
  }

  return { authUrl: url, state };
}

// POST /v0/management/oauth-callback skip management key middleware (dari source),
// jadi dipanggil tanpa X-Management-Key.
async function sendOAuthCallback(code, state) {
  const res = await request('POST', `${CPA_URL}/v0/management/oauth-callback`, {
    useKey: false,
    body: { provider: 'antigravity', code, state },
  });

  if (res.status !== 200) {
    throw new Error(`OAuth callback gagal (${res.status}): ${JSON.stringify(res.data)}`);
  }
  return res.data;
}

// Setelah callback dikirim, CPA menukar code -> token di background dan menulis
// antigravity-<email>.json. Poll auth-files sampai akun dengan email tsb muncul.
async function waitAuthSaved(email, timeoutMs = WAIT_AUTH_MS) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await request('GET', `${CPA_URL}/v0/management/auth-files`);
    if (res.status === 200) {
      const files = res.data?.files || [];
      const hit = files.find(
        (f) => f.type === 'antigravity' && (f.email || '').toLowerCase() === email.toLowerCase()
      );
      if (hit) return hit;
    }
    await sleep(1500);
  }
  return null;
}

async function googleLogin(browser, authUrl, email, password) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) =>
      parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters);
    window.chrome = { runtime: {} };
  });

  try {
    let authCode = null;
    let authState = null;

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const reqUrl = req.url();

      if (reqUrl.startsWith(AG_CALLBACK)) {
        const url = new URL(reqUrl);
        authCode = url.searchParams.get('code');
        authState = url.searchParams.get('state');
        req.abort();
        return;
      }

      const type = req.resourceType();
      if (['image', 'font', 'media'].includes(type)) {
        req.abort();
        return;
      }

      req.continue();
    });

    await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

    if (authCode) {
      console.log(`  [Google] ✓ Auth code (auto-redirect)`);
      return { code: authCode, state: authState };
    }

    console.log(`  [Google] Email...`);
    await page.waitForSelector('#identifierId', { visible: true, timeout: 10000 });
    await page.type('#identifierId', email, { delay: 20 });
    await sleep(500);
    await page.keyboard.press('Enter');

    console.log(`  [Google] Password...`);
    await sleep(2000);

    for (let attempt = 0; attempt < 10; attempt++) {
      const url = page.url();
      if (!url.includes('/identifier') || url.includes('/challenge') || url.includes('/pwd')) break;
      const pwdEl = await page.$('input[type="password"]');
      if (pwdEl) break;
      await sleep(1000);
    }

    const pwdSelectors = [
      'input[type="password"][name="Passwd"]',
      'input[type="password"]',
      '#password input',
      'input[name="Passwd"]',
    ];

    let pwdField = null;
    for (const sel of pwdSelectors) {
      try {
        pwdField = await page.waitForSelector(sel, { visible: true, timeout: 5000 });
        if (pwdField) break;
      } catch {}
    }

    if (!pwdField) {
      const debugFile = path.join(__dirname, `debug-${email.split('@')[0]}.png`);
      await page.screenshot({ path: debugFile, fullPage: true });
      console.log(`  [DEBUG] URL: ${page.url()}`);
      console.log(`  [DEBUG] Screenshot: ${debugFile}`);
      throw new Error('Password field tidak ditemukan — cek screenshot');
    }

    await sleep(500);
    await pwdField.type(password, { delay: 20 });
    await sleep(500);
    await page.keyboard.press('Enter');

    console.log(`  [Google] Consent...`);

    await Promise.race([
      (async () => {
        while (!authCode) await sleep(200);
        return 'got_code';
      })(),
      (async () => {
        await sleep(2000);
        await clickFirst(page, ['#gaplustosNext button', '#gaplustosNext', 'button::-p-text(I understand)']);
        await sleep(1500);
        await clickFirst(page, ['button::-p-text(Sign in)', 'button::-p-text(Masuk)']);
        await sleep(1500);
        await clickFirst(page, ['#submit_approve_access button', '#submit_approve_access', 'button::-p-text(Allow)', 'button::-p-text(Continue)', 'button::-p-text(Izinkan)']);
        await sleep(1500);
        return 'consent_done';
      })(),
    ]);

    if (!authCode) {
      const start = Date.now();
      while (!authCode && Date.now() - start < 10000) await sleep(300);
    }

    if (!authCode) {
      try {
        const currentUrl = page.url();
        if (currentUrl.startsWith(AG_CALLBACK)) {
          const u = new URL(currentUrl);
          authCode = u.searchParams.get('code');
          authState = u.searchParams.get('state');
        }
      } catch {}
    }

    if (!authCode) throw new Error('Auth code tidak ter-capture');

    console.log(`  [Google] ✓ Auth code didapat`);
    return { code: authCode, state: authState };
  } finally {
    await page.close();
    await context.close();
  }
}

async function loginAccount(browser, account, index, total) {
  const { email, password } = account;
  const t0 = Date.now();
  console.log(`\n[${index + 1}/${total}] ${email}`);

  console.log(`  [API] OAuth authorize...`);
  const { authUrl, state: oauthState } = await startOAuth();

  const { code, state } = await googleLogin(browser, authUrl, email, password);

  // state dari server bisa berbeda dengan state di callback; pakai yang dari callback
  // (server mem-validasi state saat menulis file callback). Fallback ke oauthState.
  console.log(`  [API] Kirim OAuth callback...`);
  await sendOAuthCallback(code, state || oauthState);

  console.log(`  [API] Menunggu auth tersimpan...`);
  const saved = await waitAuthSaved(email);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  if (saved) {
    console.log(`[✓] ${email} — ${elapsed}s (${saved.name})`);
    removeAccount(account.raw);
  } else {
    throw new Error('Auth tidak muncul di auth-files (timeout)');
  }
}

(async () => {
  const accounts = readAccounts();
  if (accounts.length === 0) {
    console.log('Tidak ada akun di akun.txt');
    return;
  }

  console.log(`Total akun: ${accounts.length}`);

  const browser_info = detectBrowser();
  console.log(`Browser: ${browser_info.name}${browser_info.path ? ` (${browser_info.path})` : ''}`);
  console.log(`Mode: CPA Management API + Browser (Google OAuth only)\n`);

  const launchOptions = {
    headless: false,
    defaultViewport: null,
    args: [
      '--start-maximized',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-sync',
      '--disable-translate',
      '--disable-infobars',
      '--disable-blink-features=AutomationControlled',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  };

  if (browser_info.path) {
    launchOptions.executablePath = browser_info.path;
  }

  const browser = await puppeteer.launch(launchOptions);

  let successCount = 0;
  let failCount = 0;
  const t0 = Date.now();

  for (let i = 0; i < accounts.length; i += CONCURRENCY) {
    const batch = accounts.slice(i, i + CONCURRENCY);

    const promises = batch.map(async (account, batchIdx) => {
      try {
        await loginAccount(browser, account, i + batchIdx, accounts.length);
        successCount++;
      } catch (error) {
        console.error(`[✗] ${account.email}: ${error.message}`);
        failCount++;
      }
    });

    await Promise.all(promises);
  }

  const totalTime = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n========================================`);
  console.log(`Selesai dalam ${totalTime}s`);
  console.log(`Sukses: ${successCount} | Gagal: ${failCount}`);
  console.log(`========================================`);

  await browser.close();
  console.log('\n[Browser] ✓ Ditutup');
})();
