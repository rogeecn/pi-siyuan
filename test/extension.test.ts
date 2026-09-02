/**
 * extension 加载自检：用 mock ExtensionAPI 驱动 src/index.ts，
 * 验证 goal 4（注册最小工具集 + 渐进式披露）+ goal 1/2/3 的工具级端到端行为。
 * 运行：node --experimental-strip-types --no-warnings test/extension.test.ts
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---- mock ExtensionAPI ----
interface RegisteredTool {
	name: string;
	parameters: any;
	description: string;
	promptSnippet?: string;
	execute: (id: string, params: any) => Promise<any>;
}

const registered: RegisteredTool[] = [];
let activeTools: string[] = ["read", "bash", "edit", "write"]; // 模拟内置工具
const eventHandlers = new Map<string, Function>();

const pi: any = {
	registerTool(def: any) {
		registered.push(def);
	},
	getAllTools() {
		return registered.map((t) => ({ name: t.name, description: t.description }));
	},
	getActiveTools() {
		return [...activeTools];
	},
	setActiveTools(names: string[]) {
		activeTools = [...names];
	},
	on(ev: string, fn: Function) {
		eventHandlers.set(ev, fn);
	},
};

const CONFIG_PATH = join(
	homedir(),
	".pi/agent/extensions/pi-siyuan/config.json",
);

// ---- load extension ----
const mod = await import("../src/index.ts");
mod.default(pi);

// 15 个工具 + loader
const EXPECTED = [
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
	"siyuan_discover",
];
assert.equal(
	registered.length,
	EXPECTED.length,
	`注册 ${registered.length} 个工具`,
);
for (const name of EXPECTED)
	assert.ok(
		registered.find((t) => t.name === name),
		`${name} 已注册`,
	);
console.log(`✅ 4a. 全部 ${EXPECTED.length} 个工具注册（15 + loader）`);

// ---- session_start → 初始只激活 loader（渐进式披露核心） ----
const sessionStart = eventHandlers.get("session_start");
assert.ok(sessionStart, "注册了 session_start");
await sessionStart();
const siyuanTools = registered.map((t) => t.name);
assert.ok(activeTools.includes("siyuan_discover"), "loader 初始激活");
assert.ok(
	!siyuanTools.some((n) => n !== "siyuan_discover" && activeTools.includes(n)),
	"15 个业务工具初始全部未激活",
);
assert.ok(
	activeTools.includes("read") && activeTools.includes("bash"),
	"内置工具保留",
);
console.log(
	"✅ 4b. 渐进式披露：初始仅 siyuan_discover 激活，15 个工具按需加载",
);

const byName = (n: string) => registered.find((t) => t.name === n)!;

// ---- goal 1: 连接（loader 连通性检查，审计豁免） ----
const r1 = await byName("siyuan_discover").execute("t1", {});
assert.ok(
	!r1.isError,
	`loader 连通正常: ${JSON.stringify(r1.content?.[0]?.text?.slice(0, 60))}`,
);
assert.ok(r1.content[0].text.includes("3.8.2"), "返回 SiYuan 版本");
console.log("✅ 1. 连接正常：", r1.content[0].text.split("\n")[0]);

// ---- loader 渐进激活：query=search → unified_search + get_document_content? ----
// 空 query → 列出全部 → 首次已激活，再次调用 added 为空（已激活），matches 全量
const r2 = await byName("siyuan_discover").execute("t2", { query: "search" });
assert.ok(
	r2.details.matches.length > 0,
	`按需加载生效: ${JSON.stringify(r2.details)}`,
);
assert.ok(
	activeTools.includes("unified_search"),
	"unified_search 被激活（首次 loader 已加载）",
);
// 纯增量
for (const t of ["read", "bash", "siyuan_discover"])
	assert.ok(activeTools.includes(t), `保留 ${t}`);
console.log("✅ 4c. loader 按需激活：", r2.details.added.join(", "));

// ---- goal 3: 05-Vault (NONE) 各操作被拒 ----
// 用 05-Vault 内真实文档 id (Agnes-AI) 测 get_document_content
const VAULT_DOC = "20260602103402-rssx5ko";
const r3 = await byName("get_document_content").execute("t3", {
	docId: VAULT_DOC,
});
assert.ok(r3.isError, "读取 05-Vault 文档必须失败");
assert.ok(
	r3.content[0].text.includes("05-Vault") ||
		r3.content[0].text.includes(VAULT_DOC.slice(0, 14)),
	"拒绝消息含目标笔记本",
);
console.log(
	"✅ 3a. 05-Vault(NONE) get_document_content 被拒：",
	r3.content[0].text.slice(0, 100),
);

// append 也拒
const r4 = await byName("append_to_document").execute("t4", {
	docId: VAULT_DOC,
	markdown: "x",
});
assert.ok(r4.isError, "写 05-Vault 拒绝");
console.log("✅ 3b. 05-Vault(NONE) append_to_document 被拒");

// ---- goal 2: 权限管理正常（放行路径 + 拒绝路径） ----
// 2a: 读 06-GeekTime (RWD) 的文档
const r5 = await byName("get_document_content").execute("t5", {
	docId: "20260902151835-k7ktypf",
});
assert.ok(!r5.isError, "读 RWD 笔记本文档放行");
console.log("✅ 2a. 06-GeekTime(RWD) 读放行");

// 2b: 全局读放行
const r6 = await byName("unified_search").execute("t6", { content: "Agnes" });
assert.ok(!r6.isError, "unified_search 放行（任一 R）");
console.log(
	"✅ 2b. unified_search（任一 R）放行：",
	r6.content[0].text.split("\n")[0].slice(0, 50),
);

// 2c: batch_replace_tag 拒（存在 NONE + 99-Archived 无 W）
const r7 = await byName("batch_replace_tag").execute("t7", {
	old_tag: "AI",
	new_tag: "AI2",
});
assert.ok(r7.isError, "batch_replace_tag 拒绝");
console.log(
	"✅ 2c. batch_replace_tag（所有 W）拒绝：",
	r7.content[0].text.slice(0, 80),
);

// 2d: rollback 拒（所有 D 不满足）
const r8 = await byName("rollback_to_snapshot").execute("t8", {
	id: "fakesnap",
});
assert.ok(r8.isError, "rollback 拒绝");
console.log(
	"✅ 2d. rollback_to_snapshot（所有 D）拒绝：",
	r8.content[0].text.slice(0, 80),
);

// 2e: create_snapshot 放行（任一 R）
const r9 = await byName("create_snapshot").execute("t9", {
	memo: "pi-siyuan self-check",
});
assert.ok(!r9.isError, "create_snapshot 放行");
console.log("✅ 2e. create_snapshot（任一 R）放行");

// ---- goal 4 完整闭环：list_notebooks 审计豁免 + 新笔记本同步 ----
const before = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")).notebooks.length;
const r10 = await byName("list_notebooks").execute("t10", {});
assert.ok(!r10.isError, "list_notebooks 审计豁免");
const after = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")).notebooks;
assert.ok(after.length >= before, "配置落盘");
console.log(
	`✅ 4d. list_notebooks 审计豁免 + 同步落盘（${before} → ${after.length}）`,
);

console.log("\nextension self-check: all assertions passed ✅");
