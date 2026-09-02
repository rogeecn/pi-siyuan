/**
 * 审计逻辑最小自检（AGENTS.md 第 12 条）：纯函数权限矩阵判定
 * 运行：node src/audit.test.mjs（或 node --experimental-strip-types）
 */

import assert from "node:assert";
import { existsSync, rmSync } from "node:fs";
import {
	permsOf,
	auditNotebook,
	auditAny,
	auditAll,
	denyMessage,
	loadConfig,
	syncNotebooks,
} from "./audit.ts";

const nb = (id: string, permissions: string[], name = id) => ({
	id,
	name,
	permissions,
});

// ---- permsOf ----
assert.deepEqual([...permsOf(nb("a", ["R", "W"]))].sort(), ["R", "W"]);
assert.deepEqual([...permsOf(nb("a", ["NONE"]))], [], "NONE = 空权限集");
assert.deepEqual(
	[...permsOf(nb("a", ["NONE", "R"]))],
	[],
	"NONE 混入其他值仍为空",
);
assert.deepEqual(
	[...permsOf(nb("a", ["R", "X", "W"]))].sort(),
	["R", "W"],
	"非法值被过滤",
);

// ---- auditNotebook ----
assert.equal(auditNotebook([nb("a", ["R", "W"])], "a", ["R"]).ok, true);
assert.equal(auditNotebook([nb("a", ["R"])], "a", ["W"]).ok, false);
assert.deepEqual(auditNotebook([nb("a", ["R"])], "a", ["W", "D"]).missing, [
	"W",
	"D",
]);
assert.equal(
	auditNotebook([nb("a", ["NONE"])], "a", ["R"]).ok,
	false,
	"NONE 不满足 R",
);
assert.equal(
	auditNotebook([nb("a", ["R"])], "unknown", ["R"]).ok,
	false,
	"未知笔记本拒绝",
);

// ---- auditAny / auditAll ----
assert.equal(auditAny([nb("a", ["NONE"]), nb("b", ["R"])], "R"), true);
assert.equal(auditAny([nb("a", ["NONE"])], "R"), false, "NONE 不算 R");
assert.equal(auditAny([], "R"), false);
assert.equal(auditAll([nb("a", ["W"]), nb("b", ["W"])], "W"), true);
assert.equal(
	auditAll([nb("a", ["W"]), nb("b", ["NONE"])], "W"),
	false,
	"任一 NONE 拒绝",
);
assert.equal(
	auditAll([nb("a", ["W"]), nb("b", ["R", "D"])], "W"),
	false,
	"缺 W 拒绝",
);
assert.equal(
	auditAll([nb("a", ["W"]), nb("b", ["R", "W", "D"])], "W"),
	true,
	"R/W/D 含 W 满足「所有 W」",
);
assert.equal(auditAll([], "W"), false, "空列表不满足「所有」");

// ---- denyMessage 格式（第 7 条：id+name、需要的、缺失的、操作名） ----
const msg = denyMessage(
	nb("20260804180250-4kuh8xy", ["NONE"], "05-Vault"),
	["R"],
	["R"],
	"get_document_content",
);
assert.ok(
	msg.includes("20260804180250-4kuh8xy") && msg.includes("05-Vault"),
	"含 id+name",
);
assert.ok(msg.includes("get_document_content"), "含操作名");
assert.ok(/需要 R/.test(msg) && /缺失 R/.test(msg), "含需要/缺失权限");

// ---- 配置首次加载自动初始化 ----
const initDir = "/tmp/pi-siyuan-audit-test";
const initPath = `${initDir}/nested/config.json`;
rmSync(initDir, { recursive: true, force: true });
const initialized = loadConfig(initPath);
assert.equal(existsSync(initPath), true, "配置文件应在首次加载时创建");
assert.deepEqual(initialized, {
	apiUrl: "http://127.0.0.1:6806",
	token: "",
	notebooks: [],
});
rmSync(initDir, { recursive: true, force: true });

// ---- syncNotebooks（第 10 条）— 用临时路径，不污染真实配置 ----
const cfg: any = {
	apiUrl: "u",
	token: "t",
	notebooks: [nb("a", ["R", "W"], "旧名")],
};
const tmpPath = "/tmp/pi-siyuan-audit-test-config.json";
const dirty = syncNotebooks(
	cfg,
	[nb("a", ["R", "W"], "新名"), nb("new1", [], "新笔记本")],
	tmpPath,
);
assert.equal(dirty, true);
assert.equal(
	cfg.notebooks.find((n: any) => n.id === "a").name,
	"新名",
	"name 变了更新",
);
const added = cfg.notebooks.find((n: any) => n.id === "new1");
assert.deepEqual(added.permissions, ["R"], "新笔记本默认 R");
assert.equal(added.name, "新笔记本");

console.log("audit self-check: all assertions passed ✅");
