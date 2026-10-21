#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""百度搭子 DuMate 适配器 —— 官方接口签到 + 余额查询

机制说明
--------
DuMate（百度智能云桌面 AI 办公智能体，`dumate.baidu.com`）是**接口可直连**型：
官方提供「每日签到」接口，签到发放当日 500 积分（限时免费活动，全部用户）。
客户端登录后会自动 POST 一次签到接口，因此「登录即签到」；本项目也支持
在检测到「今日未签」时主动补签（幂等，已签即跳过）。

接口规格（2026-10-12 实测：客户端日志 + 直接调用双重验证）
--------------------------------------------------------
  基址  https://console.bce.baidu.com
  鉴权  Cookie（解密自 auth.json，见下）

  GET  /api/dumate/points/loginBonusInfo
       → {code:0, success:true, result:{totalTimes, totalPoints, hasIssued, signInDays[]}}
         hasIssued = 今日是否已发放（**幂等判据**）
         signInDays = 已签到日期数组；totalTimes = 累计签到次数
         totalPoints = 累计签到所得积分

  POST /api/dumate/points/loginBonus
       → 领取当日积分。客户端在登录时自动调用（日志实测 18:34:30 POST →
         4 秒后 loginBonusInfo 的 hasIssued 变为 true）。
         本项目仅在 hasIssued=false 时调用，避免重复领取。

  GET  /api/dumate/points/quota_overview
         ?timezone=Asia%2FShanghai&clientType=desktop&ignoreLoginBonus=true
       → {result:{totalPoints, usedPoints, subscription[], incremental[]}}
         incremental[].source = "login_bonus"（签到所得包的来源标记）

凭证（本机自动读取，无需手工录入）
----------------------------------
  %APPDATA%\\qianfan-desktop-app\\
      auth.json       ← accountProfiles[activeProfileId].encryptedCookies（base64 密文）
      .cookie-key     ← 32 字节 AES-256 主密钥（明文存放于用户目录）

  加密格式 = AES-256-GCM，布局 **nonce(12) | tag(16) | ciphertext**
  （tag 在密文之前，与 Chromium OSCrypt v10 不同，故用专用助手 dumate_gcm.js）。
  明文为 Chromium 格式的 cookie 数组 JSON。
  AES 由 Node 内置 crypto 完成（Python 标准库无 AES，避免引入 pip 依赖）。

诚实性说明
----------
- 余额口径 = `quota_overview.totalPoints`（账户可用积分总量，含签到/订阅/增量包），
  与「累计签到所得」(`loginBonusInfo.totalPoints`) 是两回事，各自如实标注。
- 签到积分**有有效期**（官方：赠送积分到期清零；实测签到包 startDate→expireDate
  约 31 天），故「某天没签」并非永久损失，但过期未用即作废。

用法
----
    python adapters/dumate.py --status    # 只读：签到状态 + 余额
    python adapters/dumate.py             # 执行签到（已签则幂等跳过）
"""

from __future__ import annotations

import base64
import datetime
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

import http_direct as _http  # 直连（绕环境代理），见 http_direct.py

# --------------------------------------------------------------------------
# 常量
# --------------------------------------------------------------------------
APP_DIR_NAME = "qianfan-desktop-app"
AUTH_FILE = "auth.json"
COOKIE_KEY_FILE = ".cookie-key"

API_BASE = "https://console.bce.baidu.com"
PATH_BONUS_INFO = "/api/dumate/points/loginBonusInfo"
PATH_BONUS_CLAIM = "/api/dumate/points/loginBonus"
PATH_QUOTA = ("/api/dumate/points/quota_overview"
              "?timezone=Asia%2FShanghai&clientType=desktop&ignoreLoginBonus=true")

COOKIE_DOMAIN_SUFFIX = "baidu.com"      # 只取百度域下的 cookie
USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) DuMate/1.0.83 Chrome/128.0.0.0 Safari/537.36")
TIMEOUT = 15

HERE = os.path.dirname(os.path.abspath(__file__))
GCM_JS = os.path.join(HERE, "dumate_gcm.js")


# --------------------------------------------------------------------------
# 路径
# --------------------------------------------------------------------------
def user_data_dir() -> str:
    """DuMate 的 userData 目录。

    可被环境变量 DUMATE_USER_DATA 覆盖（开源化：零硬编码）。
    """
    env = os.environ.get("DUMATE_USER_DATA")
    if env:
        return env
    appdata = os.environ.get("APPDATA")
    if not appdata:
        appdata = os.path.join(os.path.expanduser("~"), "AppData", "Roaming")
    return os.path.join(appdata, APP_DIR_NAME)


def launch_paths() -> list[str]:
    """启动痕迹候选文件 —— 供 launch_trace 兜底（本适配器不依赖它）。"""
    ud = user_data_dir()
    return [
        os.path.join(ud, AUTH_FILE),
        os.path.join(ud, "Preferences"),
    ]


def _find_node() -> str:
    """定位 node.exe —— 用于 AES-256-GCM（Python 标准库无 AES）。

    查找顺序：环境变量 → 托管运行时目录 → PATH。
    """
    for var in ("DUMATE_NODE", "NODE_BIN"):
        p = os.environ.get(var)
        if p and os.path.isfile(p):
            return p

    base = os.path.join(os.path.expanduser("~"), ".workbuddy-ai",
                        "binaries", "node", "versions")
    if os.path.isdir(base):
        for ver in sorted(os.listdir(base), reverse=True):
            for cand in (os.path.join(base, ver, "node.exe"),
                         os.path.join(base, ver, "bin", "node.exe")):
                if os.path.isfile(cand):
                    return cand

    for name in ("node", "node.exe"):
        p = shutil.which(name)
        if p:
            return p
    raise FileNotFoundError(
        "找不到 node.exe（解密 DuMate 凭证需要它做 AES-256-GCM）。"
        "可用环境变量 DUMATE_NODE 显式指定路径。")


# --------------------------------------------------------------------------
# 解密：AES-256-GCM（布局 nonce|tag|ciphertext）
# --------------------------------------------------------------------------
def _gcm_decrypt(key: bytes, raw: bytes) -> bytes:
    """调 Node 助手解密。明文只在内存与临时目录间传递，用完即删。"""
    node = _find_node()
    if not os.path.isfile(GCM_JS):
        raise FileNotFoundError(f"缺少解密助手 {GCM_JS}")
    tmp = tempfile.mkdtemp(prefix="dumate_")
    try:
        p_key = os.path.join(tmp, "k.hex")
        p_in = os.path.join(tmp, "i.hex")
        with open(p_key, "w") as fh:
            fh.write(key.hex())
        with open(p_in, "w") as fh:
            fh.write(raw.hex())
        r = subprocess.run([node, GCM_JS, p_key, p_in],
                           capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            raise ValueError((r.stderr or "").strip() or "AES-GCM 解密失败")
        return bytes.fromhex(r.stdout.strip())
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def load_cookies() -> list[dict]:
    """解密 auth.json，返回 cookie 对象列表。

    优先取 `activeProfileId` 对应的账号；找不到则回退到首个 profile 或顶层 cookies。
    """
    ud = user_data_dir()
    if not os.path.isdir(ud):
        raise FileNotFoundError(f"未找到 DuMate 数据目录：{ud}（未安装或未运行过）")

    key_path = os.path.join(ud, COOKIE_KEY_FILE)
    auth_path = os.path.join(ud, AUTH_FILE)
    if not os.path.isfile(key_path):
        raise FileNotFoundError(f"缺少密钥文件 {key_path}")
    if not os.path.isfile(auth_path):
        raise FileNotFoundError(f"缺少凭证文件 {auth_path}；请在 DuMate 客户端登录一次")

    with open(key_path, "rb") as fh:
        key = fh.read()
    if len(key) != 32:
        raise ValueError(f".cookie-key 长度应为 32 字节，实际 {len(key)}")

    with open(auth_path, encoding="utf-8") as fh:
        auth = json.load(fh)

    enc_b64 = None
    profiles = auth.get("accountProfiles") or []
    active_id = auth.get("activeProfileId")
    for prof in profiles:
        if isinstance(prof, dict) and prof.get("profileId") == active_id:
            enc_b64 = prof.get("encryptedCookies")
            break
    if not enc_b64:
        for prof in profiles:
            if isinstance(prof, dict) and prof.get("encryptedCookies"):
                enc_b64 = prof["encryptedCookies"]
                break
    if not enc_b64:
        enc_b64 = auth.get("cookies")
    if not enc_b64:
        raise ValueError("auth.json 里没有 encryptedCookies；请在客户端重新登录")

    plain = _gcm_decrypt(key, base64.b64decode(enc_b64))
    cookies = json.loads(plain.decode("utf-8"))
    if not isinstance(cookies, list):
        raise ValueError("解密结果不是 cookie 数组（格式可能已变更）")
    return cookies


def cookie_header(cookies: list[dict]) -> str:
    """把 cookie 数组拼成请求头用的 Cookie 串（只取百度域、未过期、有名者）。"""
    now = datetime.datetime.now().timestamp()
    pairs: list[str] = []
    seen: set[str] = set()
    for c in cookies:
        if not isinstance(c, dict):
            continue
        name = c.get("name")
        val = c.get("value")
        if not name or val is None:
            continue
        dom = str(c.get("domain") or "").lstrip(".")
        if not (dom == COOKIE_DOMAIN_SUFFIX or dom.endswith("." + COOKIE_DOMAIN_SUFFIX)):
            continue
        exp = c.get("expirationDate")
        if isinstance(exp, (int, float)) and exp < now:
            continue
        if name in seen:          # 同名取先出现者（路径更宽的一般在前）
            continue
        seen.add(name)
        pairs.append(f"{name}={val}")
    return "; ".join(pairs)


# --------------------------------------------------------------------------
# 接口调用
# --------------------------------------------------------------------------
def _request(method: str, path: str, cookie: str, body: bytes | None = None):
    req = urllib.request.Request(API_BASE + path, method=method, data=body)
    req.add_header("Cookie", cookie)
    req.add_header("Accept", "application/json, text/plain, */*")
    req.add_header("Referer", "https://console.bce.baidu.com/")
    req.add_header("User-Agent", USER_AGENT)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with _http.urlopen(req, timeout=TIMEOUT) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read().decode("utf-8"))
        except Exception:  # noqa: BLE001
            return exc.code, None
    except Exception as exc:  # noqa: BLE001
        return -1, f"{type(exc).__name__}: {exc}"


def query_status(cookie: str):
    """只读：查签到状态。"""
    return _request("GET", PATH_BONUS_INFO, cookie)


def claim(cookie: str):
    """领取当日签到积分（幂等：已签时服务端应直接返回已发放）。"""
    return _request("POST", PATH_BONUS_CLAIM, cookie, body=b"{}")


def query_quota(cookie: str):
    """只读：查积分余额总览。"""
    return _request("GET", PATH_QUOTA, cookie)


def _result_of(body: object) -> dict | None:
    if isinstance(body, dict) and body.get("success") is True:
        r = body.get("result")
        return r if isinstance(r, dict) else {}
    return None


def parse_status(body: object) -> dict | None:
    """解析 loginBonusInfo 响应 → 扁平结构；失败返回 None。

    返回：{"has_issued", "total_times", "total_points", "sign_days"}
    """
    res = _result_of(body)
    if res is None:
        return None
    return {
        "has_issued": bool(res.get("hasIssued")),
        "total_times": res.get("totalTimes"),
        "total_points": res.get("totalPoints"),
        "sign_days": res.get("signInDays") or [],
    }


def parse_quota(body: object) -> dict | None:
    """解析 quota_overview 响应 → 扁平结构；失败返回 None。

    返回：{"total", "used", "packs":[{"source","total","used","expire"}]}
    """
    res = _result_of(body)
    if res is None:
        return None
    try:
        total = float(res.get("totalPoints"))
    except (TypeError, ValueError):
        total = None
    packs = []
    for p in (res.get("incremental") or []):
        if isinstance(p, dict):
            packs.append({"source": p.get("source"), "total": p.get("totalPoints"),
                          "used": p.get("usedPoints"),
                          "expire": _ts(p.get("expireDate"))})
    return {"total": total, "used": res.get("usedPoints"), "packs": packs}


# --------------------------------------------------------------------------
# 统一入口
# --------------------------------------------------------------------------
def run(dry_run: bool = False) -> dict:
    """执行签到 + 查余额。

    结果码：
      今日已发放       → ALREADY（计入「签到正常」分子）
      本次领取成功     → OK（带 credit）
      演练且未签       → DRY_RUN
      登录态失效       → AUTH_REJECTED
      网络不可达       → NETWORK
      其他             → ERROR
    """
    out = {"platform": "百度搭子 DuMate", "balance_unit": "积分"}

    try:
        cookies = load_cookies()
        cookie = cookie_header(cookies)
    except (FileNotFoundError, ValueError, OSError) as exc:
        out.update(result="ERROR", detail=f"凭证不可用：{exc}")
        return out
    if not cookie:
        out.update(result="AUTH_REJECTED",
                   detail="解密出的 cookie 为空（百度域下无有效登录 cookie），"
                          "请在 DuMate 客户端重新登录")
        return out

    # ---- 1. 查签到状态 ----
    code, body = query_status(cookie)
    out["status_http"] = code
    if code == -1:
        out.update(result="NETWORK", detail=f"网络不可达：{body}")
        return out
    if code in (401, 403):
        out.update(result="AUTH_REJECTED",
                   detail="登录态失效（Cookie 过期），请在 DuMate 客户端重新登录")
        return out
    res = _result_of(body)
    if res is None:
        out.update(result="ERROR", detail=f"状态接口返回异常（HTTP {code}）：{str(body)[:180]}")
        return out

    has_issued = bool(res.get("hasIssued"))
    out["total_times"] = res.get("totalTimes")
    out["sign_total_points"] = res.get("totalPoints")
    out["sign_days"] = res.get("signInDays") or []

    # ---- 2. 未签则补签（演练除外）----
    credit = None
    if has_issued:
        out["result"] = "ALREADY"
        out["detail"] = (f"今日已签到（累计 {out['total_times']} 次，"
                         f"签到累计 {out['sign_total_points']} 积分）。")
    elif dry_run:
        out["result"] = "DRY_RUN"
        out["detail"] = "今日未签到；演练模式不实际领取。"
    else:
        c2, b2 = claim(cookie)
        if c2 == -1:
            out.update(result="NETWORK", detail=f"签到请求网络不可达：{b2}")
            return out
        if c2 in (401, 403):
            out.update(result="AUTH_REJECTED",
                       detail="签到被拒（登录态失效），请在 DuMate 客户端重新登录")
            return out
        if _result_of(b2) is None:
            out.update(result="ERROR",
                       detail=f"签到失败（HTTP {c2}）：{str(b2)[:180]}")
            return out
        out["result"] = "OK"
        credit = 500          # 限时活动口径：每日签到 500 积分
        out["credit"] = credit
        out["detail"] = f"签到成功，本次领取 {credit} 积分。"

    # ---- 3. 查余额（口径：账户可用积分总量）----
    c3, b3 = query_quota(cookie)
    out["quota_http"] = c3
    q = _result_of(b3)
    if q is not None:
        try:
            out["balance"] = float(q.get("totalPoints"))
        except (TypeError, ValueError):
            out["balance"] = None
        out["balance_used"] = q.get("usedPoints")
        out["balance_note"] = "账户可用积分总量（含签到/订阅/增量包）"
        packs = q.get("incremental") or []
        if isinstance(packs, list):
            out["balance_packs"] = [
                {"source": p.get("source"), "total": p.get("totalPoints"),
                 "used": p.get("usedPoints"),
                 "expire": _ts(p.get("expireDate"))}
                for p in packs if isinstance(p, dict)
            ]
    else:
        out["balance"] = None
        out["balance_note"] = f"余额接口未返回可用数据（HTTP {c3}）"

    if credit is None and out.get("balance") is not None:
        out["detail"] = (out.get("detail", "") +
                         f" 当前余额 {out['balance']:g} 积分。").strip()
    return out


def _ts(v) -> str | None:
    """Unix 秒 → 'YYYY-MM-DD'（本地时区）。"""
    if not isinstance(v, (int, float)) or v <= 0:
        return None
    try:
        return datetime.datetime.fromtimestamp(v).strftime("%Y-%m-%d")
    except (OSError, OverflowError, ValueError):
        return None


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------
def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    argv = sys.argv[1:]
    if argv and "--status" not in argv and "--balance" not in argv:
        print("用法：python adapters/dumate.py [--status|--balance]")
        return 2
    # --status 只读（演练），无参数则真实签到
    dry = "--status" in argv or "--balance" in argv
    r = run(dry_run=dry)
    print(json.dumps(r, ensure_ascii=False, indent=2))
    return 0 if r.get("result") in ("OK", "ALREADY", "DRY_RUN") else 1


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    sys.exit(main())
