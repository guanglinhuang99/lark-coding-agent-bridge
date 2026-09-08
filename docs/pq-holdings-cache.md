# PQ 数据自然日缓存

企业微信本地 direct bridge 在加载业务模块前为 `azpy.db_read` 安装缓存。
所有 `pqread` 连接的查询均纳入缓存，包括持仓、净值、产品、交易、日期和关联方数据；JYDB 等其他连接直接读取。

- 按 Asia/Shanghai 自然日失效。23:59 获取的结果在次日 00:00 失效，不是读取后 24 小时。
- 缓存键包含连接名、完整 SQL、位置参数及关键字参数。不同日期、产品、筛选范围和返回选项不混用，每种查询每日首次读取 PQ。
- 持久文件为 bridge state-dir 下的 `pq-reads-daily.sqlite3`，权限为 0600，重启后仍可复用。旧的持仓专用缓存文件不再读取。
- SQLite 事务保证线程和进程间去重；首次未命中的 PQ 查询串行执行。过期记录在下一次 PQ 查询时清理。
- 成功空结果也缓存；查询异常回滚，允许重试。保留 DataFrame 列类型、日期、Decimal 和空值，返回独立副本。
- 日内数据库补录不会自动刷新已缓存查询。上层已有缓存保持原逻辑，其再次调用数据库入口时受本缓存控制。
- 不缓存测算结果或非 PQ 台账；仅作用于企业微信本地 direct bridge，独立运行的 risk-service 不受影响。

验证：`/Users/guanglin/miniforge3/bin/python3 -m unittest discover -s tests/python -p 'test_*.py'`。
