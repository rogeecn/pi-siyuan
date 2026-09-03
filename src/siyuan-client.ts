/**
 * SiYuan HTTP API 客户端
 * 直接封装 /api/*（Authorization: Token 头），无外部依赖。
 */

export class SiYuanError extends Error {
	code?: number;

	constructor(message: string, code?: number) {
		super(message);
		this.code = code;
	}
}

export class SiYuanClient {
	private apiUrl: string;
	private token: string;

	constructor(apiUrl: string, token: string) {
		this.apiUrl = apiUrl;
		this.token = token;
	}

	/** 连通性检查（审计豁免） */
	async version(): Promise<string> {
		const d = await this.call("/api/system/version", {});
		return d as string;
	}

	async lsNotebooks(): Promise<
		Array<{ id: string; name: string; closed: boolean }>
	> {
		const d = await this.call("/api/notebook/lsNotebooks", {});
		return d.notebooks ?? [];
	}

	/** SQL 查询（该部署的 /api/query/query 被反代吞掉，sql 可用） */
	async sql(stmt: string): Promise<any[]> {
		const d = await this.call("/api/query/sql", { stmt });
		return d ?? [];
	}

	/** docId/blockId → 所属笔记本 id（blocks.box）。查不到返回 null */
	async boxOf(blockId: string): Promise<string | null> {
		try {
			const rows = await this.sql(
				`select distinct box from blocks where id='${this.esc(blockId)}' or root_id='${this.esc(blockId)}' limit 1`,
			);
			return rows.length ? rows[0].box : null;
		} catch {
			return null;
		}
	}

	// ---- 文档 ----

	async createDoc(
		notebook: string,
		path: string,
		markdown: string,
	): Promise<string> {
		return (await this.call("/api/filetree/createDocWithMd", {
			notebook,
			path,
			markdown,
		})) as string;
	}

	async getDocContent(id: string): Promise<string> {
		const d = await this.call("/api/export/exportMdContent", { id });
		return d.content ?? "";
	}

	async appendBlock(parentID: string, markdown: string): Promise<any> {
		return this.call("/api/block/appendBlock", {
			dataType: "markdown",
			data: markdown,
			parentID,
		});
	}

	async updateBlock(id: string, markdown: string): Promise<any> {
		return this.call("/api/block/updateBlock", {
			dataType: "markdown",
			data: markdown,
			id,
		});
	}

	async moveDocs(
		fromIDs: string[],
		toNotebook: string,
		toPath: string,
	): Promise<any> {
		return this.call("/api/filetree/moveDocs", { fromIDs, toNotebook, toPath });
	}

	async listDocsByPath(notebook: string, path: string): Promise<any[]> {
		const d = await this.call("/api/filetree/listDocsByPath", { notebook, path });
		return d?.files ?? [];
	}

	/** daily note：/api/dailynote/* 在该部署返回空 body，退化为 createDocWithMd 幂等创建 /YYYY-MM-DD */
	async dailyNote(
		notebook: string,
		markdown: string,
	): Promise<{ docId: string; created: boolean }> {
		const today = new Date();
		const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(
			today.getDate(),
		).padStart(2, "0")}`;
		const path = `/${dateStr}`;
		// 已存在则追加
		try {
			const rows = await this.sql(
				`select id from blocks where type='d' and box='${this.esc(notebook)}' and content='${dateStr}' limit 1`,
			);
			if (rows.length) {
				await this.appendBlock(rows[0].id, markdown);
				return { docId: rows[0].id, created: false };
			}
		} catch {
			// 查询失败走创建
		}
		const docId = await this.createDoc(
			notebook,
			path,
			`# ${dateStr}\n\n${markdown}`,
		);
		return { docId, created: true };
	}

	// ---- 附件 ----

	/**
	 * 上传图片/附件（/api/asset/upload）。
	 * 该部署实测契约：multipart 字段名必须是 file[]（files/files[] 会被吞成空 succMap，
	 * SiYuan v3.8.2 kernel/model/upload.go: form.File["file[]"]），无 Authorization 401。
	 * 响应 {errFiles, succFiles:[{index,name,path}], succMap:{原名: "assets/新名"}}。
	 */
	async uploadAssets(
		files: Array<{ name: string; data: Uint8Array; mime?: string }>,
	): Promise<{ errFiles: string[]; succMap: Record<string, string> }> {
		if (!files.length)
			throw new SiYuanError("uploadAssets: 文件列表为空");
		const fd = new FormData();
		for (const f of files) {
			fd.append(
				"file[]",
				new Blob([f.data], {
					type: f.mime || "application/octet-stream",
				}),
				f.name,
			);
		}
		const d = await this.callForm("/api/asset/upload", fd);
		const errFiles: string[] = d?.errFiles ?? [];
		const succMap: Record<string, string> = d?.succMap ?? {};
		// 字段名回归/反代吞 body 时的症状就是 code:0 + 空 succMap —— 静默失败，必须显式报错
		if (!Object.keys(succMap).length && !errFiles.length)
			throw new SiYuanError(
				"上传返回空 succMap（文件未落库）：疑似 multipart 字段名回归或反代吞掉 body，当前字段名 file[]",
			);
		return { errFiles, succMap };
	}

	// ---- 搜索（fulltext 端点被吞，用 SQL）----

	async searchContent(query: string, limit: number): Promise<any[]> {
		return this.sql(
			`select id, box, root_id, content, type from blocks where content like '%${this.esc(query)}%' limit ${limit}`,
		);
	}

	async searchDocTitles(query: string, limit: number): Promise<any[]> {
		return this.sql(
			`select id, box, content from blocks where type='d' and content like '%${this.esc(query)}%' limit ${limit}`,
		);
	}

	// ---- 标签 ----

	async searchTags(k: string): Promise<string[]> {
		const d = await this.call("/api/search/searchTag", { k });
		const tags: string[] = (d?.tags ?? []).map((t: string) =>
			t.replace(/<\/?mark>/g, ""),
		);
		return tags;
	}

	async renameTag(oldLabel: string, newLabel: string): Promise<any> {
		// /api/tag/replaceTag 被吞；renameTag 可用。newLabel 为空 = 删除标签语义由调用方控制
		return this.call("/api/tag/renameTag", { oldLabel, newLabel });
	}

	// ---- 快照 ----

	async createSnapshot(memo: string): Promise<any> {
		return this.call("/api/repo/createSnapshot", { memo });
	}

	/** /api/repo/listSnapshots 被吞，用 getRepoSnapshots 分页 */
	async listSnapshots(page = 1): Promise<any> {
		return this.call("/api/repo/getRepoSnapshots", { page });
	}

	async rollbackToSnapshot(id: string): Promise<any> {
		return this.call("/api/repo/checkoutRepo", { id });
	}

	// ---- 内部 ----

	private esc(s: string): string {
		return s.replace(/'/g, "''");
	}

	private async call(path: string, body: unknown): Promise<any> {
		return this.callRaw(
			path,
			{ "Content-Type": "application/json" },
			JSON.stringify(body),
		);
	}

	private async callForm(path: string, body: FormData): Promise<any> {
		// FormData 由 fetch 自动生成含 boundary 的 Content-Type
		return this.callRaw(path, {}, body);
	}

	private async callRaw(
		path: string,
		extraHeaders: Record<string, string>,
		body?: BodyInit,
	): Promise<any> {
		let res: Response;
		try {
			res = await fetch(this.apiUrl + path, {
				method: "POST",
				headers: { Authorization: `Token ${this.token}`, ...extraHeaders },
				body,
				signal: AbortSignal.timeout(120000),
			});
		} catch (e: any) {
			throw new SiYuanError(`连接 SiYuan 失败 (${this.apiUrl}): ${e.message}`);
		}
		if (res.status === 401)
			throw new SiYuanError("SiYuan 认证失败：检查 token", 401);
		const text = await res.text();
		if (!text) {
			// 该部署的反代会吞掉部分端点的响应体
			throw new SiYuanError(
				`SiYuan 端点 ${path} 返回空响应（可能被反向代理吞掉）`,
			);
		}
		let json: any;
		try {
			json = JSON.parse(text);
		} catch {
			throw new SiYuanError(
				`SiYuan 端点 ${path} 返回非 JSON: ${text.slice(0, 200)}`,
			);
		}
		if (json.code !== 0)
			throw new SiYuanError(
				json.msg || `SiYuan 错误 code=${json.code}`,
				json.code,
			);
		return json.data;
	}
}
