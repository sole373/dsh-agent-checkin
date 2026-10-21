#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""WorkBuddy 国际版（workbuddy.ai）—— 只读核对适配器

为什么是「只读」而不是「签到」
------------------------------
国际版与国内版**同一套客户端、同一套接口路径**，仅靠 `isOversea` 切换端点
（客户端 `build/patches/workbuddy-ai/product.json` 显式置 true）。

但实测（2026-09-27）本账号：
    POST /v2/billing/meter/checkin-activity-status → 200, active=false
    POST /v2/billing/meter/daily-checkin          → 400 "签到活动未开启或已过期"
    data.total_credits = 0

即：**接口通、活动配置存在**（activity_name「本期：专家能量包」、
theme_name「Buddy 加油站」、daily_credit=100），但**服务端判定该账号活动未开启**。

另经尊主确认：国际版的「每日 30 积分」是**登录即自动到账、无提示**，
不走签到接口，本就不需要脚本领取。

所以本模块**只做只读核对**：
  - 查活动状态（如实标注 active=false）
  - 查账户真实可用额度（get-user-resource-summary）
**不调用 daily-checkin** —— 明知会被拒，每天记一条失败毫无价值。

结果码用 `READONLY`：既不算成功、也不算失败，且**不计入「签到正常 N/M」分子**，
避免让"签到数"这个数字撒谎。

凭证
----
`%LOCALAPPDATA%\\CodeBuddyExtension\\Data\\Public\\auth\\workbuddy-desktop-ai.info`
（域名 www.workbuddy.ai；与国内版同款 AES-256-GCM 信封，复用 wb_decrypt.js）

自检
----
    python workbuddy_intl.py --inspect
    python workbuddy_intl.py            # 只读核对
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import workbuddy as _wb  # noqa: E402
import launch_trace  # noqa: E402

INTL_AUTH_RELATIVE = os.path.join("CodeBuddyExtension", "Data", "Public", "auth",
                                  "workbuddy-desktop-ai.info")


def intl_auth_path() -> str:
    base = os.environ.get("LOCALAPPDATA") or os.path.expandvars(r"%LOCALAPPDATA%")
    return os.path.join(base, INTL_AUTH_RELATIVE)


def launch_paths() -> list[str]:
    """启动痕迹候选文件 —— 国际版客户端启动/运行时会持续写这个凭据文件。

    客户端关闭后 mtime 原样保留，故可用于判定「今天启动过」。
    """
    return [intl_auth_path()]


def load_credentials() -> dict:
    """读取国际版凭据。找不到就抛 FileNotFoundError（与国内版行为一致）。"""
    path = intl_auth_path()
    if not os.path.isfile(path):
        raise FileNotFoundError(
            f"未找到国际版凭据：{path}\n"
            f"请先在 WorkBuddy 国际版客户端登录一次。")
    creds = _wb.load_credentials(auth_file=path)
    # 双重保险：确认读到的确实是国际版，防止误读成国内版
    if "workbuddy.ai" not in str(creds.get("domain") or ""):
        raise ValueError(f"凭据域名非 workbuddy.ai：{creds.get('domain')}")
    return creds


def run(dry_run: bool = False) -> dict:
    """只读核对：活动状态 + 账户可用额度。dry_run 对本模块无实际差异。"""
    out = {"platform": "WorkBuddy 国际版", "readonly": True}

    creds = load_credentials()
    out["account"] = creds.get("nickname")
    out["domain"] = creds.get("domain")

    # --- 1) 活动状态（只读） ---
    code, body = _wb.query_status(creds)
    if code == -1:
        return {**out, "result": "NETWORK", "detail": body}
    if code in (401, 403):
        return {**out, "result": "AUTH_REJECTED",
                "detail": "国际版令牌被拒，请在客户端重新登录"}
    if code != 200 or not isinstance(body, dict):
        return {**out, "result": "ERROR", "detail": f"HTTP {code}：{str(body)[:180]}"}

    d = body.get("data") if isinstance(body.get("data"), dict) else body
    active = bool(d.get("active"))
    out["activity_active"] = active
    out["activity_name"] = d.get("activity_name")
    out["theme_name"] = d.get("theme_name")
    out["today_checked_in"] = bool(d.get("today_checked_in"))
    out["daily_credit"] = d.get("daily_credit")
    out["total_credits"] = d.get("total_credits")
    out["claimed_credit"] = d.get("today_credit")

    # --- 2) 账户可用额度（只读；与签到活动是两个口径） ---
    bcode, bbody = _wb.query_balance(creds)
    if bcode == 200 and isinstance(bbody, dict):
        bal = _wb.parse_balance(bbody)
        if not bal.get("error"):
            out["balance"] = bal["remaining"]
            out["balance_total"] = bal["total"]
            out["balance_used"] = bal["used"]
            out["balance_packages"] = bal["packages"]
            out["is_paid"] = bal["is_paid"]
    else:
        out["balance_error"] = f"HTTP {bcode}：{str(bbody)[:120]}"

    # READONLY：不进成功集合，也不进失败集合（详见 checkin.py 计数口径）
    if active and not out["today_checked_in"]:
        out["detail"] = ("活动【已开启】且今日未签 —— 本模块为只读核对，"
                         "未执行领取；如需自动领取请另行启用。")
    elif active:
        out["detail"] = "活动已开启，今日已签到。"
    else:
        out["detail"] = (f"签到活动未开启（active=false）。活动名「{d.get('activity_name') or '—'}」，"
                         f"签到奖励 {d.get('daily_credit')} 积分，本账号累计 {d.get('total_credits')}。"
                         f"国际版「每日登录自动发放」不走此接口，开软件即自动到账。")

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
                         f"口径视为已签到（本模块不执行领取动作）。{out['detail']}")
    else:
        out["result"] = "READONLY"
        out["detail"] = (f"今日未检测到客户端启动痕迹（依据 {evidence or '凭据文件'} 的"
                         f"修改时间）→ 状态保持不可知。{out['detail']}")
    return out


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    if "--inspect" in sys.argv:
        path = intl_auth_path()
        print("凭据文件:", path, "| 存在:", os.path.isfile(path))
        try:
            creds = load_credentials()
            print("域名     :", creds["domain"])
            print("账号     :", creds.get("nickname"))
            print("解密取得 :", creds["decrypted"], "| 令牌长度:", len(creds["accessToken"]))
        except Exception as exc:  # noqa: BLE001
            print("加载失败 :", type(exc).__name__, exc)
            return 1
        return 0

    result = run(dry_run="--dry-run" in sys.argv)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    # READONLY 视为正常（无失败语义）
    return 0 if result.get("result") in ("READONLY", "DRY_RUN") else 1


if __name__ == "__main__":
    sys.exit(main())
