const http = require('http');

const CPA_URL = 'http://127.0.0.1:8317';
const MANAGEMENT_KEY = process.env.CPA_MANAGEMENT_KEY || 'bismillah123';
const OPUS_MODEL = 'claude-opus-4-6-thinking';
const CHAT_TIMEOUT = 180; // detik, respons opus bisa lambat (~40s+ untuk quota check)

// Mode: node delete.js | node delete.js --failed [N] | node delete.js --opus | node delete.js --dry-run | node delete.js user@x.com
//   --failed [N] : tanpa tes, hapus akun dengan failed counter >= N (default 5). Gratis, tapi failed = lifetime semua model.
//   --opus        : tes opus nyata (konsumsi quota).
const MODE_OPUS = process.argv.includes('--opus');
const MODE_FAILED = process.argv.includes('--failed');
const DRY_RUN = process.argv.includes('--dry-run');
const failedIdx = process.argv.indexOf('--failed');
const FAILED_THRESHOLD = failedIdx >= 0 && process.argv[failedIdx + 1] && /^\d+$/.test(process.argv[failedIdx + 1])
  ? parseInt(process.argv[failedIdx + 1], 10)
  : 5;
const emailFilter = process.argv.filter((a) => a.includes('@') && !a.includes('/') && !a.includes('\\')).map((e) => e.toLowerCase());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(method, urlStr, { body, bearer, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : { 'X-Management-Key': MANAGEMENT_KEY }),
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
    req.setTimeout(timeout, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function parseStatusMessage(f) {
  if (!f.status_message) return { code: null, status: null, message: '' };
  try {
    const obj = typeof f.status_message === 'string' ? JSON.parse(f.status_message) : f.status_message;
    return {
      code: obj?.error?.code ?? null,
      status: obj?.error?.status ?? '',
      message: obj?.error?.message ?? '',
    };
  } catch {
    return { code: null, status: null, message: String(f.status_message).slice(0, 120) };
  }
}

async function getAuthFiles() {
  const res = await request('GET', `${CPA_URL}/v0/management/auth-files`);
  if (res.status !== 200) throw new Error(`Get auth-files gagal: ${res.status} ${JSON.stringify(res.data)}`);
  return res.data.files || [];
}

async function setDisabled(name, disabled) {
  const res = await request('PATCH', `${CPA_URL}/v0/management/auth-files/status`, {
    body: { name, disabled },
  });
  return res.status === 200;
}

async function deleteAuthFile(name) {
  const res = await request('DELETE', `${CPA_URL}/v0/management/auth-files?name=${encodeURIComponent(name)}`);
  return res.status === 200;
}

async function testChatWithOpus() {
  const body = {
    model: OPUS_MODEL,
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 10,
    stream: false,
  };
  let res;
  try {
    res = await request('POST', `${CPA_URL}/v1/chat/completions`, {
      body,
      bearer: MANAGEMENT_KEY,
      timeout: CHAT_TIMEOUT * 1000,
    });
  } catch (e) {
    return 'TIMEOUT';
  }
  if (res.status === 200) return 'OK';
  const err = res.data?.error || {};
  const code = err.code || '';
  const message = String(err.message || JSON.stringify(res.data)).toLowerCase();
  if (res.status === 429 || code === 'RESOURCE_EXHAUSTED' || message.includes('exhausted') || message.includes('quota')) {
    return 'QUOTA';
  }
  if (res.status === 403 || code === 'PERMISSION_DENIED') return '403';
  if (res.status === 503 || message.includes('capacity') || message.includes('unavailable')) return '503';
  if (res.status === 0) return 'TIMEOUT';
  return `ERR(${res.status})`;
}

// Restore status semua akun, tahan gagal per akun, lalu verifikasi & retry.
async function restoreStatuses(agFiles, snapshot) {
  for (const f of agFiles) {
    try {
      await setDisabled(f.name, snapshot[f.name] === true);
    } catch {
      // lanjut akun berikutnya
    }
  }
  // verifikasi ulang & retry yang masih salah
  for (let attempt = 0; attempt < 3; attempt++) {
    const fresh = await getAuthFiles();
    const wrong = fresh.filter((f) => {
      const orig = agFiles.find((a) => a.name === f.name);
      if (!orig) return false;
      return f.disabled !== (snapshot[orig.name] === true);
    });
    if (wrong.length === 0) return;
    for (const f of wrong) {
      try {
        await setDisabled(f.name, snapshot[f.name] === true);
      } catch {}
    }
  }
}

// Reset quota/cooldown state akun biar status_message bersih sebelum blast.
async function resetQuota(authIndex) {
  const res = await request('POST', `${CPA_URL}/v0/management/reset-quota`, {
    body: { auth_index: authIndex },
  });
  return res.status === 200;
}

// Baca status_message terbaru per akun dari management API.
function readMark(file) {
  if (!file.status_message) return 'OK';
  try {
    const obj = typeof file.status_message === 'string' ? JSON.parse(file.status_message) : file.status_message;
    const code = obj?.error?.code ?? null;
    const status = obj?.error?.status ?? '';
    const message = obj?.error?.message ?? '';
    if (code === 429 || status === 'RESOURCE_EXHAUSTED') return 'QUOTA';
    if (code === 403 || status === 'PERMISSION_DENIED') return '403';
    if (code === 503 || status === 'UNAVAILABLE') return '503';
    return `ERR(${code || status || '?'})`;
  } catch {
    return 'OK';
  }
}

// Verifikasi serial: isolasi akun (disable yang lain) -> 1 request opus -> konfirmasi.
// Akun yang ter-mark 429/403 saat blast bisa false positive (cooldown sesaat),
// jadi di-verifikasi ulang dengan akurat.
async function verifySerial(agFiles, f, snapshot) {
  await setDisabled(f.name, false);
  await sleep(3000);
  const result = await testChatWithOpus();
  await setDisabled(f.name, true);
  return result;
}

async function scanOpusMode(agFiles) {
  const targets = agFiles.filter((f) => {
    if (emailFilter.length > 0 && !emailFilter.includes((f.email || '').toLowerCase())) return false;
    return true;
  });

  console.log(`Tes ${OPUS_MODEL} untuk ${targets.length} akun (paralel + verifikasi)...\n`);

  const snapshot = Object.fromEntries(agFiles.map((f) => [f.name, !!f.disabled]));
  const targetNames = new Set(targets.map((f) => f.name));

  try {
    // reset quota semua target biar status bersih
    console.log('Reset quota/cooldown...');
    for (const f of targets) {
      if (f.auth_index) await resetQuota(f.auth_index);
    }

    // disable yang bukan target, enable target
    console.log('Setup: hanya target yang aktif...');
    for (const f of agFiles) {
      const wantEnabled = targetNames.has(f.name);
      if (wantEnabled && f.disabled) await setDisabled(f.name, false);
      if (!wantEnabled && !f.disabled) await setDisabled(f.name, true);
    }
    await sleep(3000);

    // blast paralel: 2x jumlah target (biar semua kena), min 8
    const blastCount = Math.max(targets.length * 2, 8);
    console.log(`Blast ${blastCount} request paralel ke ${OPUS_MODEL}...`);
    const t0 = Date.now();
    await Promise.all(
      Array.from({ length: blastCount }, () => testChatWithOpus().catch(() => 'ERR'))
    );
    console.log(`Blast selesai dalam ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

    // baca mark per akun
    await sleep(2000);
    const fresh = await getAuthFiles();
    const byName = Object.fromEntries(fresh.map((f) => [f.name, f]));

    const candidates = [];
    const okAccounts = [];
    for (const f of targets) {
      const mark = readMark(byName[f.name] || {});
      if (mark === 'QUOTA' || mark === '403') {
        candidates.push({ f, mark });
      } else {
        okAccounts.push({ f, mark });
      }
    }

    console.log(`Setelah blast: ${candidates.length} ter-mark (QUOTA/403), ${okAccounts.length} aman`);
    if (candidates.length > 0) {
      console.log('Verifikasi ulang akun ter-mark secara serial...');
      for (const c of candidates) {
        const confirmed = await verifySerial(agFiles, c.f, snapshot);
        c.confirmed = confirmed;
        console.log(`  ${c.f.email || c.f.name} — blast: ${c.mark} | verifikasi: ${confirmed}`);
      }
    }
    console.log('');

    const results = [
      ...okAccounts.map(({ f, mark }) => ({ f, result: mark, verified: true })),
      ...candidates.map(({ f, mark, confirmed }) => ({ f, result: confirmed, verified: true })),
    ];
    const toDelete = results
      .filter((r) => r.result === 'QUOTA' || r.result === '403')
      .map((r) => ({ f: r.f, code: r.result, status: '', message: '' }));
    const toKeep = results.filter((r) => r.result !== 'QUOTA' && r.result !== '403');

    console.log(`Hasil tes ${OPUS_MODEL}:`);
    for (const r of results) {
      const mark = r.result === 'QUOTA' || r.result === '403' ? '✗' : '✓';
      console.log(`  [${mark}] ${r.f.email || r.f.name} — ${r.result}`);
    }
    return { toDelete, toKeep };
  } finally {
    // restore status semula
    console.log('\nRestore status akun...');
    await restoreStatuses(agFiles, snapshot);
  }
}

// Mode --failed: murni baca failed counter (tanpa request chat sama sekali).
// failed = lifetime semua model, tidak spesifik opus; hanya sinyal kasar.
async function scanFailedMode(agFiles) {
  const toDelete = [];
  const toKeep = [];

  for (const f of agFiles) {
    const name = f.email || f.name;

    if (emailFilter.length > 0 && !emailFilter.includes((f.email || '').toLowerCase())) {
      toKeep.push(f);
      continue;
    }

    const failed = f.failed || 0;
    const success = f.success || 0;
    const { code, status } = parseStatusMessage(f);

    if (failed >= FAILED_THRESHOLD) {
      toDelete.push({ f, code: `failed=${failed}`, status, message: '' });
      console.log(
        `  [✗] ${name} — HAPUS (failed=${failed} >= ${FAILED_THRESHOLD}) success=${success}${code ? ` | status ${code}` : ''}`
      );
    } else {
      toKeep.push(f);
      console.log(`  [✓] ${name} — KEEP (failed=${failed} < ${FAILED_THRESHOLD}) success=${success}`);
    }
  }
  return { toDelete, toKeep };
}

async function scanStatusMode(agFiles) {
  const toDelete = [];
  const toKeep = [];

  for (const f of agFiles) {
    const name = f.email || f.name;

    if (emailFilter.length > 0 && !emailFilter.includes((f.email || '').toLowerCase())) {
      toKeep.push(f);
      continue;
    }

    const { code, status, message } = parseStatusMessage(f);

    // 429 = quota habis, 403 = tidak punya entitlement
    const isExhausted =
      code === 429 || status === 'RESOURCE_EXHAUSTED' || code === 403 || status === 'PERMISSION_DENIED';

    if (isExhausted) {
      toDelete.push({ f, code, status, message });
      console.log(`  [✗] ${name} — HAPUS (${code || status}) ${message ? '| ' + message.slice(0, 60) : ''}`);
    } else {
      toKeep.push(f);
      console.log(`  [✓] ${name} — KEEP (${f.status || '?'}${code ? ` ${code}` : ''})`);
    }
  }
  return { toDelete, toKeep };
}

(async () => {
  try {
    const files = await getAuthFiles();
    console.log(`Total auth files: ${files.length}\n`);

    const agFiles = files.filter((f) => f.type === 'antigravity');
    console.log(`Antigravity auth files: ${agFiles.length}\n`);

    if (agFiles.length === 0) {
      console.log('Tidak ada Antigravity auth file.');
      return;
    }

    const { toDelete, toKeep } = MODE_OPUS
      ? await scanOpusMode(agFiles)
      : MODE_FAILED
        ? await scanFailedMode(agFiles)
        : await scanStatusMode(agFiles);

    console.log(`\n-----------------------------------------`);
    console.log(`Hapus: ${toDelete.length} | Keep: ${toKeep.length}`);
    console.log(`-----------------------------------------\n`);

    if (toDelete.length === 0) {
      console.log('Tidak ada auth file yang perlu dihapus.');
      return;
    }

    if (DRY_RUN) {
      console.log('[DRY-RUN] Tidak ada yang benar-benar dihapus.');
      return;
    }

    let deleted = 0;
    let failed = 0;

    for (const { f, code, status } of toDelete) {
      const ok = await deleteAuthFile(f.name);
      if (ok) {
        deleted++;
        console.log(`[✓] Deleted: ${f.name} (${code || status})`);
      } else {
        failed++;
        console.log(`[✗] Failed: ${f.name}`);
      }
    }

    console.log(`\n========================================`);
    console.log(`Selesai! Deleted: ${deleted} | Failed: ${failed}`);
    console.log(`========================================`);
  } catch (error) {
    console.error(`Error: ${error.message}`);
  }
})();
