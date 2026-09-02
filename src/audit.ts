/**
 * 权限审计（纯函数部分 + 配置管理）
 * 规则来源：AGENTS.md 第 6/7/8/9/10 条
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SiYuanClient } from "./siyuan-client.ts";

export type Perm = "R" | "W" | "D";

export interface NotebookConfig {
	id: string;
	name: string;
	permissions: string[]; // ("R"|"W"|"D")[] 或 ["NONE"]
}

export interface PiSiyuanConfig {
	apiUrl: string;
	token: string;
	notebooks: NotebookConfig[];
}

export const CONFIG_PATH = join(
	homedir(),
	".pi/agent/extensions/pi-siyuan/config.json",
);

export class AuditError extends Error {
	constructor(message: string) {
		super(message);
	}
}

// ---------- 纯函数：权限矩阵判定（自检目标） ----------

export function permsOf(nb: NotebookConfig): Set<Perm> {
	if (nb.permissions.includes("NONE")) return new Set();
	return new Set(
		nb.permissions.filter((p): p is Perm => p === "R" || p === "W" || p === "D"),
	);
}

/** 按笔记本审计：目标笔记本需要 required 权限 */
export function auditNotebook(
	notebooks: NotebookConfig[],
	notebookId: string,
	required: Perm[],
): { ok: boolean; nb?: NotebookConfig; missing: Perm[] } {
	const nb = notebooks.find((n) => n.id === notebookId);
	if (!nb) return { ok: false, missing: required };
	const perms = permsOf(nb);
	const missing = required.filter((p) => !perms.has(p));
	return { ok: missing.length === 0, nb, missing };
}

/** 全局"任一"审计：存在任一笔记本有 perm 即放行（NONE 不算） */
export function auditAny(notebooks: NotebookConfig[], perm: Perm): boolean {
	return notebooks.some((n) => permsOf(n).has(perm));
}

/** 全局"所有"审计：所有笔记本都有 perm 才放行（NONE 永不满足） */
export function auditAll(notebooks: NotebookConfig[], perm: Perm): boolean {
	return notebooks.length > 0 && notebooks.every((n) => permsOf(n).has(perm));
}

/** 拒绝消息（AGENTS.md 第 7 条格式要求） */
export function denyMessage(
	nb: NotebookConfig | undefined,
	required: Perm[],
	missing: Perm[],
	operation: string,
): string {
	const target = nb ? `笔记本 ${nb.id}(${nb.name})` : `未知笔记本`;
	return `权限拒绝：${target} 执行「${operation}」需要 ${required.join("/") || "（无）"}，缺失 ${missing.join("/") || "（无）"}`;
}

// ---------- 配置加载 / 新笔记本同步 ----------

export function loadConfig(cfgPath: string = CONFIG_PATH): PiSiyuanConfig {
	if (existsSync(cfgPath)) {
		try {
			return JSON.parse(readFileSync(cfgPath, "utf-8"));
		} catch {
			// 损坏则重建
		}
	}
	const cfg = {
		apiUrl: "http://127.0.0.1:6806",
		token: "",
		notebooks: [],
	};
	saveConfig(cfg, cfgPath);
	return cfg;
}

export function resolveConnection(): { apiUrl: string; token: string } {
	const envUrl = process.env.SIYUAN_API_URL;
	const envToken = process.env.SIYUAN_TOKEN;
	const cfg = loadConfig();
	return {
		apiUrl: envUrl || cfg.apiUrl || "http://127.0.0.1:6806",
		token: envToken || cfg.token || "",
	};
}

/** 新笔记本同步（第 10 条）：补 {id,name,permissions:["R"]}；name 变了更新。返回是否落盘 */
export function syncNotebooks(
	cfg: PiSiyuanConfig,
	apiNotebooks: Array<{ id: string; name: string }>,
	cfgPath: string = CONFIG_PATH,
): boolean {
	let dirty = false;
	for (const nb of apiNotebooks) {
		const existing = cfg.notebooks.find((n) => n.id === nb.id);
		if (!existing) {
			cfg.notebooks.push({ id: nb.id, name: nb.name, permissions: ["R"] });
			dirty = true;
		} else if (existing.name !== nb.name) {
			existing.name = nb.name;
			dirty = true;
		}
	}
	if (dirty) saveConfig(cfg, cfgPath);
	return dirty;
}

export function saveConfig(cfg: PiSiyuanConfig, cfgPath: string = CONFIG_PATH) {
	mkdirSync(dirname(cfgPath), { recursive: true });
	writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
}

// ---------- 审计入口（组合纯函数 + docId 反查） ----------

export class Auditor {
	private client: SiYuanClient;
	private cfg: PiSiyuanConfig;

	constructor(client: SiYuanClient, cfg: PiSiyuanConfig) {
		this.client = client;
		this.cfg = cfg;
	}

	/** docId/blockId → 笔记本 → 权限（第 8 条）。反查失败 = 拒绝 */
	async auditByBlockId(
		blockId: string,
		required: Perm[],
		operation: string,
	): Promise<void> {
		const box = await this.client.boxOf(blockId);
		if (!box) {
			throw new AuditError(
				`权限拒绝：块 ${blockId} 无法反查所属笔记本（docId 无效或不可见），执行「${operation}」需要 ${required.join("/")}`,
			);
		}
		this.auditNotebookId(box, required, operation);
	}

	/** notebookId 直接审计（第 3 条） */
	auditNotebookId(
		notebookId: string,
		required: Perm[],
		operation: string,
	): void {
		const r = auditNotebook(this.cfg.notebooks, notebookId, required);
		if (!r.ok)
			throw new AuditError(denyMessage(r.nb, required, r.missing, operation));
	}

	/** 全局读（第 9 条：任一 R） */
	auditGlobalRead(operation: string): void {
		if (!auditAny(this.cfg.notebooks, "R")) {
			throw new AuditError(
				`权限拒绝：执行「${operation}」需要至少一个笔记本有 R 权限，当前没有任何笔记本可读`,
			);
		}
	}

	/** batch_replace_tag：所有 W（第 9 条） */
	auditAllWrite(operation: string): void {
		if (!auditAll(this.cfg.notebooks, "W")) {
			throw new AuditError(
				`权限拒绝：执行「${operation}」需要所有笔记本都配置 W 权限`,
			);
		}
	}

	/** create_snapshot：任一 R（第 9 条） */
	auditSnapshotCreate(operation: string): void {
		if (!auditAny(this.cfg.notebooks, "R")) {
			throw new AuditError(
				`权限拒绝：执行「${operation}」需要至少一个笔记本有 R 权限`,
			);
		}
	}

	/** rollback_to_snapshot：所有 D（第 9 条） */
	auditRollback(operation: string): void {
		if (!auditAll(this.cfg.notebooks, "D")) {
			throw new AuditError(
				`权限拒绝：执行「${operation}」回滚会覆盖全库，需要所有笔记本都配置 D 权限`,
			);
		}
	}

	/** move_documents：from D + to W（第 9 条） */
	auditMove(fromBox: string, toNotebook: string, operation: string): void {
		this.auditNotebookId(fromBox, ["D"], operation);
		this.auditNotebookId(toNotebook, ["W"], operation);
	}
}
