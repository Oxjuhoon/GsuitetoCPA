# GsuitetoCPA

Bulk add & manage Google accounts (GSuite) ke **CPA** (CLIProxyAPI) provider **Antigravity** via Management API.

## Prasyarat
- CPA (cli-proxy-api) berjalan di `http://127.0.0.1:8317`
- Management key di config (`remote-management.secret-key`) — default fallback `bismillah123` (bisa di-override dengan env `CPA_MANAGEMENT_KEY`)
- Google account di `akun.txt` dengan format `email|password` (satu per baris)

## Install
```bash
npm install
```

## Usage

### Tambah akun (OAuth login)
```bash
npm run bot
```
- Login Google untuk tiap akun di `akun.txt`
- Sukses → akun otomatis tersimpan CPA sebagai `antigravity-<email>.json` di `~/.cli-proxy-api/` dan barisnya dihapus dari `akun.txt`
- Gagal → ditampilkan di terminal, akun tetap di `akun.txt`

### Hapus akun
```bash
npm run delete            # hapus otomatis akun yang 429 (quota habis) & 403 (tidak punya entitlement)
npm run delete -- --failed [N]   # tanpa tes: hapus akun dengan failed counter >= N (default 5)
npm run delete -- --opus         # tes opus nyata (paralel blast + verifikasi serial) — KONSUMSI QUOTA
npm run delete -- user@x.com user@y.com   # hapus hanya email tertentu
npm run delete -- --dry-run               # cek dulu tanpa menghapus
```

Catatan mode:
- `--failed [N]`: murni baca counter `failed` (lifetime, semua model), **0 request chat**. Gratis tapi kasar — tidak spesifik model, dan `failed` juga naik dari error transient/403, jadi ada risiko salah hapus akun yang masih sehat.
- `--opus`: tes `claude-opus-4-6-thinking` sungguhan per akun (akurat) tapi **menghabiskan quota** akun yang masih punya sisa — jangan dipakai jika akun bukan milik sendiri.
- Status 429 yang tercatat di `status_message` hilang otomatis dalam hitungan menit (cooldown/reconcile), jadi mode default hanya berguna segera setelah error terjadi.

### Cek status akun (read-only)
```bash
npm run check
```
- Menampilkan status tiap akun antigravity: OK / 403 / 429 / 503 / lainnya
- Non-invasif, tidak mengirim request ke model

## Catatan
- OAuth callback Antigravity: `http://localhost:51121/oauth-callback` (dari source `internal/auth/antigravity/constants.go`)
- Semua request management pakai header `X-Management-Key`; endpoint `POST /v0/management/oauth-callback` dipanggil tanpa key (skip middleware dari source)
