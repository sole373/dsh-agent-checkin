#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Cookie 校验与解析公用模块

为什么需要它
------------
真实踩过的坑：命令行里写了 `--set-cookie "<xxx 全量 Cookie>"`，
用户直接**把尖括号占位符当参数粘了进去**，而早期的 `save_cookie` 逻辑是
「没有 `=` 就当成裸 sessionid 包一层」，于是把占位符文本原样存成了"凭证"，
`--inspect` 还显示「已配置：是」——**静默接受了垃圾输入，这是最危险的一类 bug**。

本模块提供统一的校验：把占位符、空值、格式错误都挡在写入之前，
并给出人话提示。
"""

from __future__ import annotations

import re

# 占位符特征：出现任一项就判定为用户误粘了模板文本
_PLACEHOLDER_HINTS = (
    "<", ">", "全量", "你的", "在此", "粘贴", "此处", "填这里",
    "cookie>", "xxx", "xxx>", "示例",
)

# 合法的 cookie 名：字母数字下划线连字符点
_KEY_RE = re.compile(r"^[A-Za-z0-9_.\-]+$")
# 裸令牌（如只有 sessionid 值）允许的字符集
_TOKEN_RE = re.compile(r"^[A-Za-z0-9._~+\-/=%]+$")


def is_placeholder(value: str) -> bool:
    """判断是否像占位符/模板文本。"""
    if not value:
        return True
    low = value.lower()
    return any(h in value or h in low for h in _PLACEHOLDER_HINTS)


def parse_cookie(value: str) -> dict:
    """`k=v; k2=v2` → dict（保留原始大小写）。"""
    out = {}
    for part in value.split(";"):
        if "=" in part:
            k, v = part.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def cookie_names(value: str) -> list[str]:
    return sorted(parse_cookie(value))


def normalize(value: str, *, platform: str,
              allow_bare_token: bool = False,
              bare_key: str = "sessionid",
              min_token_len: int = 16) -> str:
    """校验并规范化 Cookie 串。不合法则抛 ValueError（消息可直接给用户看）。

    参数
    ----
    allow_bare_token : 是否允许「只给一个令牌值」的便捷写法（如即梦只给 sessionid）。
    bare_key         : 便捷写法时补的键名。
    min_token_len    : 裸令牌的最小长度（真令牌不会太短）。
    """
    raw = (value or "").strip()

    if not raw:
        raise ValueError(f"参数为空。请粘贴 {platform} 的完整 Cookie 字符串。")

    if is_placeholder(raw):
        raise ValueError(
            f"检测到**占位符文本**，不是真实 Cookie：\n"
            f"    {raw[:60]}{'…' if len(raw) > 60 else ''}\n"
            f"  请把尖括号里的说明文字替换成你从浏览器里复制出来的**真实 Cookie 值**，\n"
            f"  例如：--set-cookie \"sessionid=abc123...; otherKey=xyz...\""
        )

    first = raw.split(";")[0]

    # 情形一：形如 k=v 的标准 Cookie 串
    if "=" in first:
        pairs = parse_cookie(raw)
        if not pairs:
            raise ValueError("Cookie 解析后为空，请检查格式是否为 `k=v; k2=v2`。")
        bad = [k for k in pairs if not _KEY_RE.match(k)]
        if bad:
            raise ValueError(
                f"Cookie 名不合法：{bad[:3]}。应为 `k=v; k2=v2` 形式，"
                f"键名只含字母数字与 _ . -")
        if not all(str(v).strip() for v in pairs.values()):
            raise ValueError("存在空的 Cookie 值，请确认复制完整。")
        return raw

    # 情形二：只给了一个裸令牌值
    if allow_bare_token:
        if len(raw) < min_token_len or not _TOKEN_RE.match(raw):
            raise ValueError(
                f"这看起来不是一个有效的令牌（长度 {len(raw)}，"
                f"期望 ≥{min_token_len} 且仅含 URL 安全字符）。\n"
                f"  请确认复制完整，或直接粘贴整串 Cookie（形如 `k=v; k2=v2`）。")
        return f"{bare_key}={raw}"

    raise ValueError(
        f"格式不对：未找到 `=`。\n"
        f"  应形如：--set-cookie \"key1=value1; key2=value2\"\n"
        f"  当前收到：{raw[:60]}{'…' if len(raw) > 60 else ''}")


def usability(value: str) -> tuple[bool, str]:
    """判断已存盘的凭证是否可用（供 --inspect 使用）。返回 (可用, 原因)。"""
    raw = (value or "").strip()
    if not raw:
        return False, "文件为空"
    if is_placeholder(raw):
        return False, "内容是占位符文本，不是真实 Cookie（需重新执行 --set-cookie）"
    if "=" not in raw:
        return False, "格式不对（未找到 `=`）"
    return True, "格式正常"
