#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
TRAE Work CN 每日签到适配器

原理
----
TRAE 客户端把登录凭据加密存在 storage.json 的 `iCubeAuthInfo://icube.cloudide` 键里。
本模块用**纯 Python 标准库**实现 AES-128-CBC 解密（密钥由 SHA-512 链式派生），
解出 refreshToken / accessToken / deviceId，再调用官方签到接口领取每日积分。

设计原则
--------
- 只读本机登录态，不外传、不落盘副本、不打印令牌。
- 使用**真实设备号**；签到失败即停止并告警，**不换设备号重试**（那是规避风控）。
- 幂等：已签直接跳过。

自检
----
    python trae.py --inspect     # 解密并列出字段名（不打印任何令牌值）
    python trae.py --status      # 查询签到状态
    python trae.py               # 执行签到
"""

from __future__ import annotations

import base64
import datetime
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.request

import http_direct as _http  # 直连（绕环境代理），见 http_direct.py

# --------------------------------------------------------------------------
# 常量
# --------------------------------------------------------------------------
STORAGE_KEY = "iCubeAuthInfo://icube.cloudide"
STORAGE_KEY_DC_PREFIX = "iCubeAuthInfo://icube-dc:"

API_HOST = "https://api.trae.cn"
CHECKIN_STATUS = "/trae/api/v2/ug/checkin_credits/status"
CHECKIN_CLAIM = "/trae/api/v2/ug/checkin_credits/claim"
# 积分余额（额度使用情况）——从客户端 main.js 逆向所得，见 query_balance()
BALANCE_USAGE = "/trae/api/v2/pay/ide_user_ent_usage"
TOKEN_EXCHANGE = "https://api.trae.com.cn/cloudide/api/v3/trae/oauth/ExchangeToken"

_SALT_A = bytes([82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215,
                 251, 124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222,
                 233, 203, 84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66,
                 250, 195, 78, 8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73,
                 109, 139, 209, 37])
_SALT_B = bytes([31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95,
                 96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156,
                 239, 160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83,
                 153, 97, 23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33,
                 12, 125])
SALT_AES = bytes(a ^ b for a, b in zip(_SALT_A, _SALT_B))


# --------------------------------------------------------------------------
# 纯标准库 AES-128-CBC 解密
# --------------------------------------------------------------------------
def _gmul(a: int, b: int) -> int:
    p = 0
    for _ in range(8):
        if b & 1:
            p ^= a
        hi = a & 0x80
        a = (a << 1) & 0xFF
        if hi:
            a ^= 0x1B
        b >>= 1
    return p


def _build_sbox() -> list[int]:
    inv = [0] * 256
    for i in range(1, 256):
        for j in range(1, 256):
            if _gmul(i, j) == 1:
                inv[i] = j
                break
    sb = [0] * 256
    for i in range(256):
        x = inv[i] if i else 0
        s = x
        for _ in range(4):
            x = ((x << 1) | (x >> 7)) & 0xFF
            s ^= x
        sb[i] = s ^ 0x63
    return sb


SBOX = _build_sbox()
INV_SBOX = [0] * 256
for _i, _v in enumerate(SBOX):
    INV_SBOX[_v] = _i
RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1B, 0x36]


def _expand_key(key: bytes) -> list[list[int]]:
    w = [list(key[i * 4:i * 4 + 4]) for i in range(4)]
    for i in range(4, 44):
        t = w[i - 1][:]
        if i % 4 == 0:
            t = t[1:] + t[:1]
            t = [SBOX[b] for b in t]
            t[0] ^= RCON[i // 4 - 1]
        w.append([w[i - 4][j] ^ t[j] for j in range(4)])
    return w


def _round_key(w, r: int) -> list[int]:
    ws = w[r * 4:r * 4 + 4]
    return [ws[c][k] for c in range(4) for k in range(4)]


def _add_round_key(s, k):
    return [s[i] ^ k[i] for i in range(16)]


def _inv_sub_bytes(s):
    return [INV_SBOX[b] for b in s]


def _inv_shift_rows(s):
    return [s[0], s[13], s[10], s[7], s[4], s[1], s[14], s[11],
            s[8], s[5], s[2], s[15], s[12], s[9], s[6], s[3]]


def _inv_mix_columns(s):
    o = []
    for c in range(4):
        a = s[c * 4:c * 4 + 4]
        o += [_gmul(a[0], 14) ^ _gmul(a[1], 11) ^ _gmul(a[2], 13) ^ _gmul(a[3], 9),
              _gmul(a[0], 9) ^ _gmul(a[1], 14) ^ _gmul(a[2], 11) ^ _gmul(a[3], 13),
              _gmul(a[0], 13) ^ _gmul(a[1], 9) ^ _gmul(a[2], 14) ^ _gmul(a[3], 11),
              _gmul(a[0], 11) ^ _gmul(a[1], 13) ^ _gmul(a[2], 9) ^ _gmul(a[3], 14)]
    return o


def aes128_cbc_decrypt(key: bytes, iv: bytes, data: bytes) -> bytes:
    w = _expand_key(key)
    out = b""
    prev = list(iv)
    for off in range(0, len(data), 16):
        block = list(data[off:off + 16])
        s = _add_round_key(block, _round_key(w, 10))
        for r in range(9, 0, -1):
            s = _inv_shift_rows(s)
            s = _inv_sub_bytes(s)
            s = _add_round_key(s, _round_key(w, r))
            s = _inv_mix_columns(s)
        s = _inv_shift_rows(s)
        s = _inv_sub_bytes(s)
        s = _add_round_key(s, _round_key(w, 0))
        out += bytes(a ^ b for a, b in zip(s, prev))
        prev = block
    return out


def decrypt_storage_value(b64: str) -> bytes:
    """
    解密 storage.json 里的凭据字段。

    结构：buf = [6 字节头][32 字节随机块 rb][密文 enc]
    密钥派生：h = sha512(rb) → fh = sha512(h + SALT_AES)
              key = fh[:16]，iv = fh[16:32]
    明文前 64 字节为头部，其后是真正的 JSON。
    """
    buf = base64.b64decode(b64)
    if len(buf) < 38:
        raise ValueError("密文长度不足")
    rb, enc = buf[6:38], buf[38:]
    h = hashlib.sha512(rb).digest()
    fh = hashlib.sha512(h + SALT_AES).digest()
    pt = aes128_cbc_decrypt(fh[:16], fh[16:32], enc)[64:]
    pad = pt[-1] if pt else 0
    if 1 <= pad <= 16:
        return pt[:-pad]
    return pt.rstrip(b"\x00").rstrip()


# --------------------------------------------------------------------------
# 定位与解析凭据
# --------------------------------------------------------------------------
def candidate_paths():
    """探测本机 TRAE 客户端的 storage.json 路径。"""
    ad = os.environ.get("APPDATA") or os.path.join(
        os.path.expanduser("~"), "AppData", "Roaming")
    names = ("TRAE SOLO CN", "Trae CN", "TRAE SOLO", "Trae")
    for n in names:
        p = os.path.join(ad, n, "User", "globalStorage", "storage.json")
        if os.path.isfile(p):
            yield p


def load_credentials(path: str | None = None) -> dict:
    """读取并解密本机 TRAE 登录态。返回 dict（含 accessToken/refreshToken/deviceId）。"""
    paths = [path] if path else list(candidate_paths())
    if not paths:
        raise FileNotFoundError("未找到 TRAE 客户端的 storage.json，请先安装并登录 TRAE")

    src = paths[0]
    store = json.load(open(src, encoding="utf-8"))

    enc = store.get(STORAGE_KEY)
    if not enc:
        raise ValueError(f"{src} 中未找到 {STORAGE_KEY}，请先在 TRAE 客户端登录")

    text = decrypt_storage_value(enc).decode("utf-8", "replace")

    try:
        obj = json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        obj = json.loads(text[start:end + 1]) if start >= 0 and end > start else {}

    def grab(pattern):
        m = re.search(pattern, text)
        return m.group(1) if m else None

    # 设备号：优先用客户端真实设备号
    device_id = store.get("telemetry.devDeviceId")
    if not device_id:
        device_id = obj.get("deviceId") or grab(r'"deviceId"\s*:\s*"([^"]+)"')
    if not device_id:
        for k in store:
            if k.startswith(STORAGE_KEY_DC_PREFIX):
                device_id = k[len(STORAGE_KEY_DC_PREFIX):]
                break

    return {
        "source": src,
        "accessToken": obj.get("token") or grab(r'"token"\s*:\s*"([^"]+)"'),
        "refreshToken": obj.get("refreshToken"),
        "userId": obj.get("userId"),
        "username": (obj.get("account") or {}).get("username"),
        "host": obj.get("host") or API_HOST,
        "region": (obj.get("userRegion") or {}).get("region") or "CN",
        "expiredAt": obj.get("expiredAt"),
        "refreshExpiredAt": obj.get("refreshExpiredAt"),
        "deviceId": device_id,
        "_obj": obj,
        "_raw_text": text,
    }


# --------------------------------------------------------------------------
# 接口调用
# --------------------------------------------------------------------------
def _request(url: str, creds: dict, body=None, method: str | None = None,
             timeout: int = 20):
    """发起请求。返回 (http_status, parsed_body)。不打印任何令牌。"""
    token = creds.get("accessToken") or ""
    headers = {
        "Authorization": f"Cloud-IDE-JWT {token}",
        "Accept": "application/json",
        "Content-Type": "application/json",
        "x-device-id": str(creds.get("deviceId") or ""),
        "X-User-Region": str(creds.get("region") or "CN"),
        "User-Agent": "TraeWork/1.0",
    }
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        method = method or "POST"
    req = urllib.request.Request(url, data=data, headers=headers,
                                 method=method or "GET")
    try:
        with _http.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            try:
                return resp.status, json.loads(raw)
            except json.JSONDecodeError:
                return resp.status, raw
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            return exc.code, json.loads(raw)
        except json.JSONDecodeError:
            return exc.code, raw
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return -1, {"_network_error": str(exc)}


def query_status(creds: dict):
    """查询今日签到状态。返回 (status, body, 使用的 method)。"""
    base = (creds.get("host") or API_HOST).rstrip("/")
    url = base + CHECKIN_STATUS
    code, body = _request(url, creds, method="GET")
    if code in (-1, 404, 405):
        code2, body2 = _request(url, creds, body={}, method="POST")
        if code2 not in (-1, 404, 405):
            return code2, body2, "POST"
    return code, body, "GET"


def claim(creds: dict):
    """执行签到领取。

    req_source 取值各开源实现不一致（1 或 2），默认按桌面端口径取 1，
    可用环境变量 TRAE_REQ_SOURCE 覆盖。
    """
    base = (creds.get("host") or API_HOST).rstrip("/")
    try:
        req_source = int(os.environ.get("TRAE_REQ_SOURCE", "1"))
    except ValueError:
        req_source = 1
    return _request(base + CHECKIN_CLAIM, creds, body={"req_source": req_source})


# --------------------------------------------------------------------------
# 积分余额（额度使用情况）
# --------------------------------------------------------------------------
def query_balance(creds: dict) -> dict:
    """查询积分余额（只读）。

    接口来源
    --------
    从客户端 `resources/app/out/main.js` 逆向所得：其内部
    `fetchCreditsUsageStatus()` 调的就是这个端点。签名/鉴权与签到接口同源
    （Cloud-IDE-JWT + x-device-id），因此复用 `_request`。

        GET {host}/trae/api/v2/pay/ide_user_ent_usage
            ?require_usage=1&req_source=<1=IDE | 2=Lite>

    响应结构（字段名与客户端解析函数一致）
    --------------------------------------
        {
          is_credits_billing: bool,
          usage_summary: {total_amount, consumed_amount, consumption_ratio},
          user_entitlement_pack_list: [
            {display_desc, expire_time,
             entitlement_base_info: {quota: {credits_limit}, end_time},
             usage: {credits_amount}}
          ]
        }

    余额口径（**沿用客户端自己的算法**，不自行发明）
    -----------------------------------------------
        credits_limit == -1  → 该包无限额，整体标记 unlimited
        否则 limit     += credits_limit
             used      += credits_amount
             remaining += max(credits_limit - credits_amount, 0)

    实测交叉校验：`usage_summary.total_amount` 与 Σ credits_limit 一致（均为 5100），
    两套口径互为印证。本函数以**包级计算**为准，同时原样回报 `usage_summary`
    以便调用方核对——若某天两者不一致，说明口径变了，应以服务端为准并更新此处。

    返回 dict；网络/鉴权失败时 `error` 字段有值，其余字段为 None（不抛异常）。
    """
    base = (creds.get("host") or API_HOST).rstrip("/")
    try:
        req_source = int(os.environ.get("TRAE_REQ_SOURCE", "1"))
    except ValueError:
        req_source = 1

    url = (f"{base}{BALANCE_USAGE}?require_usage=1&req_source={req_source}")
    code, body = _request(url, creds, method="GET")

    out = {"http": code, "limit": None, "used": None, "remaining": None,
           "unlimited": False, "breakdown": [], "summary": None,
           "is_credits_billing": None, "error": None}

    if code == -1:
        out["error"] = f"网络不可达：{body.get('_network_error') if isinstance(body, dict) else body}"
        return out
    if code in (401, 403):
        out["error"] = "登录态失效，请在 TRAE 客户端重新登录一次"
        return out
    if code != 200 or not isinstance(body, dict):
        out["error"] = f"HTTP {code}：{str(body)[:200]}"
        return out

    out["is_credits_billing"] = body.get("is_credits_billing")
    out["summary"] = body.get("usage_summary")

    packs = body.get("user_entitlement_pack_list") or []
    limit = used = remain = 0
    unlimited = False
    for a in packs:
        if not isinstance(a, dict):
            continue
        bi = a.get("entitlement_base_info") or {}
        cl = (bi.get("quota") or {}).get("credits_limit")
        amt = (a.get("usage") or {}).get("credits_amount") or 0
        if not isinstance(cl, int):
            continue
        if cl == -1:
            unlimited = True
            continue
        if cl <= 0:
            continue
        limit += cl
        used += amt
        remain += max(cl - amt, 0)
        exp = a.get("expire_time") or bi.get("end_time")
        out["breakdown"].append({
            "name": a.get("display_desc") or "—",
            "limit": cl,
            "used": amt,
            "expire": (datetime.datetime.fromtimestamp(exp).strftime("%Y-%m-%d")
                       if isinstance(exp, int) and exp > 0 else None),
        })

    out["unlimited"] = unlimited
    out["limit"] = limit
    out["used"] = used
    out["remaining"] = remain
    out["breakdown"].sort(key=lambda x: (x["expire"] or "9999", x["name"]))
    return out


def run(dry_run: bool = False) -> dict:
    """执行一轮签到。返回结构化结果。"""
    creds = load_credentials()
    out = {"platform": "TRAE Work CN", "account": creds.get("username"),
           "source": creds["source"]}

    # 余额查询是**尽力而为**：失败不影响签到判定，只把原因记在 balance_error。
    # 这样即使余额接口哪天改了，签到这条主链路也不会被拖垮。
    bal = query_balance(creds)
    if bal.get("error"):
        out["balance_error"] = bal["error"]
    else:
        out["total_credits"] = bal["remaining"]
        out["credits_limit"] = bal["limit"]
        out["credits_used"] = bal["used"]

    code, body, _method = query_status(creds)
    out["status_http"] = code
    if code == -1:
        return {**out, "result": "NETWORK", "detail": body}
    if code in (401, 403):
        return {**out, "result": "AUTH_REJECTED",
                "detail": "登录态失效，请在 TRAE 客户端重新登录一次"}
    if code != 200 or not isinstance(body, dict):
        return {**out, "result": "ERROR", "detail": body}

    if body.get("enable") is False:
        return {**out, "result": "INACTIVE", "detail": "签到活动未开启"}
    if body.get("checked_in") in (True, 1):
        return {**out, "result": "ALREADY", "detail": "今日已签到",
                "credit": body.get("credits"),
                "extra_credit": body.get("extra_credits")}

    if dry_run:
        return {**out, "result": "DRY_RUN",
                "detail": "演练：今日未签，将执行领取", "status": body}

    code2, body2 = claim(creds)
    out["claim_http"] = code2
    if code2 == -1:
        return {**out, "result": "NETWORK", "detail": body2}
    data = body2 if isinstance(body2, dict) else {}
    biz = data.get("code")
    msg = str(data.get("message") or data.get("msg") or "")

    if biz == 9074:
        return {**out, "result": "ERROR",
                "detail": "设备号被服务端标记（9074）。按既定原则**不更换设备号重试**；"
                          "请用桌面端正常签到一次，或等次日重置。"}
    if biz == 0:
        return {**out, "result": "OK", "credit": data.get("credits"),
                "extra_credit": data.get("extra_credits"), "detail": data}
    if "已签" in msg or "already" in msg.lower():
        return {**out, "result": "ALREADY", "detail": msg}
    return {**out, "result": "ERROR", "detail": data}


def inspect(creds: dict) -> None:
    """列出解密后 JSON 的字段名（不打印任何值），用于排查结构变化。"""
    print("凭据来源:", creds["source"])
    print("设备号:", creds["deviceId"])
    print("接口主机:", creds["host"], "| 区域:", creds["region"])
    print("已解出字段:", {k: ("有" if creds.get(k) else "无")
                        for k in ("accessToken", "refreshToken", "userId", "username")})
    print("令牌到期:", creds.get("expiredAt"), "| 刷新令牌到期:", creds.get("refreshExpiredAt"))

    obj = creds.get("_obj") or {}
    if isinstance(obj, dict) and obj:
        print("\n解密后 JSON 顶层字段:")
        for k, v in obj.items():
            kind = type(v).__name__
            print(f"  {k}: <{kind}>" + (f" len={len(v)}" if isinstance(v, str) else ""))
        for k, v in obj.items():
            if isinstance(v, dict):
                print(f"\n  {k} 的子字段:")
                for kk, vv in v.items():
                    print(f"    {kk}: <{type(vv).__name__}>")


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if "--inspect" in sys.argv:
        inspect(load_credentials())
        return 0
    if "--status" in sys.argv:
        creds = load_credentials()
        code, body, method = query_status(creds)
        print(f"[{method}] HTTP {code}")
        print(json.dumps(body, ensure_ascii=False, indent=2)[:2000])
        return 0
    if "--balance" in sys.argv:
        creds = load_credentials()
        bal = query_balance(creds)
        if bal.get("error"):
            print(f"❌ 余额查询失败：{bal['error']}")
            return 1
        unit = "（无限额）" if bal["unlimited"] else ""
        print(f"积分余额：{bal['remaining']} / {bal['limit']}{unit}"
              f"    已用 {bal['used']}")
        print(f"（服务端 usage_summary：{json.dumps(bal['summary'], ensure_ascii=False)}）")
        print(f"\n明细 {len(bal['breakdown'])} 个额度包：")
        for b in bal["breakdown"]:
            print(f"  {b['name']:<12} limit={b['limit']:<6} used={b['used']:<4} "
                  f"到期={b['expire'] or '-'}")
        return 0

    result = run(dry_run="--dry-run" in sys.argv)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("result") in ("OK", "ALREADY", "DRY_RUN") else 1


if __name__ == "__main__":
    sys.exit(main())
