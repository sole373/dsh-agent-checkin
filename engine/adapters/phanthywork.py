#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PhanthyWork 适配器 —— 「启动即发放」型：只读本地启动痕迹，不发送任何领取请求。

机制说明（决定了本适配器"不做什么"）
------------------------------------
PhanthyWork（`code.phanthy.com`，安装于 `%LOCALAPPDATA%\\PhanthyWork`）是
Tauri + WebView2 应用，「每日登录奖励」在**打开客户端时自动发放**。

⚠️ 它**确实有**云端领取接口，但本适配器**故意不调用**：
    本地路径   POST /api/daily-activity/claim
    上游路径   POST /api/oauth/activities/daily-login/claim
    网关       https://code.phanthy.com
    鉴权       Authorization: Bearer <token>
               + x-desktop-installation-id / -timestamp / -nonce / -signature

其中 x-desktop-signature 是 **Ed25519 签名**（二进制内标识
``daily-activity-ed25519-v4``），私钥存放在 **Windows 凭据管理器**
（条目名形如 ``daily-activity-ed25519-v4:<key>.com.phanthy.code.desktop``，
Type=1 通用凭据，32 字节，DPAPI 绑定当前用户）。
→ 复现该请求必须导出私钥并重放签名，等于**绕过应用的防伪机制**，
  违反本项目「不伪造身份、不绕过风控」的纪律（与 TRAE 9074 同一原则）。
  故本适配器**只读**，不做任何领取动作。2026-10-01 实测：无签名的
  `/api/oauth/activities/summary` 等只读端点一律 `401 missing_login`，
  亦无旁路可用。

判定依据（比 mtime 更硬）
-------------------------
WebView2 的 Local Storage（leveldb）里有两个**应用自记**的每日键：

  phanthy.activity-notice.daily-launch-count = {"date":"2026-10-01","count":1}
      ↑ 应用自己写下「日期 + 当日启动次数」，**自带日期**，
        不需要靠文件 mtime 去推断是哪一天 —— 这是它优于千问的地方。
  phanthy.daily-activity.acknowledged-rewards = ["<id>", ...]
      ↑ 应用自记「已确认领取的奖励 ID」。

故本适配器直接读这两个键，不依赖 mtime 猜测。

余额
----
**拿不到**（只读接口需 Bearer，无旁路）。按诚实性铁律 1：
`balance` 留 `None` 并注明原因，绝不编数字。尊主可手工记账补充。

口径（2026-10-01 尊主定）
------------------------
今天启动过（daily-launch-count.date == 今天） → ALREADY（视为已签到）
今天没启动                                   → READONLY（不可知）

用法
----
    python adapters/phanthywork.py            # 只读核对
    python adapters/phanthywork.py --balance  # 同上
"""
from __future__ import annotations

import datetime
import json
import os
import re
import sys

# --------------------------------------------------------------------------
# 常量
# --------------------------------------------------------------------------
APP_DIR_REL = os.path.join("com.phanthy.work.desktop", "EBWebView")
# Tauri 的应用标识（Windows 凭据管理器条目后缀，见模块头注释）
APP_ID = "com.phanthy.code.desktop"

KEY_LAUNCH_COUNT = "phanthy.activity-notice.daily-launch-count"
KEY_ACK_REWARDS = "phanthy.daily-activity.acknowledged-rewards"


# --------------------------------------------------------------------------
# 路径
# --------------------------------------------------------------------------
def user_data_dir() -> str:
    """PhanthyWork 的 WebView2 数据目录。

    可被环境变量 PHANTHYWORK_USER_DATA 覆盖（开源化：零硬编码）。
    """
    env = os.environ.get("PHANTHYWORK_USER_DATA")
    if env:
        return env
    local = os.environ.get("LOCALAPPDATA")
    if not local:
        local = os.path.join(os.path.expanduser("~"), "AppData", "Local")
    return os.path.join(local, APP_DIR_REL)


def leveldb_dir() -> str:
    return os.path.join(user_data_dir(), "Default", "Local Storage", "leveldb")


def launch_paths() -> list[str]:
    """启动痕迹候选文件 —— 供 launch_trace 兜底（与应用自记日期互为校验）。

    leveldb 的表文件与日志都会在应用运行/退出时写入，mtime 保留。
    """
    d = leveldb_dir()
    out = []
    for name in ("LOG", "CURRENT", "MANIFEST-000001"):
        p = os.path.join(d, name)
        if os.path.isfile(p):
            out.append(p)
    return out


# --------------------------------------------------------------------------
# 读 leveldb（纯字节扫描，不依赖第三方库）
# --------------------------------------------------------------------------
def _iter_leveldb_bytes():
    """按写入时间顺序产出 leveldb 文件的原始字节。

    ⚠️ 为什么不用第三方 leveldb 库：本项目纪律是**零外部依赖**（标准库为主）。
    这里的键是固定 ASCII 前缀、值是紧凑 JSON，做**定向字节扫描**即可，
    既免依赖也避免把整个库反序列化进内存。
    """
    d = leveldb_dir()
    if not os.path.isdir(d):
        return
    # .log 是新的，.ldb 是已压缩的旧表 —— 先 log（后写）再 ldb
    files = []
    try:
        names = os.listdir(d)
    except OSError:
        return
    for nm in sorted(names):
        if nm.endswith(".log") or nm.endswith(".ldb"):
            p = os.path.join(d, nm)
            try:
                files.append((os.path.getmtime(p), nm.endswith(".log"), p))
            except OSError:
                continue
    # 先 .log（通常最新），再 .ldb 倒序
    files.sort(key=lambda x: (x[1], x[0]), reverse=True)
    for _m, _isl, p in files:
        try:
            with open(p, "rb") as fh:
                yield p, fh.read()
        except OSError:
            continue


def read_json_value(key: str):
    """从 Local Storage 里取某个键的 JSON 值（取最后一次出现 = 最新写入）。

    返回 (值, 来源文件)；找不到返回 (None, None)。
    """
    kb = key.encode("utf-8")
    best = None
    src = None
    for path, blob in _iter_leveldb_bytes():
        # 取该文件里最后一次出现（同一文件中后写覆盖先写）
        idx = blob.rfind(kb)
        if idx < 0:
            continue
        raw = blob[idx + len(kb): idx + len(kb) + 4096]
        val = _extract_json(raw)
        if val is not None:
            if best is None:          # 第一个命中的文件即最新（已排序）
                best, src = val, os.path.basename(path)
    return best, src


def _extract_json(raw: bytes):
    """从键后面的字节里抠出第一个完整的 JSON 值（对象或数组）。"""
    # 跳过 leveldb 的 1 字节 value-type 标记与少量分隔符
    i = 0
    while i < len(raw) and raw[i] not in b"{[":
        i += 1
        if i > 12:
            return None
    if i >= len(raw):
        return None
    s = raw[i:].decode("utf-8", "replace")
    # 括号配平（忽略字符串内的括号）
    pairs = {"{": "}", "[": "]"}
    stack = []
    in_str = False
    esc = False
    for j, ch in enumerate(s):
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch in pairs:
            stack.append(pairs[ch])
        elif ch in "}]":
            if not stack or ch != stack[-1]:
                return None
            stack.pop()
            if not stack:
                try:
                    return json.loads(s[: j + 1])
                except json.JSONDecodeError:
                    return None
    return None


def read_launch_count() -> tuple[dict | None, str | None]:
    """读「当日启动计数」—— 应用自记，自带日期。

    → ({"date": "2026-10-01", "count": 1}, 来源文件) 或 (None, None)
    """
    val, src = read_json_value(KEY_LAUNCH_COUNT)
    if isinstance(val, dict) and isinstance(val.get("date"), str):
        return val, src
    return None, src


def read_acknowledged_rewards() -> tuple[list | None, str | None]:
    """读「已确认领取的奖励 ID 列表」。"""
    val, src = read_json_value(KEY_ACK_REWARDS)
    if isinstance(val, list):
        return val, src
    return None, src


# --------------------------------------------------------------------------
# 判定
# --------------------------------------------------------------------------
def launched_today() -> tuple[bool, str]:
    """今天是否启动过 —— 首选「应用自记日期」，回退到文件 mtime。

    :return: (今天是否启动过, 证据描述)
    """
    today = datetime.date.today().isoformat()

    rec, src = read_launch_count()
    if rec:
        d = rec.get("date")
        cnt = rec.get("count")
        if d == today:
            return True, f"{KEY_LAUNCH_COUNT}=date {d}, count {cnt}（{src}）"
        return False, f"{KEY_LAUNCH_COUNT} 记录的是 {d}（非今天，{src}）"

    # 回退：leveldb 文件 mtime（与应用自记日期互为校验）
    from adapters import launch_trace  # 延迟导入，避免循环
    ok, ev = launch_trace.launched_today(launch_paths())
    if ev:
        return ok, f"回退到文件 mtime（{ev}{'，今天' if ok else '，非今天'}）"
    return False, "未找到任何启动痕迹"


# --------------------------------------------------------------------------
# 统一入口
# --------------------------------------------------------------------------
def run(dry_run: bool = False) -> dict:
    """只读核对。本适配器**无领取动作**（原因见模块头注释）。

    结果码：
      今天启动过 → ALREADY（按「启动即发放」视为已签到，计入「签到正常」分子）
      今天没启动 → READONLY（只读核对，既不算成功也不算失败）
    """
    out = {"platform": "PhanthyWork"}

    if not os.path.isdir(leveldb_dir()):
        out.update(result="ERROR",
                   detail=f"未找到 PhanthyWork 数据目录：{leveldb_dir()}"
                          f"（未安装或从未运行过）")
        return out

    launched, evidence = launched_today()

    ack, ack_src = read_acknowledged_rewards()
    out["acknowledged_rewards"] = len(ack) if ack else 0

    # 余额：只读接口需 Ed25519 签名 + Bearer，本项目**不绕过**签名机制（见模块头）
    out["balance"] = None
    out["balance_unit"] = "积分"
    out["balance_note"] = "无本地余额接口（云端需 Ed25519 签名，本项目不绕过）"
    out["launched_today"] = launched
    out["launch_evidence"] = evidence

    tail = ("该平台为「启动即发放」型：打开客户端即自动发放当日登录奖励，"
            "无独立领取动作。签到状态依据应用自记的 local-storage 键"
            f"（{KEY_LAUNCH_COUNT}）；余额需签名接口，本项目不绕过故不可得。")

    if launched:
        out["result"] = "ALREADY"
        out["detail"] = f"今日已启动过客户端（{evidence}）→ 按「启动即发放」口径视为已签到。{tail}"
    else:
        out["result"] = "READONLY"
        out["detail"] = f"今日未检测到启动痕迹（{evidence}）→ 状态保持不可知。{tail}"
    return out


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    argv = sys.argv[1:]
    if argv and "--status" not in argv and "--balance" not in argv:
        print("用法：python adapters/phanthywork.py [--status|--balance]")
        return 2
    r = run()
    print(json.dumps(r, ensure_ascii=False, indent=2))
    return 0 if r.get("result") in ("READONLY", "ALREADY") else 1


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    sys.exit(main())
