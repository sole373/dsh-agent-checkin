#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
千问办公 QwenWork（qwenwork.cn）适配器 —— 只读余额核对

机制说明（重要，决定了本适配器"不做什么"）
------------------------------------------
千问办公**不是点击签到型**，而是「启动 / 登录即发放」型：客户端开机自启、
打开即完成发放。所以本适配器**不发送任何领取请求**，职责只有三件事：
  1. 解密本地登录态，确认还有效；
  2. 调官方网关的钱包接口读当前积分余额；
  3. 把结果交给看板展示。
真正的「用完就关客户端」由 ../close_after_checkin.py 负责。

接口规格（实测通过）
--------------------
  GET https://gateway.qwenwork.cn/api/v1/adapter/user/wallets
      Authorization: Bearer <JWT>
  → data: {
        active_wallets:   { wallets:[ {balance, valid_to} ], total },
        daily_credits:    { total_balance },
        monthly_credits:  { total_balance },
        longterm_credits: { total_balance },
        expiring_soon:    { count, total_balance, wallets:[] }
    }

  （同域另有 /api/v3/user/status、/api/v1/adapter/user/account-context 可交叉校验登录态）

⚠️ 为什么本平台没有"今日是否已签到"
-----------------------------------
客户端代码里确实存在两个签到接口：
    /sash/api/v1/me/daily-check-in/status   （只读）
    /sash/api/v1/me/daily-check-in/claim    （领取）
但它们**实测不可用**：gateway.qwenwork.cn / qwenwork.cn / api.qwenwork.cn
三个候选基址上一律 404，且客户端日志里**从未出现**该接口的调用或
"Resolved Sash API base URL" 记录 —— 说明「积分成长卡」功能未对本账号启用。

更要紧的一点（差点踩坑）：`daily_credits` 在客户端代码里与
`daily_quota` / `dailyCredits` / `dailyQuota` **互为别名**：
    B = { daily: F(T, ["daily_quota","dailyQuota","daily_credits","dailyCredits"]), ... }
它是**每日配额**，每天自动重置，与"签到奖励 100"数值相同纯属巧合。
**不能**把它当成签到证据。因此本平台签到状态一律标为「不可知 / 无接口」。

凭证（本机自动读取，无需任何手工录入）
--------------------------------------
  userData = %APPDATA%\\QwenWorkCN
    auth-v2.dat                  ← 真实登录态（v2，JWT + Ory refresh token）
    auth.dat                     ← 旧版 v1，本机实测是占位 token，不可用
    Local State                  ← os_crypt.encrypted_key，DPAPI 保护的 AES 主密钥

  加密格式 = Chromium OSCrypt v10（Electron safeStorage 在 Windows 的落地格式）：
      "v10" + nonce(12 字节) + ciphertext + authTag(16 字节)   ← AES-256-GCM
  解密分两步（详见 qw_gcm.js 顶部注释）：
      DPAPI 解主密钥 → Python ctypes（标准库）
      AES-256-GCM 解数据 → Node 内置 crypto（Python 标准库没有 AES，避免引入 pip 依赖）

用法
----
    python qwenwork.py --status     # 只查登录态 + 余额（默认即如此）
    python qwenwork.py              # 同上；本适配器无领取动作
"""

from __future__ import annotations

import base64
import ctypes
import ctypes.wintypes as wt
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
import launch_trace  # 启动痕迹判定，见 launch_trace.py

# --------------------------------------------------------------------------
# 常量
# --------------------------------------------------------------------------
APP_DIR_NAME = "QwenWorkCN"
AUTH_FILE_V2 = "auth-v2.dat"
AUTH_FILE_V1 = "auth.dat"
LOCAL_STATE = "Local State"

API_BASE = "https://gateway.qwenwork.cn"
PATH_WALLETS = "/api/v1/adapter/user/wallets"
PATH_ACCOUNT = "/api/v1/adapter/user/account-context?include=user"

USER_AGENT = "QoderWork"        # 客户端硬编码的 UA（见 asar 中 USER_AGENT$3）
TIMEOUT = 15

HERE = os.path.dirname(os.path.abspath(__file__))
GCM_JS = os.path.join(HERE, "qw_gcm.js")


# --------------------------------------------------------------------------
# 路径
# --------------------------------------------------------------------------
def user_data_dir() -> str:
    """千问办公的 userData 目录。"""
    env = os.environ.get("QWENWORK_USER_DATA")
    if env:
        return env
    appdata = os.environ.get("APPDATA")
    if not appdata:
        appdata = os.path.join(os.path.expanduser("~"), "AppData", "Roaming")
    return os.path.join(appdata, APP_DIR_NAME)


def launch_paths() -> list[str]:
    """启动痕迹候选文件 —— 客户端启动/运行时必写，关闭后 mtime 保留。

    故可用于判定「今天启动过」。取三者中 mtime 最大者为准。
    """
    ud = user_data_dir()
    return [
        os.path.join(ud, AUTH_FILE_V2),      # auth-v2.dat（登录态）
        os.path.join(ud, "Preferences"),     # Chromium 核心配置，启动/退出必写
        os.path.join(ud, "Local Storage"),   # 本地存储目录
    ]


def _find_node() -> str:
    """定位 node.exe —— 用于 AES-256-GCM（Python 标准库无 AES）。

    查找顺序：环境变量 → 托管运行时目录 → PATH。
    """
    for var in ("QW_NODE", "NODE_BIN"):
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
        "找不到 node.exe（解密千问办公凭证需要它做 AES-256-GCM）。"
        "可用环境变量 QW_NODE 显式指定路径。")


# --------------------------------------------------------------------------
# DPAPI：解出 Local State 里的 AES 主密钥
# --------------------------------------------------------------------------
class _DATA_BLOB(ctypes.Structure):
    _fields_ = [("cbData", wt.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]


_crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
_kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
_crypt32.CryptUnprotectData.argtypes = [
    ctypes.POINTER(_DATA_BLOB), ctypes.POINTER(ctypes.c_wchar),
    ctypes.POINTER(_DATA_BLOB), ctypes.c_void_p, ctypes.c_void_p,
    wt.DWORD, ctypes.POINTER(_DATA_BLOB),
]
_crypt32.CryptUnprotectData.restype = wt.BOOL
_kernel32.LocalFree.argtypes = [ctypes.c_void_p]
_kernel32.LocalFree.restype = ctypes.c_void_p


def _dpapi_decrypt(blob: bytes) -> bytes:
    buf = ctypes.create_string_buffer(blob, len(blob))
    din = _DATA_BLOB(len(blob), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    dout = _DATA_BLOB()
    if not _crypt32.CryptUnprotectData(ctypes.byref(din), None, None, None,
                                       None, 0, ctypes.byref(dout)):
        raise OSError("CryptUnprotectData 失败，GetLastError=%d"
                      % ctypes.get_last_error())
    try:
        return ctypes.string_at(dout.pbData, dout.cbData)
    finally:
        _kernel32.LocalFree(dout.pbData)


def load_master_key() -> bytes:
    """从 userData/Local State 取出 AES-256 主密钥（32 字节）。"""
    ls = os.path.join(user_data_dir(), LOCAL_STATE)
    if not os.path.isfile(ls):
        raise FileNotFoundError(f"未找到 {ls}（千问办公未安装或未运行过）")
    with open(ls, encoding="utf-8") as fh:
        cfg = json.load(fh)
    try:
        b64 = cfg["os_crypt"]["encrypted_key"]
    except (KeyError, TypeError):
        raise ValueError("Local State 中没有 os_crypt.encrypted_key") from None
    raw = base64.b64decode(b64)
    if raw[:5] != b"DPAPI":
        raise ValueError(f"主密钥不是 DPAPI 格式（前 5 字节={raw[:5]!r}）")
    key = _dpapi_decrypt(raw[5:])
    if len(key) != 32:
        raise ValueError(f"主密钥长度应为 32，实际 {len(key)}")
    return key


# --------------------------------------------------------------------------
# AES-256-GCM：解出 auth-v2.dat
# --------------------------------------------------------------------------
def _gcm_decrypt(key: bytes, raw: bytes) -> bytes:
    """v10 格式解密。明文只在内存与临时目录间传递，用完即删。"""
    node = _find_node()
    if not os.path.isfile(GCM_JS):
        raise FileNotFoundError(f"缺少解密助手 {GCM_JS}")
    tmp = tempfile.mkdtemp(prefix="qw_")
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


def load_auth() -> dict:
    """读取并解密登录态。优先 auth-v2.dat（真实凭证）。"""
    ud = user_data_dir()
    if not os.path.isdir(ud):
        raise FileNotFoundError(f"未找到千问办公数据目录：{ud}")

    path = os.path.join(ud, AUTH_FILE_V2)
    if not os.path.isfile(path):
        alt = os.path.join(ud, AUTH_FILE_V1)
        if os.path.isfile(alt):
            path = alt
        else:
            raise FileNotFoundError(
                f"{ud} 下既没有 {AUTH_FILE_V2} 也没有 {AUTH_FILE_V1}；"
                f"请在千问办公客户端里登录一次")

    with open(path, "rb") as fh:
        raw = fh.read()
    plain = _gcm_decrypt(load_master_key(), raw)
    obj = json.loads(plain.decode("utf-8"))

    token = obj.get("token") or ""
    if not token or token.startswith("placeholder"):
        raise ValueError(
            f"{os.path.basename(path)} 里是占位凭证，不是真实登录态。"
            f"请在千问办公客户端里重新登录")
    obj["_source_file"] = path
    return obj


def token_expired(auth: dict) -> bool:
    exp = auth.get("expiresAt")
    if not exp:
        return False
    try:
        t = datetime.datetime.fromisoformat(exp.replace("Z", "+00:00"))
    except ValueError:
        return False
    now = datetime.datetime.now(t.tzinfo) if t.tzinfo else datetime.datetime.now()
    return t <= now


# --------------------------------------------------------------------------
# 接口调用
# --------------------------------------------------------------------------
def _get(path: str, token: str) -> tuple[int, object]:
    req = urllib.request.Request(API_BASE + path, method="GET")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "application/json")
    req.add_header("User-Agent", USER_AGENT)
    req.add_header("X-QwenWork-Platform", "win32")
    try:
        with _http.urlopen(req, timeout=TIMEOUT) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            body = json.loads(exc.read().decode("utf-8"))
        except Exception:  # noqa: BLE001
            body = None
        return exc.code, body
    except Exception as exc:  # noqa: BLE001
        return -1, f"{type(exc).__name__}: {exc}"


def query_wallets(auth: dict) -> tuple[int, object]:
    """只读：查钱包余额。"""
    return _get(PATH_WALLETS, auth.get("token", ""))


def parse_wallets(body: object) -> dict:
    """把钱包响应压成看板要的扁平结构。"""
    data = body.get("data") if isinstance(body, dict) else None
    if not isinstance(data, dict):
        return {"error": "响应中没有 data"}

    def _tb(k: str):
        v = data.get(k)
        return v.get("total_balance") if isinstance(v, dict) else None

    daily, monthly, longterm = _tb("daily_credits"), _tb("monthly_credits"), _tb("longterm_credits")
    wallets = []
    for w in ((data.get("active_wallets") or {}).get("wallets") or []):
        if isinstance(w, dict):
            wallets.append({"balance": w.get("balance"),
                            "valid_to": (w.get("valid_to") or "")[:16].replace("T", " ")})
    total = round(sum(x for x in (daily, monthly, longterm) if isinstance(x, (int, float))), 4)
    return {
        "total": total, "daily": daily, "monthly": monthly, "longterm": longterm,
        "wallets": wallets,
        "expiring_soon": (data.get("expiring_soon") or {}).get("total_balance"),
    }


# --------------------------------------------------------------------------
# 统一入口
# --------------------------------------------------------------------------
def run(dry_run: bool = False) -> dict:
    """只读核对 + 启动痕迹判定。

    结果码（口径 2026-09-28 尊主定）：
      - 今天启动过客户端 → ALREADY（按「启动即发放」视为已签到，
        计入 checkin.py 的「签到正常」分子）
      - 今天没启动       → READONLY（只读核对，既不算成功也不算失败）
    判定依据见 launch_trace.launched_today()（只读本地痕迹文件 mtime，不碰凭据）。
    """
    out = {"platform": "千问办公 QwenWork"}
    try:
        auth = load_auth()
    except (FileNotFoundError, ValueError, OSError) as exc:
        out.update(result="ERROR", detail=f"凭证不可用：{exc}")
        return out

    user = auth.get("user") or {}
    out["account"] = user.get("name") or user.get("email")
    if token_expired(auth):
        out.update(result="AUTH_REJECTED",
                   detail=f"登录态已于 {auth.get('expiresAt')} 过期，请在客户端重新登录")
        return out

    code, body = query_wallets(auth)
    out["status_http"] = code
    if code == -1:
        out.update(result="NETWORK", detail=f"网络不可达：{body}")
        return out
    if code in (401, 403):
        out.update(result="AUTH_REJECTED", detail="登录态失效，请在千问办公客户端重新登录")
        return out
    if code != 200 or not isinstance(body, dict):
        out.update(result="ERROR", detail=f"HTTP {code}：{str(body)[:180]}")
        return out

    w = parse_wallets(body)
    out.update(w)

    base = (f"只读核对：日额度 {w['daily']} / 月额度 {w['monthly']} / "
            f"长期 {w['longterm']}，合计 {w['total']} 积分。"
            f"该平台为「启动即发放」型，无领取动作；"
            f"官方未提供今日签到状态接口。")

    # ---- 结果码（口径 2026-09-28 尊主定）----
    # 今天启动过客户端 → ALREADY：按「启动即发放」口径视为已签到，
    #   并计入 checkin.py 的「签到正常」分子；
    # 今天没启动 → READONLY：只读核对，既不算成功也不算失败，不虚增分子。
    launched, evidence = launch_trace.launched_today(launch_paths())
    out["launched_today"] = launched
    out["launch_evidence"] = evidence
    if launched:
        out["result"] = "ALREADY"
        out["detail"] = (f"今日已启动过客户端（痕迹 {evidence}）→ 按「启动即发放」"
                         f"口径视为已签到。{base}")
    else:
        out["result"] = "READONLY"
        out["detail"] = (f"今日未检测到客户端启动痕迹（依据 {evidence or '凭据文件'} 的"
                         f"修改时间）→ 状态保持不可知。{base}")
    return out


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------
def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    argv = sys.argv[1:]
    if "--status" not in argv and "--balance" not in argv and argv:
        print("用法：python adapters/qwenwork.py [--status|--balance]")
        return 2
    r = run()
    print(json.dumps(r, ensure_ascii=False, indent=2))
    return 0 if r.get("result") == "READONLY" else 1


if __name__ == "__main__":
    sys.exit(main())
