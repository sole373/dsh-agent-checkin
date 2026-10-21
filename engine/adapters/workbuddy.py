#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
WorkBuddy / CodeBuddy CN 每日签到适配器

原理
----
WorkBuddy 客户端把 accessToken 以 AES-256-GCM 加密后存进
`%LOCALAPPDATA%\\CodeBuddyExtension\\Data\\Public\\auth\\workbuddy-desktop.info`，
密钥（atRestSecretKey）只能通过客户端自身的 Electron 原生绑定取得。
因此本模块**不自行实现解密**，而是用 `ELECTRON_RUN_AS_NODE=1` 启动客户端可执行文件，
运行 `wb_decrypt.js` 完成解密——明文只经内存管道返回，不落盘、不出现在命令行。

设计原则
--------
- 只读本机登录态，不外传、不打印令牌（日志自动脱敏）。
- 幂等：先查状态，已签则跳过。
- 失败即停并告警，不做任何绕过风控的尝试。

自检
----
    python workbuddy.py --inspect    # 检查凭据与解密链路（不打印令牌）
    python workbuddy.py --status     # 查询签到状态
    python workbuddy.py              # 执行签到
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

import http_direct as _http  # 直连（绕环境代理），见 http_direct.py

AUTH_RELATIVE = os.path.join("CodeBuddyExtension", "Data", "Public", "auth",
                             "workbuddy-desktop.info")
AUTH_RELATIVE_AI = os.path.join("CodeBuddyExtension", "Data", "Public", "auth",
                                "workbuddy-desktop-ai.info")

STATUS_PATH = "/v2/billing/meter/checkin-activity-status"
CLAIM_PATH = "/v2/billing/meter/daily-checkin"

_HELPER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "wb_decrypt.js")

# 已知可执行文件位置（可用环境变量 WORKBUDDY_EXE 覆盖）
_EXE_CANDIDATES = [
    r"C:\Program Files\WorkBuddy\WorkBuddy.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe"),
]


def find_runtime() -> str:
    """定位 WorkBuddy 客户端可执行文件（用作 Electron 运行时）。"""
    override = os.environ.get("WORKBUDDY_EXE")
    if override and os.path.isfile(override):
        return override
    for p in _EXE_CANDIDATES:
        if os.path.isfile(p):
            return p
    raise FileNotFoundError("未找到 WorkBuddy.exe，可用环境变量 WORKBUDDY_EXE 指定")


def _candidate_auth_files() -> list[str]:
    base = os.environ.get("LOCALAPPDATA") or os.path.expandvars(r"%LOCALAPPDATA%")
    return [os.path.join(base, AUTH_RELATIVE), os.path.join(base, AUTH_RELATIVE_AI)]


def _run_helper(operation: str, value=None, timeout: int = 90) -> dict:
    """调用 Electron 运行时执行解密助手。"""
    env = {k: v for k, v in os.environ.items()
           if not k.upper().startswith(("NODE_", "ELECTRON_", "WORKBUDDY_"))}
    env["ELECTRON_RUN_AS_NODE"] = "1"
    payload = json.dumps({"operation": operation, "value": value}).encode("utf-8")
    proc = subprocess.run([find_runtime(), _HELPER], input=payload,
                          capture_output=True, env=env, timeout=timeout)
    try:
        return json.loads(proc.stdout.decode("utf-8", "replace"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return {"ok": False, "error": "BAD_STDOUT",
                "stderr": proc.stderr.decode("utf-8", "replace")[:400]}


def load_credentials(auth_file: str | None = None, prefer_cn: bool = True) -> dict:
    """
    读取本机 WorkBuddy 登录态并解密 accessToken。

    存在两个凭据文件：`workbuddy-desktop.info`（国内版 codebuddy.cn）与
    `workbuddy-desktop-ai.info`（国际版 workbuddy.ai）。默认优先国内版。
    """
    paths = [auth_file] if auth_file else [p for p in _candidate_auth_files()
                                          if os.path.isfile(p)]
    if not paths:
        raise FileNotFoundError("未找到 WorkBuddy 凭据文件，请先在客户端登录")

    sessions = []
    for p in paths:
        try:
            sessions.append((p, json.load(open(p, encoding="utf-8"))))
        except (OSError, json.JSONDecodeError):
            continue
    if not sessions:
        raise ValueError("凭据文件无法解析")

    if prefer_cn:
        cn = [s for s in sessions
              if "codebuddy.cn" in str((s[1].get("auth") or {}).get("domain", ""))]
        if cn:
            sessions = cn

    src, sess = sessions[0]
    auth = sess.get("auth") or {}
    account = sess.get("account") or {}

    token_field = auth.get("accessToken")
    if isinstance(token_field, str):
        token = token_field                      # 老版本为明文
        decrypt_used = False
    else:
        result = _run_helper("decrypt", token_field)
        if not result.get("ok"):
            raise RuntimeError(f"令牌解密失败：{result.get('error')} "
                               f"{result.get('stderr', '')}")
        token = result["accessToken"]
        decrypt_used = True

    domain = auth.get("domain") or "www.codebuddy.cn"
    return {
        "source": src,
        "accessToken": token,
        "uid": account.get("uid"),
        "nickname": account.get("uin"),
        "enterpriseId": account.get("enterpriseId"),
        "domain": domain,
        "base": f"https://{domain}",
        "decrypted": decrypt_used,
    }


def _request(url: str, creds: dict, timeout: int = 20):
    headers = {
        "Accept": "application/json",
        "Authorization": f"Bearer {creds['accessToken']}",
        "Content-Type": "application/json",
        "User-Agent": "WorkBuddy",
    }
    if creds.get("uid"):
        headers["X-User-Id"] = str(creds["uid"])
    if creds.get("enterpriseId"):
        headers["X-Enterprise-Id"] = str(creds["enterpriseId"])
        headers["X-Tenant-Id"] = str(creds["enterpriseId"])
    if creds.get("domain"):
        headers["X-Domain"] = str(creds["domain"])

    req = urllib.request.Request(url, data=b"", headers=headers, method="POST")
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
    return _request(creds["base"] + STATUS_PATH, creds)


def claim(creds: dict):
    return _request(creds["base"] + CLAIM_PATH, creds)


# ---------------------------------------------------------------------------
# 账户真实可用额度（区别于签到活动的 total_credits）
# ---------------------------------------------------------------------------
# 口径来源：客户端 main/tar.js 的 getCurrentPlan()/fetchResourceSummary()
#   - billingPrefix   = "/v2"  → 签到接口   /v2/billing/meter/daily-checkin
#   - resourcePrefix  = ""    → 额度接口   /billing/meter/get-user-resource-summary
# 注意：额度三接口**没有 /v2 前缀**（网关路由声明为无前缀），
#      与签到接口不同 —— 这是当初误用 /v2 前缀得到 404 的原因。
BALANCE_PATH = "/billing/meter/get-user-resource-summary"


def query_balance(creds: dict):
    """查询账户可用额度（各资源包 周期剩余 之和）。

    返回 (code, body)。字段口径照抄客户端 parseResourceSummary()：
      data.Packages[].CycleRemainCapacity / CycleTotalCapacity / CycleUsedCapacity
    注意这些字段是**字符串**（float 精度），需自行转换。
    """
    return _request(creds["base"] + BALANCE_PATH, creds)


def parse_balance(body) -> dict:
    """把 get-user-resource-summary 响应规范化为结构化余额。

    口径说明（不自行发明，照抄客户端）：
      - 每个 Package 的 CycleRemainCapacity = 本周期剩余
      - 可用额度 = Σ CycleRemainCapacity
      - 这是**账户真实可用额度**，与签到活动的 total_credits 是两个口径
    """
    if not isinstance(body, dict):
        return {"error": f"非预期响应：{str(body)[:120]}"}
    root = body.get("data") if isinstance(body.get("data"), dict) else body
    pkgs = root.get("Packages") or []

    def _f(v):
        try:
            return float(v)
        except (TypeError, ValueError):
            return 0.0

    total = sum(_f(p.get("CycleTotalCapacity")) for p in pkgs)
    used = sum(_f(p.get("CycleUsedCapacity")) for p in pkgs)
    remain = sum(_f(p.get("CycleRemainCapacity")) for p in pkgs)
    # 单位：接口里出现 "credits"/"credit" 两种（单复数），统一按"积分"
    return {
        "remaining": round(remain, 2),
        "total": round(total, 2),
        "used": round(used, 2),
        "packages": [{
            "code": p.get("PackageCode"),
            "total": round(_f(p.get("CycleTotalCapacity")), 2),
            "remain": round(_f(p.get("CycleRemainCapacity")), 2),
            "used": round(_f(p.get("CycleUsedCapacity")), 2),
            "count": p.get("TotalCount"),
        } for p in pkgs],
        "is_paid": bool(root.get("IsPaidUser")),
    }


def _is_already_checked_in(body) -> bool:
    if body is None:
        return True
    if isinstance(body, dict):
        if body.get("code") == 10001:
            return True
        if "已签" in str(body.get("msg") or ""):
            return True
    return False


def run(dry_run: bool = False) -> dict:
    """执行一轮签到。返回结构化结果。"""
    creds = load_credentials()
    out = {"platform": "WorkBuddy CN", "account": creds.get("nickname"),
           "source": creds["source"]}

    code, body = query_status(creds)
    out["status_http"] = code
    if code == -1:
        return {**out, "result": "NETWORK", "detail": body}
    if code == 401:
        return {**out, "result": "AUTH_REJECTED", "detail": "令牌被拒，需重新登录客户端"}
    if code == 403:
        return {**out, "result": "FORBIDDEN", "detail": body}
    if code != 200:
        return {**out, "result": "ERROR", "detail": body}

    # 响应形如 {"code":0,"msg":"OK","data":{...}}，真实字段在 data 里
    root = body if isinstance(body, dict) else {}
    status = root.get("data") if isinstance(root.get("data"), dict) else root
    if status.get("active") is False:
        return {**out, "result": "INACTIVE", "detail": "签到活动未开启"}

    today = status.get("today_checked_in")
    if today in (True, 1):
        return {**out, "result": "ALREADY", "detail": "今日已签到",
                "credit": status.get("today_credit"),
                "streak_days": status.get("streak_days"),
                "total_credits": status.get("total_credits"),
                "status": status}

    if dry_run:
        return {**out, "result": "DRY_RUN", "detail": "演练：今日未签，将执行领取",
                "status": status}

    code2, body2 = claim(creds)
    out["claim_http"] = code2
    if code2 == -1:
        return {**out, "result": "NETWORK", "detail": body2}
    if _is_already_checked_in(body2):
        return {**out, "result": "ALREADY", "detail": "今日已签到（服务端确认）"}
    if code2 != 200:
        return {**out, "result": "ERROR", "detail": body2}

    root2 = body2 if isinstance(body2, dict) else {}
    data = root2.get("data") if isinstance(root2.get("data"), dict) else root2
    return {**out, "result": "OK",
            "credit": data.get("credit") or data.get("today_credit"),
            "streak_days": data.get("streak_days"),
            "total_credits": data.get("total_credits"),
            "detail": data}


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if "--inspect" in sys.argv:
        creds = load_credentials()
        print("凭据来源:", creds["source"])
        print("接口主机:", creds["base"])
        print("账号:", creds.get("nickname"), "| uid:", creds.get("uid"))
        print("令牌: 长度", len(creds["accessToken"]),
              "| 解密取得:", creds["decrypted"])
        probe = _run_helper("probe")
        print("解密运行时:", "可用" if probe.get("ok") else f"不可用 {probe.get('error')}")
        return 0
    if "--status" in sys.argv:
        creds = load_credentials()
        code, body = query_status(creds)
        print(f"HTTP {code}")
        print(json.dumps(body, ensure_ascii=False, indent=2)[:2000])
        return 0
    result = run(dry_run="--dry-run" in sys.argv)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
