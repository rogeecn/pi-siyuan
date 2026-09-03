基于 MCP 仓库 <https://github.com/porkll/siyuan-mcp> 实现 pi extension pi-siyuan（该仓库仅作参考：工具集划分、参数设计、SiYuan API 调用方式照它学；所有功能在本 extension 内自行实现，不引入其 npm 包）

~/.zshenv 中已经声明了 SIYUAN_API_URL, SIYUAN_TOKEN 环境变量

要求：
1、实现环境变量和配置文件定义上述2个可用连接信息
2、实现笔记本级的 RWD 分开定义，三个权限可自由组合；另支持单独的 "NONE"：表示该笔记本禁止一切操作（不计入任何“任一 R/W/D”放行集合，也永远不满足“所有”类要求）
3、笔记本和任何操作需要先审计上述权限是否满足要求，否则拒绝执行
4、新的笔记本未定义权限默认只有R权限，并把笔记本ID和名称（仅做为humanread）补充到配置文件中。

补充规则：

5、架构：所有功能自行实现，extension 内直接封装 SiYuan HTTP API（/api/*，带 Authorization: Token 头），外面包一层权限审计。参考 porkll/siyuan-mcp 的工具划分与参数设计，但不依赖它的代码，也不起 MCP 子进程。

6、连接配置：环境变量 SIYUAN_API_URL / SIYUAN_TOKEN 优先；缺失时回落到配置文件。配置文件路径 `~/.pi/agent/extensions/pi-siyuan/config.json`，结构：

```json
{
  "apiUrl": "http://127.0.0.1:6806",
  "token": "",
  "notebooks": [
    { "id": "20260101120000-abcdef", "name": "个人笔记", "permissions": ["R", "W"] }
  ]
}
```

permissions 取值为 R / W / D 的自由组合，或仅为 ["NONE"]。name 仅做 human-readable，一切逻辑按 id 匹配。

7、审计豁免：`list_notebooks` 及连通性检查不做权限审计（审计依赖笔记本列表本身，且这是发现新笔记本的入口）。审计失败与拒绝时，错误消息必须写明：目标笔记本（id+name）、需要的权限、缺失的权限、被拒绝的操作名。

8、按笔记本审计的工具：入参是 docId/blockId 的工具（get_document_content / append_to_document / update_document / move_documents 的 from 侧），审计前先通过 SiYuan `/api/query` SQL 反查该块所属笔记本（查 `blocks` 表的 `box` 字段），再查该笔记本权限。docId 反查失败 = 拒绝。

9、跨笔记本全局工具的审计规则：

- 全局读（unified_search / list_all_tags / list_snapshots / get_recently_updated_documents / get_document_tree 按 to_notebook_root 归入目标笔记本审计）：存在任一笔记本有 R 即放行（NONE 笔记本不算 R）
- batch_replace_tag：所有笔记本都配置了 W 才放行（任一 NONE 或非 W 笔记本存在即拒绝）
- create_snapshot：存在任一 R 即放行（只读备份，不破坏数据）
- rollback_to_snapshot：所有笔记本都配置了 D 才放行（回滚覆盖全库；任一 NONE 或非 D 笔记本存在即拒绝）
- D 权限的语义 = 破坏性/不可逆操作：rollback、move_documents 移出源笔记本、未来接入的删除类 API。move_documents 需要 from 笔记本有 D + to 笔记本有 W。

10、新笔记本同步：每次 list_notebooks 调用时，把 API 返回的笔记本列表与配置文件比对——未记录的笔记本补写 `{id, name, permissions: ["R"]}`；已记录但 name 变了的更新 name。落盘后放行。

11、把 15 个工具全部映射进 extension，工具名与 siyuan-mcp 保持一致：unified_search、get_document_content、create_document、append_to_document、update_document、move_documents、get_document_tree、append_to_daily_note、list_notebooks、get_recently_updated_documents、create_snapshot、list_snapshots、rollback_to_snapshot、list_all_tags、batch_replace_tag。

12、留一个审计逻辑的最小自检（纯函数测试权限矩阵判定即可，不需要 mock HTTP）。

13、（2026-09-04 补充）发布图文文章需要图片上传能力，新增第 16 个工具 `upload_asset`（不在 siyuan-mcp 工具集内，为 pi-siyuan 扩展）：读本地文件列表 → POST /api/asset/upload（multipart 字段名 **file[]**，files/files[] 会被该部署反代吞成空 succMap）→ 返回 succMap 原文件名→assets/ 路径。审计：目标笔记本需 W。上传后把返回的 assets/ 路径填进 create_document 的 Markdown 图片链接。code:0 + 空 succMap 视为失败必须报错（该部署字段名回归时的静默失败症状）。
