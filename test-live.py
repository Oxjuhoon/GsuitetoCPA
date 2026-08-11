#!/usr/bin/env python3
"""Tes tiap akun antigravity CPA dengan chat ke model flash gemini.

Cara kerja: untuk tiap akun target, disable semua akun antigravity lain
(sehingga round-robin cuma punya 1 kandidat), kirim 1 chat request, lalu
restore status semua akun ke kondisi semula. Test pakai model murah
(gemini-3-flash-agent) — bukan opus.
"""
import json
import sys
import time
import urllib.request
import urllib.error

CPA_URL = "http://127.0.0.1:8317"
MANAGEMENT_KEY = "bismillah123"
MODEL = "gemini-3-flash-agent"
CHAT_TIMEOUT = 60  # detik per request
ONLY = sys.argv[1:]  # filter email opsional

def req(method, path, body=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(
        CPA_URL + path, data=data, method=method,
        headers={"Content-Type": "application/json", "X-Management-Key": MANAGEMENT_KEY},
    )
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except Exception:
            return e.code, {}
    except Exception as e:
        return 0, {"error": str(e)}

def set_disabled(name, disabled):
    return req("PATCH", "/v0/management/auth-files/status", {"name": name, "disabled": disabled})

def test_chat():
    body = {
        "model": MODEL,
        "messages": [{"role": "user", "content": "ping"}],
        "max_tokens": 10,
        "stream": False,
    }
    # chat pakai Authorization Bearer SAJA (tanpa X-Management-Key biar tidak konflik)
    data = json.dumps(body).encode()
    r = urllib.request.Request(
        CPA_URL + "/v1/chat/completions", data=data, method="POST",
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + MANAGEMENT_KEY},
    )
    try:
        with urllib.request.urlopen(r, timeout=CHAT_TIMEOUT) as resp:
            st, resp = resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            st, resp = e.code, json.loads(e.read() or b"{}")
        except Exception:
            st, resp = e.code, {}
    except Exception as e:
        return "TIMEOUT", str(e)
    if st == 200:
        return "OK", resp.get("model", "")
    err = resp.get("error") or {}
    code = err.get("code") if isinstance(err, dict) else None
    message = str(err.get("message", "") if isinstance(err, dict) else resp)[:100]
    return classify(st, code, message), f"{st} {code} {message}"

def classify(status, code, message):
    msg = (message or "").lower()
    if status == 429 or code == "RESOURCE_EXHAUSTED" or "exhausted" in msg or "quota" in msg:
        return "QUOTA"
    if status == 403 or code == "PERMISSION_DENIED" or "permission_denied" in msg or "project_id" in msg:
        return "403"
    if status == 503 or code == "UNAVAILABLE" or "capacity" in msg or "unavailable" in msg:
        return "503"
    if status == 0:
        return "TIMEOUT"
    return "ERR"

def main():
    st, data = req("GET", "/v0/management/auth-files")
    if st != 200:
        print("gagal list auth-files:", data)
        sys.exit(1)
    files = data.get("files", [])
    ag = [f for f in files if f.get("type") == "antigravity"]
    targets = [f for f in ag if f.get("email", "").startswith("balidin")]
    if ONLY:
        targets = [f for f in targets if f.get("email") in ONLY]
    print(f"Total antigravity: {len(ag)} | Target tes: {len(targets)}")

    # snapshot status semua akun antigravity (biar bisa restore)
    snapshot = {f["name"]: bool(f.get("disabled")) for f in ag}
    restore_order = [f["name"] for f in ag]

    try:
        # disable semua antigravity dulu
        print("Disable semua antigravity...")
        for f in ag:
            if not f.get("disabled"):
                set_disabled(f["name"], True)

        results = []
        for i, f in enumerate(targets, 1):
            email = f.get("email")
            name = f["name"]
            set_disabled(name, False)
            time.sleep(3)  # tunggu registry/synthesizer refresh
            print(f"[{i}/{len(targets)}] {email} ...", flush=True)
            t0 = time.time()
            result, info = test_chat()
            dt = round(time.time() - t0, 1)
            print(f"  -> {result} ({dt}s) {info}")
            results.append((email, name, result, info))
            set_disabled(name, True)
    finally:
        # restore status semula
        print("\nRestore status akun...")
        for name in restore_order:
            was = snapshot.get(name, False)
            set_disabled(name, was)

    print("\n========================================")
    ok = [r for r in results if r[2] == "OK"]
    quota = [r for r in results if r[2] == "QUOTA"]
    err403 = [r for r in results if r[2] == "403"]
    err503 = [r for r in results if r[2] == "503"]
    other = [r for r in results if r[2] not in ("OK", "QUOTA", "403", "503")]
    print(f"OK: {len(ok)} | QUOTA: {len(quota)} | 403: {len(err403)} | 503: {len(err503)} | Lain: {len(other)}")
    print("========================================")
    for r in results:
        print(f"  {r[0]:35} {r[2]:8} {r[3]}")

if __name__ == "__main__":
    main()
