#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Coze 扣子（coze.cn）每日登录福利适配器 —— 浏览器方案

⚠️ 先读这段：本模块与其他平台的性质不同
------------------------------------------
扣子**没有领取接口**。它的机制是「**每日登录自动发放 1500 活动分**」——
也就是说，福利的触发条件是「以已登录状态访问 coze.cn」，而不是调用某个 API。

我实测确认：无 Cookie 访问 `www.coze.cn` 返回 200，但没有任何可直连的领取端点。

因此有两种做法：

| 做法 | 效果 |
|---|---|
| 只做「状态卡」（不少开源项目的选择） | **不会真的到账**，只是显示"Cookie 已配置" |
| **本模块：用已登录的浏览器打开一次首页** | 真正触发「登录」这一条件，**有可能到账** |

本模块选后者——因为前者对尊主毫无价值。

诚实交代
--------
**我无法确认无头浏览器访问是否真能触发发放**（那需要你的账号实测）。
扣子属于字节体系，风控较严，且「登录」可能被判定为需要真实交互。
所以本模块：
- 如实把结果标为 `verified: False`；
- 请你头几天到「个人中心 → 积分/活动分」核对一次；
- 若确认不到账，告诉我，我改方案（或如实告诉你这条路走不通，别浪费时间）。

实现方式：独立浏览器配置目录（不影响你日常浏览器），
首次用 `--login` 登录一次，之后每天无头访问。

用法
----
    python coze.py --login      # 首次：打开浏览器登录扣子（只需一次）
    python coze.py --inspect    # 检查浏览器与登录态目录
    python coze.py --visible    # 带界面运行一次（排查问题时用）
    python coze.py              # 默认：无头访问，触发每日福利
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import browser_visit as bv  # noqa: E402

SITE = "https://www.coze.cn/"
PROFILE = bv.profile_dir("coze")
DAILY_CREDIT = 1500

# 登录态真校验用：扣子属字节体系，这些 Cookie 名是登录后的标志
HOST = "coze.cn"
LOGIN_KEYS = ("passport_auth_status", "d_ticket", "sessionid", "odin_tt")


def run(dry_run: bool = False, headless: bool = True,
        wait_seconds: int = 45) -> dict:
    out = {"platform": "Coze 扣子", "daily_credit": DAILY_CREDIT}

    logged, why = bv.login_status(PROFILE, HOST, LOGIN_KEYS)
    out["login"] = why
    if not logged:
        return {**out, "result": "ERROR",
                "detail": (f"扣子登录态不可用：{why}\n"
                           f"请执行：python coze.py --login 打开浏览器登录一次")}

    if dry_run:
        return {**out, "result": "DRY_RUN",
                "detail": f"演练：登录态就绪（{why}），将无头访问 {SITE} 触发每日福利"}

    info = bv.visit(PROFILE, SITE, wait_seconds=wait_seconds, headless=headless)
    return {
        **out,
        "result": "DONE",
        "mode": info["mode"],
        "waited": info["waited"],
        "profile": info["profile"],
        "detail": (f"已访问 {SITE} 触发每日登录福利（{DAILY_CREDIT} 活动分）。"
                   "扣子无领取接口，福利由「登录」触发，服务端按天发放。"
                   "请到「个人中心」核对一次活动分是否到账。"),
        "verified": False,
    }


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    argv = sys.argv[1:]

    if "--inspect" in argv:
        return bv.inspect(PROFILE, HOST, LOGIN_KEYS)
    if "--login" in argv:
        return bv.login(PROFILE, SITE, "Coze 扣子")

    wait = 45
    for a in argv:
        if a.startswith("--wait="):
            wait = int(a.split("=", 1)[1])

    result = run(dry_run="--dry-run" in argv,
                 headless="--visible" not in argv,
                 wait_seconds=wait)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("result") in ("DONE", "DRY_RUN") else 1


if __name__ == "__main__":
    sys.exit(main())
