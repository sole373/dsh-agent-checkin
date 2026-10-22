#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
凭证文件路径解析 —— **单一事实来源**。

为什么需要这个模块
------------------
本插件的「凭证在哪」曾经有两套口径，且互不知情：

  · Python 侧（``engine/adapters/lingxi.py``、``engine/bridge.py``）
    只认「包内 engine/xxx_cookie.txt」——即 ``__file__`` 的上一级。
  · JS 侧（``lib/connect/lingxi/credentials.js``）
    早就知道包内凭证文件**会被重装抹掉**（``package.json`` 的 ``files``
    白名单里有 ``!engine/*_cookie.txt``），于是把主位置挪到了
    ``<dshHome>/dsh-agent-checkin/engine/``。

两套口径的后果（2026-10-21 实测）：

  · 灵犀**模型接入**正常（JS 侧读到了 dshHome 的 Cookie，接口调用成功）；
  · 灵犀**签到**永远失败（Python 侧去包内找，那儿是空的），
    面板还把凭证状态显示成「尚未录入凭证」——**误导用户去重新采集**。

这不是「Cookie 失效」，是**路径分歧**。修它的正确姿势是让两侧用同一份规则，
而不是各修各的、指望下次别再漂。

与 JS 侧保持一致
----------------
候选顺序（高 → 低），与 ``lib/connect/lingxi/credentials.js`` 的
``lingxiCookieFileCandidates()`` 逐条对应：

  ① 显式传入的路径（测试 / 特殊部署）
  ② 环境变量 ``LINGXI_COOKIE_FILE`` / ``JIMENG_COOKIE_FILE``
     （注意：JS 侧只认 LINGXI_COOKIE_FILE；这里两个平台各给一个，
       命名对称，便于人配置）
  ③ ``<dshHome>/dsh-agent-checkin/engine/<name>``  ← **主位置**（用户可写、重装不丢）
  ④ ``<包内>/engine/<name>``                      ← 老行为兼容（自建检出 / 旧安装）

dshHome 的解析口径同样与 ``lib/index.js#joinHome()`` 对齐：
``DSH_HOME`` 环境变量 → ``%USERPROFILE%/.dsh``（POSIX 为 ``$HOME/.dsh``）。

⚠️ 为什么要「读写分开」：
  · **读**（load）：按上面的候选顺序，**首个存在且非空的**文件获胜。
  · **写**（save）：一律写到**主位置**（③）。
    理由：包内目录可能只读，且每次重装即失效——写在那里等于写进一次性沙。
    写主位置后，重装插件不会丢凭证（这正是当初 JS 侧改主位置的原因）。

同一份规则同时服务于「读」「写」「检查状态」三件事，
杜绝「改了读取路径、忘了改写入路径」这类半边修复。
"""

from __future__ import annotations

import os
import sys

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------

#: 插件状态目录名（在 dshHome 下）。
STATE_DIR_NAME = "dsh-agent-checkin"

#: 凭证文件默认名（相对 engine/ 目录）。
DEFAULT_NAMES = {
    "lingxi": "lx_cookie.txt",
    "jimeng": "jimeng_cookie.txt",
}

#: 各平台的环境变量名（指向**文件路径**）。
ENV_FILE_VARS = {
    "lingxi": "LINGXI_COOKIE_FILE",
    "jimeng": "JIMENG_COOKIE_FILE",
}


# ---------------------------------------------------------------------------
# 基础路径
# ---------------------------------------------------------------------------
def dsh_home() -> str:
    """宿主的 dshHome 根目录。

    解析顺序与 ``lib/index.js#joinHome()`` 一致：
    ``DSH_HOME`` → ``%USERPROFILE%/.dsh``（POSIX 用 ``$HOME``）。

    刻意**不读**宿主注入的 ``homePaths`` 服务——Python 是独立子进程，
    拿不到宿主上下文，只能靠环境变量与约定。
    """
    env = os.environ.get("DSH_HOME", "").strip()
    if env:
        return os.path.abspath(env)
    home = os.environ.get("USERPROFILE") or os.environ.get("HOME") or ""
    if not home:
        # 极端兜底：连 HOME 都没有时，用当前工作目录的上级凑一个。
        home = os.getcwd()
    return os.path.join(os.path.abspath(home), ".dsh")


def engine_dir() -> str:
    """本模块所属的 ``engine/`` 目录（包内自带的那份）。"""
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def state_engine_dir() -> str:
    """用户可写、重装不丢的 ``engine/`` 目录：``<dshHome>/dsh-agent-checkin/engine``。"""
    return os.path.join(dsh_home(), STATE_DIR_NAME, "engine")


def default_name(platform: str) -> str:
    """该平台凭证文件的默认名。"""
    key = (platform or "").strip().lower()
    return DEFAULT_NAMES.get(key, f"{key}_cookie.txt")


# ---------------------------------------------------------------------------
# 候选路径
# ---------------------------------------------------------------------------
def candidates(platform: str, explicit: str | None = None) -> list[str]:
    """按优先级返回该平台凭证文件的候选路径（已去重、已绝对化）。

    顺序见模块顶部说明；**第一个存在的文件就是权威来源**。
    """
    key = (platform or "").strip().lower()
    name = default_name(key)
    out: list[str] = []

    def add(path: str | None) -> None:
        if not path:
            return
        resolved = os.path.abspath(path)
        if resolved not in out:
            out.append(resolved)

    # ① 显式传入
    add(explicit)
    # ② 环境变量（文件路径）
    env_var = ENV_FILE_VARS.get(key)
    if env_var:
        add(os.environ.get(env_var, "").strip() or None)
    # ③ 主位置：用户可写、重装不丢
    add(os.path.join(state_engine_dir(), name))
    # ④ 老行为兼容：包内 engine/
    add(os.path.join(engine_dir(), name))

    return out


def read_existing(platform: str, explicit: str | None = None) -> tuple[str | None, str]:
    """找出第一个存在且非空的凭证文件。

    返回 ``(路径, 内容)``；都没命中时返回 ``(None, "")``。
    """
    for path in candidates(platform, explicit):
        try:
            if not os.path.isfile(path):
                continue
            with open(path, encoding="utf-8") as fh:
                content = fh.read().strip()
        except OSError:
            # 读不了就试下一个候选（权限问题、文件被占用等）。
            continue
        if content:
            return path, content
    return None, ""


def write_target(platform: str, explicit: str | None = None) -> str:
    """写入凭证时的目标路径。

    规则：**一律写主位置**（``<dshHome>/dsh-agent-checkin/engine/``），
    除非调用方显式指定了路径。

    为什么��写包内：
      · 包内目录可能只读（市场装出来的插件通常如此）；
      · 包内凭证文件**每次重装即被整目录替换**，写在那里等于白写；
      · ``package.json`` 的 ``files`` 白名单**刻意排除**了 ``*_cookie.txt``——
        凭证不进发布包是安全设计，不是 bug。
    """
    if explicit:
        return os.path.abspath(explicit)
    key = (platform or "").strip().lower()
    return os.path.join(state_engine_dir(), default_name(key))


def ensure_parent(path: str) -> None:
    """确保父目录存在（不存在就建）。"""
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)


def describe(platform: str, explicit: str | None = None) -> dict:
    """给面板用的凭证位置描述（**不含任何凭证值**）。"""
    key = (platform or "").strip().lower()
    cands = candidates(key, explicit)
    found, content = read_existing(key, explicit)
    return {
        "platform": key,
        "candidates": cands,
        "found_path": found,
        "present": bool(found),
        "length": len(content),
        "write_target": write_target(key, explicit),
    }


# ---------------------------------------------------------------------------
# 浏览器配置目录（kling / jimeng 登录态的存放处）
# ---------------------------------------------------------------------------
#
# 与 Cookie 文件是**同一个道理**：包内的 `engine/.*_profile` 被 package.json 的
# `files` 白名单（`!engine/**/.*_profile`）排除，每次重装插件都会被抹掉。
# 而浏览器配置目录里存着用户的**登录态**——抹掉就等于逼用户重新登录一次。
#
# 规则与 Cookie 一致：
#   · 读：主位置（dshHome）优先，包内作为老位置兼容
#   · 写：一律用主位置
# ---------------------------------------------------------------------------
def profile_dir(name: str) -> str:
    """某个平台的浏览器配置目录。

    - 主位置（存在则用）：``<dshHome>/dsh-agent-checkin/engine/.{name}_profile``
    - 否则退回包内：``<包内>/engine/.{name}_profile``
      （老安装/自建检出时，登录态已经在那里了，别让用户重新登录）

    ⚠️ 无论返回哪个，**创建**都走主位置——见 `ensure_profile_dir`。
    """
    primary = os.path.join(state_engine_dir(), f".{name}_profile")
    legacy = os.path.join(engine_dir(), f".{name}_profile")
    if os.path.isdir(primary):
        return primary
    if os.path.isdir(legacy):
        return legacy
    # 都没有 → 返回主位置（后续创建会落在这里）。
    return primary


def ensure_profile_dir(name: str) -> str:
    """返回并确保存在该平台的浏览器配置目录（一律建在主位置）。"""
    path = os.path.join(state_engine_dir(), f".{name}_profile")
    os.makedirs(path, exist_ok=True)
    return path


if __name__ == "__main__":
    # 自检入口：python cred_paths.py [平台]
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    target = sys.argv[1] if len(sys.argv) > 1 else "lingxi"
    info = describe(target)
    print(f"平台：{info['platform']}")
    print(f"dshHome：{dsh_home()}")
    print("候选路径（按优先级）：")
    for path in info["candidates"]:
        mark = "✔ 命中" if path == info["found_path"] else ("· 存在但为空"
                                                            if os.path.isfile(path) else "· 不存在")
        print(f"   [{mark}] {path}")
    print(f"写入目标：{info['write_target']}")
    print(f"是否已有凭证：{'是' if info['present'] else '否'}"
          + (f"（长度 {info['length']}）" if info["present"] else ""))
