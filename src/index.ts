/**
 * pi-siyuan — SiYuan Note extension for pi coding agent
 *
 * 架构（AGENTS.md 第 5 条）：直接封装 SiYuan HTTP API + 权限审计层。
 * 工具划分与参数设计参考 porkll/siyuan-mcp，不依赖其代码。
 *
 * 渐进式披露（goal 4）：15 个工具全部 registerTool 注册，
 * 但初始只激活 siyuan_discover 一个 loader 工具；
 * loader 按需 setActiveTools 增量激活匹配的工具。
 *
 * 审计豁免（第 7 条）：list_notebooks（即 siyuan_notebooks_loader）与连通性检查不做权限审计。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { SiYuanClient } from "./siyuan-client.ts";
import {
	Auditor,
	AuditError,
	loadConfig,
	resolveConnection,
	syncNotebooks,
	type PiSiyuanConfig,
} from "./audit.ts";

// 15 个工具名（AGENTS.md 第 11 条，与 porkll/siyuan-mcp 一致）
const SIYUAN_TOOL_NAMES = new Set([
	"unified_search",
	"get_document_content",
	"create_document",
	"append_to_document",
	"update_document",
	"move_documents",
	"get_document_tree",
	"append_to_daily_note",
	"list_notebooks",
	"get_recently_updated_documents",
	"create_snapshot",
	"list_snapshots",
	"rollback_to_snapshot",
	"list_all_tags",
	"batch_replace_tag",
]);

interface ToolDeps {
	client: SiYuanClient;
	auditor: Auditor;
	cfg: PiSiyuanConfig;
}

function ok(text: string, extra?: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }], details: extra ?? {} };
}

function fail(e: unknown) {
	const msg = e instanceof Error ? e.message : String(e);
	return {
		content: [{ type: "text" as const, text: `❌ ${msg}` }],
		isError: true,
		details: {},
	};
}

// list_notebooks 本体（审计豁免 + 新笔记本同步，第 7/10 条）
async function listNotebooksBody(deps: ToolDeps) {
	const notebooks = await deps.client.lsNotebooks();
	syncNotebooks(deps.cfg, notebooks); // 落盘 {id,name,permissions:["R"]}
	const lines = notebooks.map((nb) => {
		const conf = deps.cfg.notebooks.find((n) => n.id === nb.id);
		const perms = conf ? conf.permissions.join("") : "R(默认)";
		return `${nb.id} | ${nb.name} | ${perms}${nb.closed ? " | (已关闭)" : ""}`;
	});
	return ok(`共 ${notebooks.length} 个笔记本：\n` + lines.join("\n"), {
		count: notebooks.length,
	});
}

export default function siyuanExtension(pi: ExtensionAPI) {
	const conn = resolveConnection(); // env 优先，config 兜底（第 6 条）
	const client = new SiYuanClient(conn.apiUrl, conn.token);
	const cfg = loadConfig();
	const deps: ToolDeps = { client, auditor: new Auditor(client, cfg), cfg };

	// 审计包装器：AuditError → isError 结果（错误消息含笔记本/权限/操作名，第 7 条）
	function audited(
		name: string,
		fn: (p: any) => Promise<ReturnType<typeof ok>>,
	) {
		return async (_toolCallId: string, params: any) => {
			try {
				return await fn(params);
			} catch (e) {
				return fail(e);
			}
		};
	}

	// ============ 15 个工具（第 11 条） ============

	pi.registerTool({
		name: "list_notebooks",
		label: "List Notebooks",
		description:
			"列出所有 SiYuan 笔记本（含权限配置）。新笔记本会自动以 R 权限记录到配置文件。",
		parameters: Type.Object({}),
		execute: audited("list_notebooks", async () => listNotebooksBody(deps)),
	});

	pi.registerTool({
		name: "unified_search",
		label: "Unified Search",
		description: "统一搜索：按内容或文档标题搜索（全库，需任一笔记本 R 权限）。",
		parameters: Type.Object({
			content: Type.Optional(Type.String({ description: "内容关键词" })),
			filename: Type.Optional(Type.String({ description: "文档标题关键词" })),
			limit: Type.Optional(Type.Number({ description: "返回条数，默认 10" })),
		}),
		execute: audited("unified_search", async (p) => {
			deps.auditor.auditGlobalRead("unified_search"); // 第 9 条
			const limit = Math.min(p.limit ?? 10, 50);
			let results: any[] = [];
			if (p.filename) results = await client.searchDocTitles(p.filename, limit);
			if (p.content) {
				const c = await client.searchContent(p.content, limit);
				results = results.length
					? results.filter((r) => !c.some((x) => x.id === r.id)).concat(c)
					: c;
			}
			if (!p.content && !p.filename)
				return fail(new Error("content 与 filename 至少提供一个"));
			return ok(
				`搜索结果 ${results.length} 条：\n` +
					results
						.slice(0, limit)
						.map((r) => `${r.box}/${r.id} | ${String(r.content ?? "").slice(0, 100)}`)
						.join("\n"),
			);
		}),
	});

	pi.registerTool({
		name: "get_document_content",
		label: "Get Document Content",
		description: "获取文档的 Markdown 内容（按 docId，需所属笔记本 R 权限）。",
		parameters: Type.Object({ docId: Type.String({ description: "文档 ID" }) }),
		execute: audited("get_document_content", async (p) => {
			await deps.auditor.auditByBlockId(p.docId, ["R"], "get_document_content"); // 第 8 条
			const content = await client.getDocContent(p.docId);
			return ok(content, { docId: p.docId });
		}),
	});

	pi.registerTool({
		name: "create_document",
		label: "Create Document",
		description: "在指定笔记本创建文档（需该笔记本 W 权限）。",
		parameters: Type.Object({
			notebook: Type.String({ description: "笔记本 ID" }),
			path: Type.String({ description: "文档路径，如 /notes/new-doc" }),
			markdown: Type.String({ description: "Markdown 内容" }),
		}),
		execute: audited("create_document", async (p) => {
			deps.auditor.auditNotebookId(p.notebook, ["W"], "create_document");
			const docId = await client.createDoc(p.notebook, p.path, p.markdown);
			return ok(`已创建文档 ${docId}（${p.notebook}${p.path}）`, { docId });
		}),
	});

	pi.registerTool({
		name: "append_to_document",
		label: "Append To Document",
		description: "向文档末尾追加 Markdown 内容（需所属笔记本 W 权限）。",
		parameters: Type.Object({
			docId: Type.String({ description: "文档 ID" }),
			markdown: Type.String({ description: "追加的 Markdown 内容" }),
		}),
		execute: audited("append_to_document", async (p) => {
			await deps.auditor.auditByBlockId(p.docId, ["W"], "append_to_document");
			await client.appendBlock(p.docId, p.markdown);
			return ok(`已追加内容到文档 ${p.docId}`, { docId: p.docId });
		}),
	});

	pi.registerTool({
		name: "update_document",
		label: "Update Document",
		description: "覆盖更新文档首块内容（需所属笔记本 W 权限）。",
		parameters: Type.Object({
			docId: Type.String({ description: "文档 ID" }),
			markdown: Type.String({ description: "新的 Markdown 内容" }),
		}),
		execute: audited("update_document", async (p) => {
			await deps.auditor.auditByBlockId(p.docId, ["W"], "update_document");
			await client.updateBlock(p.docId, p.markdown);
			return ok(`已更新文档 ${p.docId} 首块`, { docId: p.docId });
		}),
	});

	pi.registerTool({
		name: "move_documents",
		label: "Move Documents",
		description: "移动文档到目标笔记本/路径（from 笔记本需 D，to 笔记本需 W）。",
		parameters: Type.Object({
			from_ids: Type.Array(Type.String(), { description: "源文档 ID 列表" }),
			to_notebook_root: Type.String({
				description: "目标笔记本 ID 或 笔记本ID/路径",
			}),
		}),
		execute: audited("move_documents", async (p) => {
			const [toNotebook, ...rest] = String(p.to_notebook_root).split("/");
			const toPath = rest.length ? "/" + rest.join("/") : "/";
			// from 侧逐个反查（第 8 条），逐个审计 D；to 审计 W（第 9 条）
			for (const id of p.from_ids) {
				const box = await client.boxOf(id);
				if (!box)
					return fail(
						new Error(
							`权限拒绝：块 ${id} 无法反查所属笔记本，执行「move_documents」需要 D`,
						),
					);
				deps.auditor.auditMove(box, toNotebook, "move_documents");
			}
			await client.moveDocs(p.from_ids, toNotebook, toPath);
			return ok(`已移动 ${p.from_ids.length} 个文档到 ${p.to_notebook_root}`);
		}),
	});

	pi.registerTool({
		name: "get_document_tree",
		label: "Get Document Tree",
		description:
			"获取笔记本文档树（按 to_notebook_root 归入目标笔记本审计，需 R；无参数时需任一 R）。",
		parameters: Type.Object({
			to_notebook_root: Type.Optional(
				Type.String({ description: "笔记本 ID（可带 /路径）" }),
			),
			depth: Type.Optional(Type.Number({ description: "深度，默认 1" })),
		}),
		execute: audited("get_document_tree", async (p) => {
			if (p.to_notebook_root) {
				const [notebook] = String(p.to_notebook_root).split("/");
				deps.auditor.auditNotebookId(notebook, ["R"], "get_document_tree");
				const files = await client.listDocsByPath(notebook, "/");
				return ok(
					files
						.slice(0, 100)
						.map((f: any) => `${f.path} | ${f.name}`)
						.join("\n") || "(空)",
				);
			}
			deps.auditor.auditGlobalRead("get_document_tree");
			const notebooks = await client.lsNotebooks();
			const out: string[] = [];
			for (const nb of notebooks.slice(0, 20)) {
				const files = await client.listDocsByPath(nb.id, "/");
				out.push(`# ${nb.name} (${files.length} docs)`);
				out.push(...files.slice(0, 50).map((f: any) => `  ${f.path} | ${f.name}`));
			}
			return ok(out.join("\n"));
		}),
	});

	pi.registerTool({
		name: "append_to_daily_note",
		label: "Append To Daily Note",
		description: "追加到今天的日记（不存在则自动创建；需该笔记本 W 权限）。",
		parameters: Type.Object({
			notebook: Type.String({ description: "笔记本 ID" }),
			markdown: Type.String({ description: "追加内容" }),
		}),
		execute: audited("append_to_daily_note", async (p) => {
			deps.auditor.auditNotebookId(p.notebook, ["W"], "append_to_daily_note");
			const r = await client.dailyNote(p.notebook, p.markdown);
			return ok(`${r.created ? "已创建" : "已追加到"}日记 ${r.docId}`, r);
		}),
	});

	pi.registerTool({
		name: "get_recently_updated_documents",
		label: "Get Recently Updated Documents",
		description: "获取最近更新的文档（全库，需任一 R 权限）。",
		parameters: Type.Object({
			limit: Type.Optional(Type.Number({ description: "条数，默认 10" })),
		}),
		execute: audited("get_recently_updated_documents", async (p) => {
			deps.auditor.auditGlobalRead("get_recently_updated_documents");
			const limit = Math.min(p.limit ?? 10, 50);
			const rows = await client.sql(
				`select id, box, content, updated from blocks where type='d' order by updated desc limit ${limit}`,
			);
			return ok(
				rows
					.map((r) => `${r.updated} | ${r.box} | ${r.id} | ${r.content}`)
					.join("\n") || "(无)",
			);
		}),
	});

	pi.registerTool({
		name: "create_snapshot",
		label: "Create Snapshot",
		description: "创建全库快照备份（需任一 R 权限，只读不破坏数据）。",
		parameters: Type.Object({
			memo: Type.Optional(Type.String({ description: "备注" })),
		}),
		execute: audited("create_snapshot", async (p) => {
			deps.auditor.auditSnapshotCreate("create_snapshot");
			await client.createSnapshot(p.memo || "pi-siyuan snapshot");
			return ok("快照已创建");
		}),
	});

	pi.registerTool({
		name: "list_snapshots",
		label: "List Snapshots",
		description: "列出快照（需任一 R 权限）。",
		parameters: Type.Object({
			page: Type.Optional(Type.Number({ description: "页码，默认 1" })),
		}),
		execute: audited("list_snapshots", async (p) => {
			deps.auditor.auditGlobalRead("list_snapshots");
			const d = await client.listSnapshots(p.page ?? 1);
			const snaps: any[] = d?.snapshots ?? [];
			return ok(
				`第 ${d?.pageCount ?? "?"} 页快照：\n` +
					snaps
						.map((s) => `${s.id} | ${s.hCreated} | ${s.memo} | ${s.hSize}`)
						.join("\n"),
			);
		}),
	});

	pi.registerTool({
		name: "rollback_to_snapshot",
		label: "Rollback To Snapshot",
		description:
			"回滚到指定快照（覆盖全库，需所有笔记本 D 权限）。不可逆，慎用。",
		parameters: Type.Object({ id: Type.String({ description: "快照 ID" }) }),
		execute: audited("rollback_to_snapshot", async (p) => {
			deps.auditor.auditRollback("rollback_to_snapshot");
			await client.rollbackToSnapshot(p.id);
			return ok(`已回滚到快照 ${p.id}`);
		}),
	});

	pi.registerTool({
		name: "list_all_tags",
		label: "List All Tags",
		description: "列出全库所有标签（需任一 R 权限）。",
		parameters: Type.Object({}),
		execute: audited("list_all_tags", async () => {
			deps.auditor.auditGlobalRead("list_all_tags");
			const tags = await client.searchTags("");
			return ok(tags.join(", ") || "(无标签)", { count: tags.length });
		}),
	});

	pi.registerTool({
		name: "batch_replace_tag",
		label: "Batch Replace Tag",
		description:
			"批量替换/删除全库标签（需所有笔记本 W 权限）。new_tag 为空 = 删除标签。",
		parameters: Type.Object({
			old_tag: Type.String({ description: "旧标签名" }),
			new_tag: Type.Optional(Type.String({ description: "新标签名；空则删除" })),
		}),
		execute: audited("batch_replace_tag", async (p) => {
			deps.auditor.auditAllWrite("batch_replace_tag");
			if (!p.new_tag)
				return fail(new Error("该部署暂不支持删除标签（new_tag 必填）"));
			await client.renameTag(p.old_tag, p.new_tag);
			return ok(`已将标签「${p.old_tag}」替换为「${p.new_tag}」`);
		}),
	});

	// ============ 渐进式披露 loader（goal 4） ============

	pi.registerTool({
		name: "siyuan_discover",
		label: "SiYuan Discover",
		description:
			"搜索并激活 SiYuan 笔记工具（15 个工具按需加载）。输入能力关键词（如 search / read / write / snapshot / tag / notebook / move / daily）。",
		promptSnippet: "操作 SiYuan 笔记时先用 siyuan_discover 激活对应工具",
		parameters: Type.Object({
			query: Type.Optional(
				Type.String({ description: "能力关键词，空则列出全部" }),
			),
		}),
		async execute(_toolCallId, params) {
			// 连通性检查（审计豁免，第 7 条）
			try {
				const version = await client.version();
				const terms = String(params.query ?? "")
					.toLowerCase()
					.split(/[^a-z0-9]+/)
					.filter(Boolean);
				const all = pi.getAllTools().filter((t) => SIYUAN_TOOL_NAMES.has(t.name));
				const matches = terms.length
					? all
							.filter((t) =>
								terms.some((term) =>
									`${t.name} ${t.description}`.toLowerCase().includes(term),
								),
							)
							.map((t) => t.name)
					: all.map((t) => t.name);
				if (matches.length === 0) {
					return ok(
						`SiYuan ${version} 连接正常，但没有匹配「${params.query}」的工具。可用工具：\n${[...SIYUAN_TOOL_NAMES].join(", ")}`,
					);
				}
				const active = pi.getActiveTools();
				const added = matches.filter((name) => !active.includes(name));
				if (added.length) pi.setActiveTools([...new Set([...active, ...added])]);
				return ok(
					`SiYuan ${version} 连接正常。${added.length ? `已加载工具：${added.join(", ")}` : `匹配工具已激活：${matches.join(", ")}`}`,
					{ matches, added, version },
				);
			} catch (e) {
				return fail(e);
			}
		},
	});

	// 初始只激活 loader（渐进式披露）
	pi.on("session_start", () => {
		const initial = pi
			.getActiveTools()
			.filter((name) => !SIYUAN_TOOL_NAMES.has(name));
		pi.setActiveTools([...new Set([...initial, "siyuan_discover"])]);
	});
}
