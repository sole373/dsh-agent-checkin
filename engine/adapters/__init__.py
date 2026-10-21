"""签到适配器包。

每个模块暴露 `run(dry_run: bool = False) -> dict`，返回结构化结果：
    {"platform": str, "result": "OK|ALREADY|INACTIVE|AUTH_REJECTED|NETWORK|ERROR|...",
     ...附加字段}
"""
