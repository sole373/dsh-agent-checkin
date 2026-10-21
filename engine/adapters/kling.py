#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
可灵 AI（Kling AI，快手）每日灵感值适配器 —— 浏览器方案

⚠️ 先读这段：本平台与「签到按钮」型平台性质不同
------------------------------------------------
可灵**没有签到按钮，也没有签到接口**。它的机制是
「**每日登录自动发放 66 灵感值**」——触发条件是「以已登录状态访问可灵」，
而不是调用某个领取 API。

我是怎么确认「没有签到接口」的（2026-09-27 实测，非猜测）
----------------------------------------------------------
1. **逆向主 JS 包**：下载 `klingai.com/app/` 引用的主包（约 697KB）后，
   扫描全部 `/api/` 路径，得到 27 条真实接口，**没有任何一条**含
   `checkin` / `check-in` / `daily` 领取语义；只有 `/api/incentive/progress`、
   `/api/incentive/achievements`（激励任务体系）、`/api/onboarding/surveys/claim`
   （问卷领取）。主包里唯一的 `signIn` 指的是**登录**动作，不是签到。
2. **证据：`monthly_free_credits`**——主包里出现该字段 + `rewardPoints`，
   即「每月免费额度自动发放」，与「每月 1 日自动到账」的说法吻合。
3. **后端路由探测**：我构造了 `/api/user/checkin`、`/api/user/daily-checkin`、
   `/api/checkin`、`/api/user/sign-in` 等候选路径逐个请求。可灵后端对
   **不存在的路由统一返回 `{"status":500,"error":{"type":"MID.S4B"}}`**
   （通用兜底错误），而**真实存在的接口**（如 `/api/user/profile_and_features`）
   返回 `{"status":200,...}` 正常数据。→ 后端**没有**签到类路由。
4. **尊主本人确认**：可灵「就是登录就有，没有按钮」。

综上：可灵 = 登录即发放型，只能靠「用已登录的浏览器打开一次」来满足触发条件。

诚实交代
--------
**我无法确认无头浏览器访问是否真能触发发放**（那需要尊主账号实测，我这边没有登录态）。
可灵属快手体系，风控较严，「登录」有可能被判定为需要真实交互。
所以本模块：
- 如实把结果标为 `verified: False`；
- 请尊主头几天到「我的 → 灵感值」核对一次；
- 若确认不到账，告诉我，我改方案（或如实说这条路走不通，别浪费时间）。

额度机制（据公开资料 + 代码证据交叉）
------------------------------------
| 项目 | 数值 | 性质 |
|---|---|---|
| 每日灵感值 | **66** | 每日登录自动发放，**当日清零不累计** |
| 每月固定额度 | 166 | 每月 1 日 00:00 自动刷新（代码见 `monthly_free_credits`）|
连续签到奖励（3/7/15 天额外 50/100/200）在**部分来源**提到，但那些来源本身
自相矛盾且出现过错域名（`keling.ai`），**可信度低**，故本模块不据此实现。

实现方式：独立浏览器配置目录（不影响日常浏览器），
首次用 `--login` 登录一次，之后每天无头访问。

用法
----
    python kling.py --login      # 首次：打开浏览器登录可灵（只需一次）
    python kling.py --inspect    # 检查浏览器与登录态目录
    python kling.py --visible    # 带界面运行一次（排查问题时用）
    python kling.py              # 默认：无头访问，触发每日灵感值发放
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import browser_visit as bv  # noqa: E402

# 注意：kling.kuaishou.com 会 302 跳到 klingai.com/app/，
# 可灵创作端实际入口是 klingai.com/app/
SITE = "https://klingai.com/app/"
PROFILE = bv.profile_dir("kling")
DAILY_CREDIT = 66

# 登录态真校验用：可灵是快手体系，登录后的标志 Cookie
HOST = "klingai.com"
LOGIN_KEYS = ("kuaishou.com_ph", "kwscode", "kuaishou.server.web_st",
              "userId", "kuaishou.server.web_ph", "ks_login")


def run(dry_run: bool = False, headless: bool = True,
        wait_seconds: int = 45) -> dict:
    out = {"platform": "可灵 AI", "daily_credit": DAILY_CREDIT}

    logged, why = bv.login_status(PROFILE, HOST, LOGIN_KEYS)
    out["login"] = why
    if not logged:
        return {**out, "result": "ERROR",
                "detail": (f"可灵登录态不可用：{why}\n"
                           f"请执行：python kling.py --login 打开浏览器登录一次"
                           f"（用手机号登录即可）")}

    if dry_run:
        return {**out, "result": "DRY_RUN",
                "detail": f"演练：登录态就绪（{why}），将无头访问 {SITE} 触发每日灵感值发放"}

    info = bv.visit(PROFILE, SITE, wait_seconds=wait_seconds, headless=headless)
    return {
        **out,
        "result": "DONE",
        "mode": info["mode"],
        "waited": info["waited"],
        "profile": info["profile"],
        "detail": (f"已访问 {SITE} 触发每日登录灵感值（{DAILY_CREDIT} 点）。"
                   "可灵无签到接口，灵感值由「登录」触发、服务端按天发放，"
                   "当日有效不累计。请到「我的 → 灵感值」核对一次。"),
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
        return bv.login(PROFILE, SITE, "可灵 AI")

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
