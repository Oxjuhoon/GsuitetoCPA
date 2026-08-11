#!/usr/bin/env python3
"""Import antigravity credentials dari credential-9router.json ke CPA (CLIProxyAPI).

Format 9router:  {provider, email, data: {accessToken, refreshToken, expiresAt, projectId, expiresIn}}
Format CPA:      ~/.cli-proxy-api/antigravity-<email>.json
                 {type, email, access_token, refresh_token, expires_in, timestamp, expired, project_id}

Upload via POST /v0/management/auth-files?name=<file> (raw JSON body).
"""
import json
import sys
import time
import urllib.request

CPA_URL = "http://127.0.0.1:8317"
MANAGEMENT_KEY = "bismillah123"  # fallback, override via env
SRC = "/Users/dans/Downloads/credential-9router.json"
DRY_RUN = "--dry-run" in sys.argv


def req(method, path, body=None, key=MANAGEMENT_KEY):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(
        CPA_URL + path,
        data=data,
        method=method,
        headers={
            "Content-Type": "application/json",
            "X-Management-Key": key,
        },
    )
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except Exception:
            return e.code, {}


def to_cpa_auth(entry):
    data = entry.get("data") or {}
    expires_at = data.get("expiresAt") or entry.get("expiresAt") or ""
    now_ms = int(time.time() * 1000)
    auth = {
        "type": "antigravity",
        "email": entry["email"],
        "access_token": data.get("accessToken") or entry.get("accessToken") or "",
        "refresh_token": data.get("refreshToken") or entry.get("refreshToken") or "",
        "expires_in": data.get("expiresIn") or entry.get("expiresIn") or 3599,
        "timestamp": now_ms,
        "expired": expires_at,
        "project_id": data.get("projectId") or entry.get("projectId") or "",
    }
    return auth


def main():
    creds = json.load(open(SRC))
    if not isinstance(creds, list):
        print("credential file harus berupa list")
        sys.exit(1)

    ag = [c for c in creds if (c.get("provider") or "").lower() == "antigravity"]
    print(f"Total credential: {len(creds)} | Antigravity: {len(ag)}\n")

    # cek overlap dengan auth yang sudah ada di CPA
    status, existing = req("GET", "/v0/management/auth-files")
    existing_emails = {f.get("email", "").lower() for f in existing.get("files", [])}
    print(f"Auth files di CPA sekarang: {len(existing_emails)}")

    ok, skipped, failed = 0, 0, []
    for i, entry in enumerate(ag, 1):
        email = entry.get("email", "")
        fname = f"antigravity-{email}.json"
        print(f"[{i}/{len(ag)}] {email}")

        if email.lower() in existing_emails:
            print("  [~] sudah ada, skip")
            skipped += 1
            continue

        auth = to_cpa_auth(entry)
        if not auth["access_token"]:
            print("  [x] access_token kosong, skip")
            failed.append((email, "access_token kosong"))
            continue

        if DRY_RUN:
            print("  [dry-run] siap upload")
            ok += 1
            continue

        status, resp = req("POST", f"/v0/management/auth-files?name={fname}", auth)
        if status == 200:
            ok += 1
            print(f"  [✓] upload OK ({fname})")
            existing_emails.add(email.lower())
        else:
            failed.append((email, f"HTTP {status}: {resp}"))
            print(f"  [x] gagal: HTTP {status} {resp}")

    print(f"\n========================================")
    print(f"Selesai! Sukses: {ok} | Skip: {skipped} | Gagal: {len(failed)}")
    if failed:
        print("Gagal:")
        for e, err in failed:
            print(f"  - {e}: {str(err)[:80]}")
    print(f"========================================")


if __name__ == "__main__":
    main()
