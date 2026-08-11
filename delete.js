const http = require('http');

const CPA_URL = 'http://127.0.0.1:8317';
const MANAGEMENT_KEY = process.env.CPA_MANAGEMENT_KEY || 'bismillah123';

function request(method, urlStr, { body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Management-Key': MANAGEMENT_KEY,
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

function parseStatusMessage(f) {
  if (!f.status_message) return { code: null, status: null, message: '' };
  try {
    const obj = JSON.parse(f.status_message);
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

async function deleteAuthFile(name) {
  const res = await request('DELETE', `${CPA_URL}/v0/management/auth-files?name=${encodeURIComponent(name)}`);
  return res.status === 200;
}

// Filter email dari CLI: node delete.js <email> atau node delete.js user1@x.com user2@y.com
const emailFilter = process.argv.slice(2).filter((a) => a.includes('@')).map((e) => e.toLowerCase());

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

    const toDelete = [];
    const toKeep = [];

    for (const f of agFiles) {
      const name = f.email || f.name;

      if (emailFilter.length > 0 && !emailFilter.includes((f.email || '').toLowerCase())) {
        toKeep.push(f);
        continue;
      }

      const { code, status, message } = parseStatusMessage(f);

      // Sama seperti delete.js 9router: hapus akun yang quota habis (429).
      // 403 = tidak punya entitlement (tidak berguna juga) — dihapus juga biar bersih.
      const isExhausted =
        code === 429 ||
        status === 'RESOURCE_EXHAUSTED' ||
        code === 403 ||
        status === 'PERMISSION_DENIED';

      if (isExhausted) {
        toDelete.push({ f, code, status, message });
        console.log(`  [✗] ${name} — HAPUS (${code || status}) ${message ? '| ' + message.slice(0, 60) : ''}`);
      } else {
        toKeep.push(f);
        console.log(`  [✓] ${name} — KEEP (${f.status || '?'}${code ? ` ${code}` : ''})`);
      }
    }

    console.log(`\n-----------------------------------------`);
    console.log(`Hapus: ${toDelete.length} | Keep: ${toKeep.length}`);
    console.log(`-----------------------------------------\n`);

    if (toDelete.length === 0) {
      console.log('Tidak ada auth file yang perlu dihapus.');
      return;
    }

    const dryRun = process.argv.includes('--dry-run');
    if (dryRun) {
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
