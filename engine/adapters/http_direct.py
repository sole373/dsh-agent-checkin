#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""直连请求器 —— 统一绕过系统/环境代理

为什么需要它
------------
本项目的适配器全部**直连各平台官方域名**（国内 + 境外均可直连）。
但运行环境里可能存在 `http_proxy` / `https_proxy` 环境变量
（例如 IDE/客户端为会话注入的代理，本机实测为 `127.0.0.1:6713`），
`urllib` 默认会**读取并走这些代理**，导致：

    urllib.error.URLError: <urlopen error Tunnel connection failed: 502 Bad Gateway>

实测（2026-09-27）：`workbuddy.ai` 经该代理必 502，去掉环境变量后直连 200。
国内平台当时看起来正常，只是因为代理恰好能转发，属于**侥幸**而非设计。

因此本项目**所有出网请求一律绕过代理**：
    - `direct_opener()` 返回一个不带任何 ProxyHandler 的 opener
    - `urlopen(req, timeout=...)` 是它的薄封装，接口与原 `urllib.request.urlopen` 一致

这样无论调用方（终端 / 计划任务 / 看板服务）的环境里有没有代理变量，
行为都一致且可控。

用法
----
    from http_direct import urlopen            # 替换 urllib.request.urlopen
    with urlopen(req, timeout=30) as resp:
        ...

    from http_direct import direct_opener      # 需要 opener 时
    with direct_opener().open(req, timeout=30) as resp:
        ...

注意：本模块**只影响适配器的对外请求**。若某个平台确实需要走代理才能访问，
应通过环境变量显式声明，而不是依赖进程环境的偶然状态。
"""

from __future__ import annotations

import urllib.request

__all__ = ["direct_opener", "urlopen"]

# 空 ProxyHandler 覆盖掉环境里的 http_proxy / https_proxy / all_proxy
_NO_PROXY = urllib.request.ProxyHandler({})

_OPENER = urllib.request.build_opener(_NO_PROXY)


def direct_opener() -> urllib.request.OpenerDirector:
    """返回一个**不读环境代理**的 opener（模块级单例，可安全复用）。"""
    return _OPENER


def urlopen(url, data=None, timeout=None, **kwargs):
    """`urllib.request.urlopen` 的直连版本（绕过代理），签名保持兼容。

    仅支持协议/Request 两种入参，不接管 cafile 等冷门参数 ——
    若调用方需要，请直接用 `direct_opener().open(...)`。
    """
    if isinstance(url, urllib.request.Request):
        req = url
    else:
        req = urllib.request.Request(url, data=data)
    return _OPENER.open(req, timeout=timeout)
