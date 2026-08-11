const http = require('http');

const CPA_URL = 'http://127.0.0.1:8317';
const MANAGEMENT_KEY = process.env.CPA_MANAGEMENT_KEY || 'bismillah123';

function request(method, urlStr) {
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

(async () => {
  try {
    const res = await request('GET', `${CPA_URL}/v0/management/auth-files`);
    if (res.status !== 200) {
      throw new Error(`Get auth-files gagal: ${res.status} ${JSON.stringify(res.data)}`);
    }

    const files = res.data.files || [];
    console.log(`Total auth files: ${files.length}\n`);

    const agFiles = files.filter((f) => f.type === 'antigravity');
    console.log(`Antigravity auth files: ${agFiles.length}\n`);

    if (agFiles.length === 0) {
      console.log('Tidak ada Antigravity auth file.');
      return;
    }

    let countOK = 0;
    let count403 = 0;
    let count429 = 0;
    let count503 = 0;
    let countOther = 0;

    for (const f of agFiles) {
      const name = f.email || f.name;
      const { code, status, message } = parseStatusMessage(f);

      if (f.unavailable || (code && code !== 200) || (status && status !== 'OK')) {
        if (code === 403 || status === 'PERMISSION_DENIED') {
          count403++;
          console.log(`  [✗] ${name} — 403 (${message || 'denied'})`);
        } else if (code === 429 || status === 'RESOURCE_EXHAUSTED') {
          count429++;
          console.log(`  [~] ${name} — 429 (quota reached)`);
        } else if (code === 503 || status === 'UNAVAILABLE') {
          count503++;
          console.log(`  [~] ${name} — 503 (${message || 'unavailable'})`);
        } else {
          countOther++;
          console.log(`  [?] ${name} — ${f.status || '?'} (${code || status || 'unknown'}) ${message ? '| ' + message.slice(0, 60) : ''}`);
        }
      } else {
        countOK++;
        console.log(`  [✓] ${name} — OK${f.project_id ? ` (project: ${f.project_id})` : ''}`);
      }
    }

    console.log(`\n-----------------------------------------`);
    console.log(`OK: ${countOK} | 403: ${count403} | 429: ${count429} | 503: ${count503} | Lainnya: ${countOther}`);
    console.log(`-----------------------------------------`);

    if (count403 > 0) {
      console.log('\n403 = authorization ditolak Google (tidak punya entitlement Antigravity).');
      console.log('Akun seperti ini tidak bisa dipakai untuk chat. Gunakan: npm run delete');
    }
    if (count429 > 0) {
      console.log('\n429 = quota model habis (bisa reset periodik / butuh akun lain).');
    }
    if (count503 > 0) {
      console.log('\n503 = kapasitas layanan tidak tersedia (transient, coba lagi nanti).');
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
  }
})();
