# pi-siyuan

[pi coding agent](https://github.com/earendil-works/pi-coding-agent) 的 [SiYuan Note](https://b3log.org/siyuan) 扩展：直接封装 SiYuan HTTP API（`/api/*` + `Token` 认证），外面包一层**笔记本级 R/W/D 权限审计**。工具划分与参数设计参考 [porkll/siyuan-mcp](https://github.com/porkll/siyuan-mcp)，不依赖其代码，也不起 MCP 子进程。

## 特性

- **15 个工具**，与 siyuan-mcp 同名：`unified_search`、`get_document_content`、`create_document`、`append_to_document`、`update_document`、`move_documents`、`get_document_tree`、`append_to_daily_note`、`list_notebooks`、`get_recently_updated_documents`、`create_snapshot`、`list_snapshots`、`rollback_to_snapshot`、`list_all_tags`、`batch_replace_tag`
- **渐进式披露**：初始仅激活一个 `siyuan_discover` loader 工具（含连通性检查），其余 15 个工具按需增量加载，保持系统提示词前缀稳定
- **笔记本级 RWD 权限审计**：R 读 / W 写 / D 破坏性（rollback、move 移出、删除类），可自由组合；`NONE` = 禁止一切操作
- 拒绝消息包含：目标笔记本（id+name）、需要的权限、缺失的权限、被拒绝的操作名
- Pi 启动及调用 `list_notebooks` 时自动同步笔记本；新笔记本以 `R` 权限写入配置文件（审计豁免）
- 连接信息：环境变量优先，配置文件兜底

## 安装

### 方式一：npm（推荐）

```bash
pi install npm:pi-siyuan
# 或试用不落盘：
pi -e npm:pi-siyuan
```

### 方式二：git（Gitea）

```bash
pi install ssh://git@git.ipao.vip/rogee/pi-siyuan
# 或试用不落盘：
pi -e git:git.ipao.vip:rogee/pi-siyuan
```

### 方式三：手动放置

```bash
git clone git@git.ipao.vip:rogee/pi-siyuan.git ~/.pi/agent/extensions/pi-siyuan
# 包根目录含 index.ts，pi 会自动加载 extensions/*/index.ts
```

发布流程：推送 tag（如 `v0.1.0`）触发 Gitea workflow 自动发布到 npm（`.gitea/workflows/publish-npm.yml`，使用仓库 secret `NPM_PACKAGE_TOKEN`）。

## 配置

### 连接（环境变量优先）

```bash
# ~/.zshenv
export SIYUAN_API_URL="https://your-siyuan-host"   # 默认 http://127.0.0.1:6806
export SIYUAN_TOKEN="your-api-token"               # SiYuan 设置 → 关于 → API token
```

修改 `~/.zshenv` 后需新开 shell 并重启 Pi（已有进程不会自动获得新环境变量）。缺失时回落到 `~/.pi/agent/extensions/pi-siyuan/config.json`：

```json
{
  "apiUrl": "https://siyuan.example.com",
  "token": "your-token",
  "notebooks": [
    { "id": "20260101120000-abcdef", "name": "个人笔记", "permissions": ["R", "W"] },
    { "id": "20260101120001-bcdefa", "name": "日记", "permissions": ["R", "W", "D"] },
    { "id": "20260101120002-cdefab", "name": "敏感库", "permissions": ["NONE"] }
  ]
}
```

- `permissions`：`R`/`W`/`D` 自由组合，或 `["NONE"]`（禁止一切操作）
- `name` 仅做 human-readable，一切逻辑按 `id` 匹配
- Pi 启动时会创建该配置文件并同步笔记本；调用 `list_notebooks` 时也会再次同步。未记录的笔记本以 `["R"]` 补写，已有笔记本名称变化时更新 `name`

### 权限规则速查

| 操作 | 审计规则 |
| --- | --- |
| 读类（get_document_content 等） | 目标笔记本 `R` |
| 写类（create/append/update/daily note） | 目标笔记本 `W` |
| move_documents | 源笔记本 `D` + 目标笔记本 `W` |
| rollback_to_snapshot | **所有**笔记本 `D`（回滚覆盖全库） |
| batch_replace_tag | **所有**笔记本 `W` |
| create_snapshot | 任一笔记本 `R`（只读备份） |
| unified_search / list_all_tags / list_snapshots / 最近更新 / 文档树 | 任一笔记本 `R` |
| list_notebooks / 连通性检查 | 审计豁免 |

`NONE` 笔记本不计入任何"任一 R/W/D"放行集合，也永不满足"所有"类要求。

## 工具用法

会话中说「操作 SiYuan」时，先经过 `siyuan_discover` 按需加载工具：

```text
> 用 siyuan_discover 加载 search 工具，然后搜索「Agnes」
✅ SiYuan 3.8.2 连接正常。已加载工具：unified_search
```

读取 `NONE` 笔记本内的文档会被审计拒绝：

```text
❌ 权限拒绝：笔记本 20260804180250-4kuh8xy(05-Vault) 执行「get_document_content」需要 R，缺失 R
```

## 开发

```bash
git clone git@git.ipao.vip:rogee/pi-siyuan.git && cd pi-siyuan
npm install

# 权限矩阵纯函数自检
node --experimental-strip-types src/audit.test.ts

# 真实 API 集成自检（需要 SIYUAN_API_URL/SIYUAN_TOKEN）
SIYUAN_API_URL=… SIYUAN_TOKEN=… node --experimental-strip-types test/integration.test.ts

# 扩展加载 + 渐进披露端到端自检
SIYUAN_API_URL=… SIYUAN_TOKEN=… node --experimental-strip-types test/extension.test.ts
```

## 已知限制（针对部分反代部署）

某些反代会吞掉部分 SiYuan 端点的响应体（`/api/query/query`、`/api/search/fulltextSearchBlock`、`/api/repo/listSnapshots`、`/api/tag/replaceTag`、`/api/dailynote/*` 等）。本扩展已全部改用等价可用端点：

- SQL 查询用 `/api/query/sql`（搜索用 SQL `content LIKE` 替代 fulltext）
- 快照列表用 `/api/repo/getRepoSnapshots`
- 标签替换用 `/api/tag/renameTag`（暂不支持删除标签）
- 日记用 `createDocWithMd` 到 `/YYYY-MM-DD` 幂等创建

## License

MIT
