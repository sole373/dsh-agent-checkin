#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""签到引擎的 JSON 桥接层 —— 供 DSH 插件调用。

为什么需要这一层：项目根目录的 ``checkin.py`` 是**给人看**的入口，它打印人类可读
的汇总表并把结构化结果追加到 ``checkin.log``，但**不向 stdout 输出 JSON**。
插件要的是稳定契约，所以这里直接复用同一批适配器，把结果序列化成一份
自描述的 JSON 文档，并额外附上「数据来源」与「是否为真实领取」两个诚实性字段。

契约（插件依赖它，改动需同步 dsh-agent-checkin/lib/engine.js）::

    {
      "ok": true,
      "generated_at": "2026-10-17T10:43:42+08:00",
      "dry_run": false,
      "elapsed_seconds": 2.7,
      "source": "live",            # live = 真的调了平台接口；dry_run = 未领取
      "results": [
        {
          "platform": "trae",      # 稳定 id，与 --only 的取值一致
          "name": "TRAE Work",     # 适配器自报的中文展示名（原样透传）
          "claiming": true,        # 是否存在真实领取动作
          "unit": "积分",
          "result": "ALREADY",     # OK|ALREADY|DONE|DRY_RUN|READONLY|INACTIVE|
                                   # AUTH_REJECTED|FORBIDDEN|NETWORK|ERROR|EXCEPTION
          "detail": "今日已签到",
          "balance": 1500.0,       # 实时余额；没有接口时为 null
          "balance_note": "余额口径说明",
          ...                      # 其余平台特有字段原样保留
        }, ...
      ]
    }

失败时 ``ok=false`` 且带 ``error``，退出码非 0。

用法::

    python bridge.py                 # 真实签到
    python bridge.py --dry-run       # 只查状态，不领取
    python bridge.py --only trae,lingxi
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
# 命令行方式运行时 sys.path 只有 engine/，把 adapters/ 也加进来，
# 这样可以直接用它们的占位符校验，而不必复制一份规则。
sys.path.insert(0, os.path.join(HERE, "adapters"))
try:
    from cookie_util import is_placeholder as _is_placeholder  # noqa: E402
except ImportError:  # 极端情况下（adapters 被替换）退回只看空值
    def _is_placeholder(value: str) -> bool:  # type: ignore[misc]
        return not value or not value.strip()
try:
    # 凭证路径的**唯一事实来源**（与 JS 侧 lib/connect/lingxi/credentials.js 同规则）。
    # 详见 adapters/cred_paths.py 顶部说明：包内凭证文件会随重装被抹掉，
    # 权威位置是 <dshHome>/dsh-agent-checkin/engine/。
    import cred_paths  # noqa: E402
except ImportError:  # adapters 被替换时的兜底
    cred_paths = None  # type: ignore[assignment]
# 适配器目录由调用方通过 --home 传入（插件配置里可改），默认与 bridge.py 同级。
DEFAULT_HOME = HERE

# 平台 id → (模块名, 中文展示名, 余额单位, 是否有真实领取动作)。
#
# 「claiming」是这套系统最关键的诚实性字段：没有领取动作的平台（例如打开即
# 发放、或需要真实浏览器才能完成的）其成功结果**不能**计入「签到正常」。
PLATFORM_SPECS: dict[str, tuple[str, str, str, bool]] = {
    "workbuddy": ("workbuddy", "WorkBuddy（国内版）", "积分", True),
    "workbuddy_intl": ("workbuddy_intl", "WorkBuddy（国际版）", "credits", True),
    "trae": ("trae", "TRAE Work", "积分", True),
    "lingxi": ("lingxi", "WPS 灵犀", "积分", True),
    "jimeng": ("jimeng", "即梦 AI", "灵感值", False),
    "kling": ("kling", "可灵 AI", "灵感值", False),
}

# 已是成功集合的结果码；DRY_RUN / READONLY / INACTIVE 属中性，单独统计。
SUCCESS_CODES = frozenset({"OK", "ALREADY", "DONE"})

# 各平台「可用余额」的等价字段名，按优先级排列。
#
# 为什么需要这张表：适配器各自从不同的接口取数，可用余额的字段名五花八门
# （TRAE 是 total_credits，WorkBuddy 国内版是签到接口顺带返回的 total_credits）。
# 而插件侧只看 ``balance`` 一个字段——若这里不归一，看板会把「读到了但字段没对上」
# 显示成「本次未取到余额」，等于把真实数据报成缺失，违反诚实性纪律。
#
# 只放**确实等价于可用余额**的字段，宁可留 None 也不能拿错字段凑数：
#   - trae 的 total_credits 是**剩余**额度（limit - used），不是总额；
#     credits_limit 才是总额，绝不能拿来当余额。
#   - workbuddy 的余额来自签到接口的 total_credits；billing 的
#     get-user-resource-summary 那条路在 run() 里没被调用（parse_balance 存在
#     但未接入），所以不列 billing 的字段。
BALANCE_FALLBACK_FIELDS: dict[str, tuple[str, ...]] = {
    "trae": ("total_credits",),      # 剩余额度
    "workbuddy": ("total_credits",),  # 签到接口顺带返回
}


def emit(payload: dict) -> None:
    """把结果写到 stdout。前面绝不能混入别的打印，否则 JSON 解析会失败。"""
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def fail(message: str, code: int = 1) -> int:
    emit({"ok": False, "error": message})
    return code


def _is_number(value) -> bool:
    """bool 是 int 的子类，必须显式排除，否则 True 会被当成余额 1。"""
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def normalize_result(key: str, row, spec: tuple[str, str, str, bool]) -> dict:
    """把某个适配器的原始返回收敛成统一契约行。

    适配器历史上把中文展示名塞进 ``platform`` 字段，前端按名字反查 id 需要模糊
    匹配，容易错配。这里改成**双字段**：``platform`` 只放稳定 id，适配器自报的
    名字搬到 ``name``，两者都能如实呈现。
    """
    _, display_name, unit, claiming = spec
    if not isinstance(row, dict):
        return {
            "platform": key,
            "name": display_name,
            "claiming": claiming,
            "unit": unit,
            "result": "ERROR",
            "detail": f"适配器返回了 {type(row).__name__}，应为 dict",
            "balance": None,
        }

    out = dict(row)
    # 适配器自报的展示名（可能是中文），保留到 name 字段。
    reported = out.get("platform")
    out["platform"] = key
    out["name"] = display_name if not isinstance(reported, str) or not reported.strip() else reported
    out["claiming"] = claiming
    out.setdefault("unit", unit)

    result = out.get("result")
    if not isinstance(result, str) or not result.strip():
        out["result"] = "ERROR"
        out.setdefault("detail", "适配器未返回结果码")
    else:
        out["result"] = result.strip().upper()

    # 余额统一成 number|null，避免插件侧再做一次类型兼容。
    #
    # 适配器没直接给 balance 时，按 BALANCE_FALLBACK_FIELDS 从等价字段取一次。
    # 这条兜底只补「字段名对不上」，不改变任何适配器自己给出的判断：适配器明确
    # 报 balance=None 且没有等价字段的（如 kling、jimeng），这里仍然是 None。
    balance = out.get("balance")
    source_field = "balance" if _is_number(balance) else ""
    if not source_field:
        for field in BALANCE_FALLBACK_FIELDS.get(key, ()):
            candidate = out.get(field)
            if _is_number(candidate):
                balance = candidate
                source_field = field
                break

    if _is_number(balance):
        out["balance"] = float(balance)
        # 如实标注这个数字是从哪个字段来的，便于核对口径。
        if source_field != "balance":
            out["balance_source_field"] = source_field
    else:
        out["balance"] = None

    return out


# ---------------------------------------------------------------------------
# 凭证面：哪些平台支持在设置面板里录入凭证，以及怎么「只验证不领取」
# ---------------------------------------------------------------------------
#
# 关键事实：六个平台里**只有灵犀和即梦**的凭证是用户可录入的 Cookie。其余四个
# 的凭证来自各自桌面客户端本地存储（Electron at-rest / AES-CBC），
# 只能由客户端自己登录后写出，插件无法代填——这里如实标成 unsupported，
# 而不是给一个假输入框让人填了不生效。
CREDENTIAL_KINDS: dict[str, str] = {
    "lingxi": "cookie",   # 多字段 Cookie 串，落在 <dshHome>/dsh-agent-checkin/engine/lx_cookie.txt
    "jimeng": "cookie",   # Cookie 串或裸 sessionid，落在 <dshHome>/dsh-agent-checkin/engine/jimeng_cookie.txt
}

UNSUPPORTED_CREDENTIAL_REASON = {
    "workbuddy": "凭证是客户端本地存储的 Electron at-rest 密文，必须由 WorkBuddy 客户端登录后写出",
    "workbuddy_intl": "凭证由 WorkBuddy 国际版客户端写出，插件不代填",
    "trae": "凭证由 TRAE 客户端登录后写入 globalStorage，插件不代填",
    "kling": "本插件没有可调用的领取接口，录凭证也没有用",
}

# --check 的判据：这些结果码说明「凭证本身是通的」，只是今天没有需要做的事。
# 其余结果码（AUTH_REJECTED / ERROR / EXCEPTION / NETWORK / FORBIDDEN）都算不通，
# 但**必须原码原样回传**——把登录态失效说成环境问题、或者反过来，都是在骗人。
CHECK_HEALTHY_CODES = frozenset({"DRY_RUN", "ALREADY", "OK", "INACTIVE", "READONLY", "DONE", "IDLE"})
CHECK_UNHEALTHY_CODES = frozenset({"AUTH_REJECTED", "FORBIDDEN", "ERROR", "EXCEPTION", "NETWORK"})


def cookie_file_for(key: str) -> str | None:
    """该平台若支持手工录入凭证，返回**写入目标**路径；否则 None。

    写入目标一律是主位置（`<dshHome>/dsh-agent-checkin/engine/`）——
    包内目录可能只读，且每次重装即失效。
    """
    if key not in CREDENTIAL_KINDS:
        return None
    if cred_paths is not None:
        return cred_paths.write_target(key)
    # 兜底（adapters 被替换）：退回包内路径。
    name = {"lingxi": "lx_cookie.txt", "jimeng": "jimeng_cookie.txt"}[key]
    return os.path.join(HERE, name)


def inspect_credential_file(key: str) -> dict:
    """只看文件，不联网：空 / 占位符 / 格式不对 / 已保存。

    「文件存在」绝对不等于「已登录」——早期版本就把粘错的占位符原样存进去，
    检查面板还显示「已配置：是」，这是最危险的一类假报。这里一并挡住。

    ⚠️ 读取要按**候选顺序**找（与适配器、JS 侧同一份规则），
    否则会出现「引擎读得到、面板说没录」的分裂现象。
    """
    if key not in CREDENTIAL_KINDS:
        return {"status": "unsupported", "detail": UNSUPPORTED_CREDENTIAL_REASON.get(key, ""), "path": None}

    # 按候选顺序找第一个存在且非空的凭证文件。
    if cred_paths is not None:
        found, raw = cred_paths.read_existing(key)
    else:
        path = cookie_file_for(key)
        found, raw = None, ""
        if path and os.path.isfile(path):
            try:
                raw = open(path, encoding="utf-8").read().strip()
                found = path
            except OSError:
                found = None

    write_path = cookie_file_for(key)

    if found is None:
        return {"status": "absent", "detail": "尚未录入凭证", "path": write_path}
    if not raw:
        return {"status": "invalid", "detail": "凭证文件是空的", "path": found}
    if _is_placeholder(raw):
        return {"status": "invalid", "detail": "文件内容是占位符文本，不是真实 Cookie", "path": found}
    if key == "lingxi" and "=" not in raw:
        return {"status": "invalid", "detail": "格式不对：没有 `=`，灵犀需要完整的 `k=v; k2=v2` Cookie 串", "path": found}
    return {"status": "present", "detail": "已录入凭证（是否仍然有效见下面的实测结果）", "path": found}


def save_credential(key: str, value: str) -> dict:
    """校验并写入凭证文件。校验不过一律不落盘。"""
    path = cookie_file_for(key)
    if path is None:
        return {"ok": False, "status": "unsupported",
                "detail": UNSUPPORTED_CREDENTIAL_REASON.get(key, "该平台不支持手工录入凭证")}

    raw = (value or "").strip()
    if not raw:
        return {"ok": False, "status": "invalid", "detail": "内容为空"}
    if _is_placeholder(raw):
        return {"ok": False, "status": "invalid",
                "detail": "检测到占位符文本（尖括号里的说明文字），这不是真实 Cookie"}
    if "=" not in raw:
        if key == "jimeng" and len(raw) >= 16:
            # 即梦允许只给 sessionid 的便捷写法
            raw = f"sessionid={raw}"
        else:
            return {"ok": False, "status": "invalid",
                    "detail": "格式不对：应为 `k=v; k2=v2` 形式的完整 Cookie 串"}

    try:
        if cred_paths is not None:
            cred_paths.ensure_parent(path)
        else:
            os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(raw)
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
    except OSError as exc:
        return {"ok": False, "status": "error", "detail": f"写入失败：{exc}"}

    names = sorted({seg.split("=", 1)[0].strip() for seg in raw.split(";") if "=" in seg})
    # 只回字段名，绝不回字段值。
    return {"ok": True, "status": "present", "path": path,
            "fields": names[:12], "field_count": len(names)}


def clear_credential(key: str) -> dict:
    """删除该平台已录入的凭证。

    要删的是**所有候选位置**——只删写入目标的话，包内那份旧副本还在，
    下次读取会命中它，「已删除」就成了假报。
    """
    if key not in CREDENTIAL_KINDS:
        return {"ok": False, "status": "unsupported",
                "detail": UNSUPPORTED_CREDENTIAL_REASON.get(key, "该平台不支持手工录入凭证")}

    if cred_paths is not None:
        targets = list(cred_paths.candidates(key))
    else:
        targets = [cookie_file_for(key)]
    write_path = cookie_file_for(key)

    removed = False
    for candidate in targets:
        for path in (candidate, f"{candidate}.bak"):
            if not os.path.isfile(path):
                continue
            try:
                os.remove(path)
                removed = removed or path == write_path
            except OSError as exc:
                return {"ok": False, "status": "error", "detail": f"删除失败：{exc}"}
    return {"ok": True, "status": "absent", "removed": removed, "path": write_path}


def check_platform(modules: dict, key: str) -> dict:
    """对单个平台做一次「只读、不领取」的连通性与登录态检查。

    为什么用 ``run(dry_run=True)`` 而不是碰适配器的私有函数：各适配器在 dry_run
    分支里本来就不发领取请求，且会**真的**去打一次状态接口——这正是「登录态是否
    有效」的唯一可信判据。代价是会读一次余额，没有副作用。
    """
    try:
        row = modules[key].run(dry_run=True)
    except FileNotFoundError as exc:
        return {"id": key, "name": PLATFORM_SPECS[key][1], "ok": False, "status": "missing",
                "code": "ERROR", "detail": f"缺少前置条件：{exc}"}
    except Exception as exc:  # noqa: BLE001
        return {"id": key, "name": PLATFORM_SPECS[key][1], "ok": False, "status": "failed",
                "code": "EXCEPTION", "detail": f"{type(exc).__name__}: {exc}"}

    normalized = normalize_result(key, row, PLATFORM_SPECS[key])
    code = str(normalized.get("result") or "ERROR")
    detail = str(normalized.get("detail") or "")
    if code in CHECK_HEALTHY_CODES:
        status = "ok"
    elif code in CHECK_UNHEALTHY_CODES:
        # 缺前置条件（没装客户端 / 没录入凭证）和登录被拒要分开，否则用户会去
        # 重新登录一个根本没装的东西。
        status = "missing" if ("缺少前置条件" in detail or "未配置" in detail
                               or "未找到" in detail or "请先" in detail) else "failed"
    else:
        status = "unknown"
    return {
        "id": key,
        "name": PLATFORM_SPECS[key][1],
        "ok": status == "ok",
        "status": status,
        "code": code,
        "detail": detail,
        # 只读探测拿到的余额，属于真实读数；取不到就是 None，不编 0。
        "balance": normalized.get("balance"),
        "unit": normalized.get("unit"),
    }


def main() -> int:
    # 适配器和看板里有大量中文 print；不显式指定编码时 Windows 默认 GBK，
    # 管道里就会变成乱码。必须在任何输出之前改。
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass
    ap = argparse.ArgumentParser(description="签到引擎 JSON 桥接层")
    ap.add_argument("--home", default=DEFAULT_HOME,
                    help="AICheckin 项目根目录（含 adapters/）")
    ap.add_argument("--only", default="", help="只跑指定平台，逗号分隔")
    ap.add_argument("--dry-run", action="store_true", help="只查状态，不实际领取")
    ap.add_argument("--list", action="store_true", help="只列出可用平台，不执行签到")
    ap.add_argument("--check", action="store_true",
                    help="逐平台做一次只读登录态检查（不发领取请求）")
    ap.add_argument("--save-cookie", nargs=2, metavar=("平台", "文件"),
                    help="从文件读取凭证内容并落盘（内容不进命令行参数）")
    ap.add_argument("--clear-cookie", metavar="平台", help="删除该平台已录入的凭证")
    ap.add_argument("--credential", metavar="平台", help="只查看该平台的凭证状态，不联网")
    args = ap.parse_args()

    # 凭证面没有副作用地最先处理：即使引擎根目录坏了，也应该让用户能清掉凭证。
    if args.credential:
        key = args.credential.strip()
        if key not in PLATFORM_SPECS:
            return fail(f"未知平台：{key}", 2)
        creds = {k: inspect_credential_file(k) for k in PLATFORM_SPECS}
        emit({"ok": True, "platform": key, "credential": creds[key],
              "credential_kinds": CREDENTIAL_KINDS,
              "supported": sorted(CREDENTIAL_KINDS)})
        return 0

    if args.clear_cookie:
        key = args.clear_cookie.strip()
        if key not in PLATFORM_SPECS:
            return fail(f"未知平台：{key}", 2)
        result = clear_credential(key)
        emit({"ok": bool(result.get("ok")), "platform": key, "action": "clear", **result})
        return 0 if result.get("ok") else 1

    if args.save_cookie:
        key, source = args.save_cookie[0].strip(), args.save_cookie[1]
        if key not in PLATFORM_SPECS:
            return fail(f"未知平台：{key}", 2)
        try:
            value = open(source, encoding="utf-8").read()
        except OSError as exc:
            return fail(f"读不了临时文件：{exc}")
        try:
            result = save_credential(key, value)
        finally:
            # 无论成败都立刻删掉中转文件：它含明文凭证。
            try:
                os.remove(source)
            except OSError:
                pass
        emit({"ok": bool(result.get("ok")), "platform": key, "action": "save", **result})
        return 0 if result.get("ok") else 1

    home = os.path.abspath(args.home)
    if not os.path.isdir(os.path.join(home, "adapters")):
        return fail(f"未找到适配器目录：{os.path.join(home, 'adapters')}")

    if args.list:
        emit({
            "ok": True,
            "platforms": [
                {"id": k, "name": v[1], "unit": v[2], "claiming": v[3]}
                for k, v in PLATFORM_SPECS.items()
            ],
        })
        return 0

    # 按路径加载适配器包，避免与 PyPI 同名包冲突。
    sys.path.insert(0, home)
    try:
        from adapters import (jimeng, kling, lingxi, trae,  # noqa: E402
                              workbuddy, workbuddy_intl)
    except Exception as exc:  # noqa: BLE001
        return fail(f"导入适配器失败：{type(exc).__name__}: {exc}")

    modules = {
        "workbuddy": workbuddy,
        "workbuddy_intl": workbuddy_intl,
        "trae": trae,
        "lingxi": lingxi,
        "jimeng": jimeng,
        "kling": kling,
    }

    keys = [k.strip() for k in args.only.split(",") if k.strip()] or list(PLATFORM_SPECS)
    unknown = [k for k in keys if k not in modules]
    if unknown:
        return fail(
            f"未知平台：{', '.join(unknown)}；可选：{', '.join(PLATFORM_SPECS)}", 2
        )

    started = datetime.datetime.now()

    # 体检模式：逐平台 dry-run 一次，只报「登录态通不通」，绝不领取。
    if args.check:
        checked = [check_platform(modules, key) for key in keys]
        elapsed = (datetime.datetime.now() - started).total_seconds()
        emit({
            "ok": True,
            "mode": "check",
            "generated_at": started.isoformat(timespec="seconds"),
            # 固定 false：体检永远不领取，这样前端不必再判断一次。
            "dry_run": True,
            "source": "dry_run",
            "elapsed_seconds": round(elapsed, 1),
            "checks": checked,
            "counts": {
                "total": len(checked),
                "ok": sum(1 for c in checked if c["ok"]),
                "missing": sum(1 for c in checked if c["status"] == "missing"),
                "failed": sum(1 for c in checked if c["status"] in ("failed", "unknown")),
            },
        })
        return 0

    results = []
    for key in keys:
        try:
            row = modules[key].run(dry_run=args.dry_run)
            results.append(normalize_result(key, row, PLATFORM_SPECS[key]))
        except FileNotFoundError as exc:
            results.append({
                "platform": key,
                "name": PLATFORM_SPECS[key][1],
                "claiming": PLATFORM_SPECS[key][3],
                "unit": PLATFORM_SPECS[key][2],
                "result": "ERROR",
                "detail": f"缺少前置条件：{exc}",
                "balance": None,
            })
        except Exception as exc:  # noqa: BLE001
            results.append({
                "platform": key,
                "name": PLATFORM_SPECS[key][1],
                "claiming": PLATFORM_SPECS[key][3],
                "unit": PLATFORM_SPECS[key][2],
                "result": "EXCEPTION",
                "detail": f"{type(exc).__name__}: {exc}",
                "balance": None,
            })
    elapsed = (datetime.datetime.now() - started).total_seconds()

    ok_count = sum(1 for r in results if r["result"] in SUCCESS_CODES)
    emit({
        "ok": True,
        "generated_at": started.isoformat(timespec="seconds"),
        "dry_run": bool(args.dry_run),
        # 诚实性：dry_run 时没有任何真实领取动作，来源必须标注清楚。
        "source": "dry_run" if args.dry_run else "live",
        "elapsed_seconds": round(elapsed, 1),
        # 只统计、绝不跨平台累加余额：积分 / credits / 灵感值是不同币种。
        "counts": {
            "total": len(results),
            "success": ok_count,
            "other": len(results) - ok_count,
        },
        "results": results,
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())
