#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""「启动即发放」型平台的启动痕迹判定 —— 供看板与签到入口共用。

适用平台
--------
WorkBuddy 国际版、千问办公：**没有领取接口**（因此也没有官方的
「今日是否已签」接口），发放由「客户端启动 / 登录」这个动作触发。

判定依据
--------
本地痕迹文件的 **mtime 落在今天**（取候选文件中最大者）。

为什么可信：客户端启动 / 运行时会持续写这些文件（凭证、Preferences 等），
而**客户端关闭后 mtime 原样保留**。实测 2026-09-28：千问客户端 21:10 启动过、
22:23 查进程时已关闭，但 `auth-v2.dat` 的 mtime 仍停在 21:10 —— 判定成立。

⚠️ 本模块**只读 mtime，不读文件内容**，不碰任何凭据。

口径（2026-09-28 尊主定）
------------------------
今天启动过 → 视为「已签到」；今天没启动 → 「不可知」。
这是**推断**（state_source="infer"，看板标「推断」），不是接口实测到账。
"""
from __future__ import annotations

import datetime
import os


def launched_today(paths) -> tuple[bool, str | None]:
    """今天是否启动过客户端（按候选痕迹文件的最大 mtime 判定）。

    :param paths: 候选痕迹文件路径，任一命中即算
    :return: (今天是否启动过, 命中的证据文件名)
    """
    today = datetime.date.today().isoformat()
    best_m = -1.0
    best: str | None = None
    for p in paths:
        try:
            m = os.path.getmtime(p)
        except OSError:
            continue
        if m > best_m:
            best_m, best = m, p
    if best is None:
        return False, None
    return (datetime.date.fromtimestamp(best_m).isoformat() == today,
            os.path.basename(best))
