#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
即梦 AI（Dreamina）每日免费额度领取适配器 —— 浏览器回退方案

什么时候用这个
--------------
`jimeng.py` 已改为**直连签名**方案（更快、无需浏览器）。本模块是它的**回退**：

    当直连持续返回 `{"ret":"1014","errmsg":"system busy"}`（签名被风控或公式失效）时，
    改用浏览器访问——即梦网页版在**页面加载时就会自动调用领取接口**，
    让浏览器带着已登录会话打开一次首页即可完成。

浏览器逻辑已抽到公用模块 `browser_visit.py`（与可灵共用）。

用法
----
    python jimeng_browser.py --login      # 首次：打开浏览器登录即梦（只需一次）
    python jimeng_browser.py --inspect    # 检查浏览器与登录态目录
    python jimeng_browser.py --visible    # 带界面运行一次（排查问题时用）
    python jimeng_browser.py              # 默认：无头运行，自动领取
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import browser_visit as bv  # noqa: E402

SITE = "https://jimeng.jianying.com/"
PROFILE = bv.profile_dir("jimeng")

# 登录态真校验用：即梦的会话 Cookie 在 .jianying.com 域下
HOST = "jianying.com"
LOGIN_KEYS = ("sessionid",)


def run(dry_run: bool = False, headless: bool = True,
        wait_seconds: int = 45) -> dict:
    out = {"platform": "即梦 AI"}

    logged, why = bv.login_status(PROFILE, HOST, LOGIN_KEYS)
    out["login"] = why
    if not logged:
        return {**out, "result": "ERROR",
                "detail": (f"即梦登录态不可用：{why}\n"
                           f"请执行：python jimeng_browser.py --login 登录一次")}

    if dry_run:
        return {**out, "result": "DRY_RUN",
                "detail": f"演练：登录态就绪（{why}），将无头访问 {SITE} 触发自动领取"}

    info = bv.visit(PROFILE, SITE, wait_seconds=wait_seconds, headless=headless)
    return {
        **out,
        "result": "DONE",
        "mode": info["mode"],
        "waited": info["waited"],
        "profile": info["profile"],
        "detail": ("已打开即梦首页并等待页面自动领取。服务端按天幂等，"
                   "重复运行不会重复发放。请到「我的 → 积分」核对当日额度。"),
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
        return bv.login(PROFILE, SITE, "即梦")

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
