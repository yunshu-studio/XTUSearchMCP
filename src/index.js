const MCP_PROTOCOL = "2025-03-26";
const APP_NAME = "xtu-search-mcp";
const DEFAULT_EMBED_MODEL = "@cf/baai/bge-m3";
const ALLOWED_DOMAIN_SUFFIX = ".xtu.edu.cn";
const SEARCH_TEST_TERMS = ["通知", "湘潭大学"];
const MAX_LIVE_SOURCES = 24;
const MAX_SEARCH_RESULTS = 50;
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const textEncoder = new TextEncoder();

const BUILTIN_EMPLOYMENT = {
  id: "jiuye",
  name: "湘潭大学就业信息网",
  base_url: "https://jiuye.xtu.edu.cn",
  adapter: "employment",
  search_path: "https://dc.bysjy.com.cn/search/provider_new",
  wbtreeid: null,
  search_scope: null,
  enabled: 1,
  locked: 1,
};

const TYPE_INFO = {
  "1": { name: "双选会", detail: "jobfair" },
  "2": { name: "双选会参会单位", detail: null },
  "3": { name: "宣讲会", detail: "career" },
  "4": { name: "在线招聘", detail: "online" },
  "5": { name: "职位", detail: "job" },
  "6": { name: "通知公告", detail: "news" },
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/health") return json({ ok: true, service: APP_NAME, now: new Date().toISOString() });
      if (url.pathname === "/mcp") return handleMcp(request, env, ctx);
      if (url.pathname.startsWith("/api/admin/")) return handleAdminApi(request, env, ctx);
      if (url.pathname === "/admin" || url.pathname === "/admin/") return handleAdminPage(request, env);
      if (url.pathname === "/") return Response.redirect(new URL("/admin", request.url), 302);
      return new Response("Not Found", { status: 404 });
    } catch (error) {
      console.error("request_error", error?.stack || error);
      return json({ ok: false, error: safeError(error) }, { status: 500 });
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(scheduleRefresh(env));
  },

  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        await processQueueJob(message.body, env);
        message.ack();
      } catch (error) {
        console.error("queue_job_failed", message.body, error?.stack || error);
        message.retry({ delaySeconds: 120 });
      }
    }
  },
};

async function handleAdminPage(request, env) {
  const session = await readAdminSession(request, env);
  if (!session) return html(loginPage());
  return html(adminPage(session.user));
}

async function handleAdminApi(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/api/admin/login" && request.method === "POST") {
    const payload = await readJson(request);
    const user = String(payload.username || "");
    const pass = String(payload.password || "");
    const okUser = await safeEqual(user, String(env.ADMIN_USERNAME || ""));
    const okPass = await safeEqual(pass, String(env.ADMIN_PASSWORD || ""));
    if (!okUser || !okPass || !env.SESSION_SECRET) {
      return json({ ok: false, error: "账号或密码错误" }, { status: 401 });
    }
    const token = await createSessionToken(user, env.SESSION_SECRET);
    return json({ ok: true }, {
      headers: {
        "Set-Cookie": `xtu_admin=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_SECONDS}`,
      },
    });
  }

  if (path === "/api/admin/logout" && request.method === "POST") {
    return json({ ok: true }, { headers: { "Set-Cookie": "xtu_admin=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0" } });
  }

  const session = await readAdminSession(request, env);
  if (!session) return json({ ok: false, error: "未登录" }, { status: 401 });

  if (path === "/api/admin/overview" && request.method === "GET") {
    return json({ ok: true, ...(await getOverview(env)) });
  }

  if (path === "/api/admin/sources" && request.method === "GET") {
    const sources = await listSources(env, { includeDisabled: true });
    return json({ ok: true, sources });
  }

  if (path === "/api/admin/sources/validate" && request.method === "POST") {
    const payload = await readJson(request);
    try {
      const result = await validateSource(payload.url, payload.name, env);
      return json({ ok: true, result });
    } catch (error) {
      return json({ ok: false, error: safeError(error) }, { status: 422 });
    }
  }

  if (path === "/api/admin/sources" && request.method === "POST") {
    const payload = await readJson(request);
    let validation;
    try {
      validation = await validateSource(payload.url, payload.name, env);
    } catch (error) {
      return json({ ok: false, error: safeError(error) }, { status: 422 });
    }
    const source = await createSource(env, {
      name: String(payload.name || validation.title || validation.hostname),
      base_url: validation.base_url,
      adapter: validation.adapter || "general",
      source_kind: validation.source_kind || "vsb_lucene",
      search_path: validation.search_path || null,
      search_method: validation.search_method || null,
      wbtreeid: validation.wbtreeid || null,
      search_scope: validation.search_scope ?? null,
      search_template: validation.search_template || null,
      search_params_json: JSON.stringify(validation.search_params || {}),
      native_search: validation.native_search ? 1 : 0,
      canonical_host: validation.hostname || new URL(validation.base_url).hostname,
      site_signature: validation.site_signature || null,
      enabled: payload.enabled === false ? 0 : 1,
      locked: 0,
      validation_status: "valid",
      validation_message: validation.message,
    });
    await writeAudit(env, session.user, "source.create", source.id, { base_url: source.base_url, source_kind: source.source_kind });
    if (source.enabled && source.adapter !== "employment") ctx.waitUntil(env.CRAWL_QUEUE.send({ type: "crawl_page", sourceId: source.id, url: source.base_url, depth: 0, force: true }));
    return json({ ok: true, source }, { status: 201 });
  }

  const sourceMatch = path.match(/^\/api\/admin\/sources\/([^/]+)(?:\/(validate|reindex|toggle))?$/);
  if (sourceMatch) {
    const sourceId = decodeURIComponent(sourceMatch[1]);
    const action = sourceMatch[2];
    const source = await getSource(env, sourceId);
    if (!source) return json({ ok: false, error: "数据源不存在" }, { status: 404 });

    if (!action && request.method === "DELETE") {
      if (source.locked) return json({ ok: false, error: "内置数据源不能删除" }, { status: 409 });
      const indexed = await env.DB.prepare("SELECT id,raw_key,text_key FROM articles WHERE source_id=?").bind(sourceId).all();
      const rows = indexed.results || [];
      if (rows.length && env.VECTORIZE) {
        for (let i = 0; i < rows.length; i += 500) await env.VECTORIZE.deleteByIds(rows.slice(i, i + 500).map((r) => r.id));
      }
      if (rows.length && env.BUCKET) {
        const keys = rows.flatMap((r) => [r.raw_key, r.text_key]).filter(Boolean);
        for (let i = 0; i < keys.length; i += 1000) await env.BUCKET.delete(keys.slice(i, i + 1000));
      }
      await env.DB.prepare("DELETE FROM sources WHERE id = ?").bind(sourceId).run();
      await writeAudit(env, session.user, "source.delete", sourceId, { base_url: source.base_url, removed_articles: rows.length });
      return json({ ok: true });
    }

    if (action === "toggle" && request.method === "POST") {
      const payload = await readJson(request);
      const enabled = payload.enabled ? 1 : 0;
      await env.DB.prepare("UPDATE sources SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(enabled, sourceId).run();
      await writeAudit(env, session.user, "source.toggle", sourceId, { enabled });
      return json({ ok: true, enabled: Boolean(enabled) });
    }

    if (action === "validate" && request.method === "POST") {
      if (source.adapter === "employment") return json({ ok: true, result: { adapter: "employment", source_kind: "employment", message: "就业网使用专用 API 适配器" } });
      try {
        const result = await validateSource(source.base_url, source.name, env);
        await env.DB.prepare(`UPDATE sources SET source_kind=?, search_path=?, search_method=?, wbtreeid=?, search_scope=?, search_template=?, search_params_json=?, native_search=?, canonical_host=?, site_signature=?, validation_status='valid', validation_message=?, last_validated_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
          .bind(result.source_kind, result.search_path || null, result.search_method || null, result.wbtreeid || null, result.search_scope ?? null, result.search_template || null, JSON.stringify(result.search_params || {}), result.native_search ? 1 : 0, result.hostname, result.site_signature || null, result.message, sourceId).run();
        await writeAudit(env, session.user, "source.validate", sourceId, result);
        return json({ ok: true, result });
      } catch (error) {
        await env.DB.prepare(`UPDATE sources SET validation_status='invalid', validation_message=?, last_validated_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
          .bind(safeError(error), sourceId).run();
        return json({ ok: false, error: safeError(error) }, { status: 422 });
      }
    }

    if (action === "reindex" && request.method === "POST") {
      if (source.adapter === "employment") {
        return json({ ok: false, error: "就业网目前使用实时 API，不执行站点爬取" }, { status: 409 });
      }
      await env.CRAWL_QUEUE.send({ type: "crawl_page", sourceId, url: source.base_url, depth: 0, force: true });
      await writeAudit(env, session.user, "source.reindex", sourceId, {});
      return json({ ok: true, queued: true });
    }
  }

  if (path === "/api/admin/articles" && request.method === "GET") {
    const limit = clampInt(url.searchParams.get("limit"), 1, 100, 30);
    const rows = await env.DB.prepare(`SELECT a.id,a.source_id,a.url,a.title,a.published_at,a.updated_at,a.indexed_at,s.name source_name FROM articles a JOIN sources s ON s.id=a.source_id ORDER BY a.indexed_at DESC LIMIT ?`).bind(limit).all();
    return json({ ok: true, articles: rows.results || [] });
  }

  return json({ ok: false, error: "Not Found" }, { status: 404 });
}

async function handleMcp(request, env, ctx) {
  if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
  if (request.method !== "POST") return cors(json({ error: "Method Not Allowed" }, { status: 405 }));
  if (!(await isMcpAuthorized(request, env))) return cors(json({ error: "Unauthorized" }, { status: 401 }));

  const rpc = await readJson(request);
  const id = rpc.id ?? null;
  try {
    if (rpc.method === "initialize") {
      return cors(json(rpcResult(id, {
        protocolVersion: MCP_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: APP_NAME, title: "湘潭大学统一搜索", version: "2.3.2" },
      })));
    }
    if (rpc.method === "notifications/initialized") return cors(new Response(null, { status: 202 }));
    if (rpc.method === "ping") return cors(json(rpcResult(id, {})));
    if (rpc.method === "tools/list") return cors(json(rpcResult(id, { tools: await mcpTools(env) })));
    if (rpc.method === "tools/call") {
      const name = rpc.params?.name;
      const args = rpc.params?.arguments || {};
      const result = await callMcpTool(name, args, env, ctx);
      return cors(json(rpcResult(id, result)));
    }
    return cors(json(rpcError(id, -32601, `Method not found: ${rpc.method}`)));
  } catch (error) {
    console.error("mcp_error", rpc?.method, error?.stack || error);
    return cors(json(rpcError(id, -32000, safeError(error))));
  }
}

async function mcpTools(env) {
  const currentSources = await listSources(env, { includeDisabled: false });
  const sourceLines = currentSources.map((s) => {
    let host = s.base_url;
    try { host = new URL(s.base_url).hostname; } catch {}
    return `- ${s.name} (${s.id} / ${host})`;
  }).join("\n");
  const sourceDescription = `可选，限制搜索的数据源。支持数据源 ID、中文名称或域名；省略时搜索全部启用数据源。当前可用：\n${sourceLines}`;
  return [
    {
      name: "search",
      description: "搜索湘潭大学已启用的官网数据源。支持实时关键词检索、Vectorize 语义检索和混合检索。可直接按中文单位名称限制数据源，不需要预先调用 list_sources。",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "检索问题或关键词" },
          sources: { type: "array", items: { type: "string" }, description: sourceDescription },
          mode: { type: "string", enum: ["hybrid", "live", "semantic"], default: "hybrid" },
          limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: "get_article",
      description: "读取湘潭大学官网文章正文。优先返回已索引内容，未命中时实时抓取并后台写入索引。",
      inputSchema: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
        additionalProperties: false,
      },
    },
    {
      name: "list_sources",
      description: "列出当前启用的湘潭大学搜索数据源。通常无需在 search 前调用；仅在需要查看完整数据源清单时使用。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
  ];
}

async function callMcpTool(name, args, env, ctx) {
  if (name === "list_sources") {
    const sources = await listSources(env, { includeDisabled: false });
    return textResult(JSON.stringify(sources.map(publicSource), null, 2));
  }
  if (name === "search") {
    const query = String(args.query || "").trim();
    if (!query) return textResult("query 不能为空", true);
    const limit = clampInt(args.limit, 1, MAX_SEARCH_RESULTS, 20);
    const mode = ["hybrid", "live", "semantic"].includes(args.mode) ? args.mode : "hybrid";
    const sourceIds = Array.isArray(args.sources) ? args.sources.map(String) : [];
    const result = await unifiedSearch(query, sourceIds, mode, limit, env, ctx);
    return textResult(JSON.stringify(result, null, 2));
  }
  if (name === "get_article") {
    const input = String(args.url || "").trim();
    if (!input) return textResult("url 不能为空", true);
    const result = await getArticleForMcp(input, env, ctx);
    return textResult(JSON.stringify(result, null, 2));
  }
  return textResult(`未知工具: ${name}`, true);
}

async function unifiedSearch(query, requestedSourceIds, mode, limit, env, ctx) {
  const allSources = await listSources(env, { includeDisabled: false });
  let sources = resolveRequestedSources(requestedSourceIds, allSources);
  sources = sources.slice(0, MAX_LIVE_SOURCES);
  const resolvedSourceIds = sources.map((s) => s.id);

  const liveErrors = [];
  const liveBySource = new Map();
  if (mode !== "semantic") {
    const tasks = sources.map(async (source) => {
      try {
        const kind = sourceKind(source);
        const result = kind === "employment"
          ? await searchEmployment(query, 1, Math.min(limit, 20), "")
          : kind === "business_jsp"
            ? await liveSearchBusiness(source, query, 1)
            : kind === "crawl"
              ? await searchCrawlIndex(source, query, Math.min(limit * 3, 50), env)
              : await liveSearchVsb(source, query, 1);
        const ranked = rankLiveItems(query, result.items || []);
        liveBySource.set(source.id, ranked.map((item) => ({
          ...item,
          source_id: source.id,
          source_name: source.name,
          score: null,
          origin: "live",
        })));
      } catch (error) {
        liveBySource.set(source.id, []);
        liveErrors.push({ source_id: source.id, source_name: source.name, error: safeError(error) });
      }
    });
    await Promise.all(tasks);
  }
  const liveResults = roundRobinResults(sources, liveBySource, Math.min(Math.max(limit * 3, 30), 120));

  const semanticResults = [];
  const enabledSourceIds = new Set(sources.map((s) => s.id));
  if (mode !== "live" && env.AI && env.VECTORIZE) {
    try {
      const embedding = await createEmbedding(query, env);
      const filter = resolvedSourceIds.length === 1 ? { source_id: resolvedSourceIds[0] } : undefined;
      const matches = await env.VECTORIZE.query(embedding, { topK: Math.min(limit * 2, 50), returnMetadata: "all", filter });
      for (const match of matches.matches || []) {
        const md = match.metadata || {};
        if (!enabledSourceIds.has(String(md.source_id || ""))) continue;
        if (resolvedSourceIds.length && !resolvedSourceIds.includes(String(md.source_id || ""))) continue;
        semanticResults.push({
          title: md.title || "",
          url: md.url || "",
          date: md.published_at || "",
          snippet: md.snippet || "",
          source_id: md.source_id || "",
          source_name: md.source_name || "",
          score: match.score,
          origin: "semantic",
        });
      }
    } catch (error) {
      console.warn("semantic_search_failed", safeError(error));
    }
  }

  const merged = new Map();
  for (const item of semanticResults) {
    if (!item.url) continue;
    merged.set(normalizeUrl(item.url), { ...item });
  }
  for (const item of liveResults) {
    if (!item.url) continue;
    const key = normalizeUrl(item.url);
    const existing = merged.get(key);
    if (existing) merged.set(key, { ...existing, ...item, score: existing.score, origin: "hybrid" });
    else merged.set(key, item);
  }

  const items = [...merged.values()]
    .sort((a, b) => ((b.origin === "hybrid") - (a.origin === "hybrid")) || ((b.score || 0) - (a.score || 0)))
    .slice(0, limit);

  const toIndex = liveResults.filter((x) => x.url && x.source_id && !x.url.includes("bysjy.com.cn")).slice(0, 20);
  if (toIndex.length) {
    ctx.waitUntil(Promise.allSettled(toIndex.map((item) => env.CRAWL_QUEUE.send({ type: "index_url", sourceId: item.source_id, url: item.url, force: false }))));
  }

  return {
    query,
    mode,
    searched_sources: sources.map((s) => ({ id: s.id, name: s.name })),
    count: items.length,
    items,
    live_errors: liveErrors,
  };
}

function resolveRequestedSources(requested, available) {
  if (!requested?.length) return available;
  const picked = [];
  const unresolved = [];
  for (const raw of requested) {
    const q = normalizeSourceSelector(raw);
    if (!q) continue;
    const exact = available.filter((s) => sourceSelectorKeys(s).some((k) => k === q));
    let matches = exact;
    if (!matches.length) {
      matches = available.filter((s) => sourceSelectorKeys(s).some((k) => k.includes(q) || q.includes(k)));
    }
    if (!matches.length && q.length >= 3) {
      matches = available.filter((s) => isSubsequence(q, normalizeSourceSelector(s.name)));
    }
    const unique = [...new Map(matches.map((s) => [s.id, s])).values()];
    if (unique.length === 1) picked.push(unique[0]);
    else if (unique.length > 1) {
      throw new Error(`数据源“${raw}”匹配到多个站点：${unique.map((s) => `${s.name}(${s.id})`).join('、')}，请使用更精确的名称、ID 或域名。`);
    } else unresolved.push(raw);
  }
  if (unresolved.length) {
    throw new Error(`未识别数据源：${unresolved.join('、')}。可用数据源：${available.map((s) => `${s.name}(${s.id})`).join('、')}`);
  }
  return [...new Map(picked.map((s) => [s.id, s])).values()];
}

function normalizeSourceSelector(value) {
  let s = String(value || '').trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return s.replace(/\s+/g, '');
}

function sourceSelectorKeys(source) {
  let host = '';
  try { host = new URL(source.base_url).hostname; } catch {}
  const name = normalizeSourceSelector(source.name);
  const shortName = name.replace(/^湘潭大学/, '');
  return [source.id, source.base_url, host, name, shortName].map(normalizeSourceSelector).filter(Boolean);
}

function isSubsequence(needle, haystack) {
  let i = 0;
  for (const ch of haystack) if (ch === needle[i]) i++;
  return i === needle.length;
}

function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/<[^>]+>/g, " ")
    .replace(/[\s\u3000\-—_·•,，。.!！?？:：;；()（）\[\]【】"'“”‘’/\\]+/g, "");
}

function liveQueryTerms(query) {
  const raw = String(query || "").trim().toLowerCase();
  const compact = normalizeSearchText(raw);
  const parts = raw
    .split(/[\s,，。.!！?？:：;；()（）\[\]【】"'“”‘’/\\]+/)
    .map(normalizeSearchText)
    .filter((x) => x.length >= 2);
  const out = new Set(parts);
  if (compact.length >= 2) out.add(compact);
  return [...out].sort((a, b) => b.length - a.length);
}

function scoreLiveItem(query, item) {
  const q = normalizeSearchText(query);
  const title = normalizeSearchText(item?.title || "");
  const snippet = normalizeSearchText(item?.snippet || "");
  const body = title + snippet;
  let score = 0;
  if (q && title.includes(q)) score += 100;
  else if (q && body.includes(q)) score += 60;
  for (const term of liveQueryTerms(query)) {
    if (!term || term === q) continue;
    if (title.includes(term)) score += Math.min(24, 8 + term.length * 3);
    else if (snippet.includes(term)) score += Math.min(12, 3 + term.length * 2);
  }
  if (item?.date) score += 1;
  return score;
}

function rankLiveItems(query, items) {
  const compact = normalizeSearchText(query);
  const strictKeyword = compact.length >= 2 && compact.length <= 8;
  return (items || [])
    .map((item, index) => ({ item, index, relevance: scoreLiveItem(query, item) }))
    .filter((x) => !strictKeyword || x.relevance > 0)
    .sort((a, b) => (b.relevance - a.relevance) || (a.index - b.index))
    .map((x) => x.item);
}

function roundRobinResults(sources, bySource, maxItems) {
  const buckets = sources.map((s) => bySource.get(s.id) || []);
  const out = [];
  for (let row = 0; out.length < maxItems; row++) {
    let added = false;
    for (const bucket of buckets) {
      if (row < bucket.length) {
        out.push(bucket[row]);
        added = true;
        if (out.length >= maxItems) break;
      }
    }
    if (!added) break;
  }
  return out;
}

async function getArticleForMcp(input, env, ctx) {
  const url = new URL(input);
  assertAllowedUniversityHost(url.hostname);
  const normalized = normalizeUrl(url.href);
  const row = await env.DB.prepare(`SELECT a.*,s.name source_name FROM articles a JOIN sources s ON s.id=a.source_id WHERE a.url=? LIMIT 1`).bind(normalized).first();
  if (row) {
    const obj = await env.BUCKET.get(row.text_key);
    if (obj) {
      return {
        title: row.title,
        url: row.url,
        source_id: row.source_id,
        source_name: row.source_name,
        published_at: row.published_at,
        indexed_at: row.indexed_at,
        attachments: safeJsonParse(row.attachments_json, []),
        text: await obj.text(),
        cached: true,
      };
    }
  }

  const source = await findSourceByHost(env, url.hostname);
  if (!source) throw new Error("该域名尚未在 WebUI 中启用");
  const fetched = await fetchArticle(url.href, source);
  ctx.waitUntil(indexFetchedArticle(source, fetched, env));
  return { ...fetched, source_id: source.id, source_name: source.name, cached: false };
}

async function scheduleRefresh(env) {
  const sources = await listSources(env, { includeDisabled: false });
  for (const source of sources) {
    if (source.adapter !== "general") continue;
    await env.CRAWL_QUEUE.send({ type: "crawl_page", sourceId: source.id, url: source.base_url, depth: 0, force: false });
  }
}

async function processQueueJob(job, env) {
  if (!job || typeof job !== "object") throw new Error("invalid queue job");
  if (job.type === "index_url") {
    const source = await getSource(env, String(job.sourceId || ""));
    if (!source || !source.enabled || source.adapter !== "general") return;
    await indexUrl(source, String(job.url || ""), env, Boolean(job.force));
    return;
  }
  if (job.type === "crawl_page") {
    const source = await getSource(env, String(job.sourceId || ""));
    if (!source || !source.enabled || source.adapter !== "general") return;
    await crawlPage(source, String(job.url || source.base_url), clampInt(job.depth, 0, 3, 0), env, Boolean(job.force));
    return;
  }
  throw new Error(`unknown queue job: ${job.type}`);
}

async function crawlPage(source, pageUrl, depth, env, force) {
  const normalized = normalizeUrl(pageUrl);
  const u = new URL(normalized);
  if (u.hostname !== new URL(source.base_url).hostname) return;
  if (!isCrawlablePath(u.pathname)) return;

  const seenId = await sha256Hex(`${source.id}\n${normalized}`);
  const seen = await env.DB.prepare("SELECT last_crawled_at FROM crawl_seen WHERE id=?").bind(seenId).first();
  if (!force && seen?.last_crawled_at && Date.now() - Date.parse(seen.last_crawled_at) < 6 * 60 * 60 * 1000) return;

  const res = await fetchWithTimeout(normalized, {
    headers: { "User-Agent": crawlerUa(source), Accept: "text/html,application/xhtml+xml" },
  }, 12000);
  if (!res.ok) throw new Error(`crawl HTTP ${res.status}`);
  const htmlText = await decodeHtmlResponse(res);

  await env.DB.prepare(`INSERT INTO crawl_seen(id,source_id,url,last_crawled_at) VALUES(?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET last_crawled_at=CURRENT_TIMESTAMP`)
    .bind(seenId, source.id, normalized).run();

  const extracted = extractArticleFromHtml(htmlText, normalized);
  if (extracted.text.length >= 300 && (looksLikeArticlePath(u.pathname) || extracted.hasMainContainer)) {
    await indexFetchedArticle(source, { ...extracted, url: normalized, raw_html: htmlText }, env);
  }

  if (depth >= 2) return;
  const links = extractInternalLinks(htmlText, normalized, u.hostname).slice(0, depth === 0 ? 80 : 60);
  const jobs = links.map((link) => ({ body: { type: "crawl_page", sourceId: source.id, url: link, depth: depth + 1, force: false } }));
  for (let i = 0; i < jobs.length; i += 100) {
    await env.CRAWL_QUEUE.sendBatch(jobs.slice(i, i + 100));
  }
}

async function indexUrl(source, url, env, force) {
  const normalized = normalizeUrl(url);
  const existing = await env.DB.prepare("SELECT indexed_at FROM articles WHERE url=?").bind(normalized).first();
  if (!force && existing?.indexed_at && Date.now() - Date.parse(existing.indexed_at) < 24 * 60 * 60 * 1000) return;
  const fetched = await fetchArticle(normalized, source);
  await indexFetchedArticle(source, fetched, env);
}

async function indexFetchedArticle(source, article, env) {
  const normalized = normalizeUrl(article.url);
  const id = await sha256Hex(normalized);
  const title = String(article.title || normalized).slice(0, 500);
  const text = String(article.text || "").trim().slice(0, 120000);
  if (text.length < 100) return;
  const rawKey = `raw/${source.id}/${id}.html`;
  const textKey = `text/${source.id}/${id}.txt`;
  if (article.raw_html) await env.BUCKET.put(rawKey, article.raw_html, { httpMetadata: { contentType: "text/html; charset=utf-8" } });
  await env.BUCKET.put(textKey, text, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });

  const searchText = compactText(text).slice(0, 12000);
  await env.DB.prepare(`INSERT INTO articles(id,source_id,url,title,published_at,content_hash,raw_key,text_key,attachments_json,search_text,indexed_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
    ON CONFLICT(url) DO UPDATE SET source_id=excluded.source_id,title=excluded.title,published_at=excluded.published_at,content_hash=excluded.content_hash,raw_key=excluded.raw_key,text_key=excluded.text_key,attachments_json=excluded.attachments_json,search_text=excluded.search_text,indexed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP`)
    .bind(id, source.id, normalized, title, article.date || article.published_at || null, await sha256Hex(text), article.raw_html ? rawKey : null, textKey, JSON.stringify(article.attachments || []), searchText).run();

  if (env.AI && env.VECTORIZE) {
    const contentForEmbedding = `${title}\n\n${text.slice(0, 12000)}`;
    const vector = await createEmbedding(contentForEmbedding, env);
    await env.VECTORIZE.upsert([{
      id,
      values: vector,
      metadata: {
        source_id: source.id,
        source_name: source.name,
        title: title.slice(0, 300),
        url: normalized,
        published_at: String(article.date || article.published_at || "").slice(0, 40),
        snippet: compactText(text).slice(0, 600),
      },
    }]);
  }
}

async function createEmbedding(text, env) {
  const model = env.EMBED_MODEL || DEFAULT_EMBED_MODEL;
  const resp = await env.AI.run(model, { text: [String(text).slice(0, 16000)] });
  if (!resp?.data?.[0]) throw new Error("Workers AI 未返回 embedding");
  return resp.data[0];
}

async function validateSource(inputUrl, name = "", env = null) {
  const started = Date.now();
  const base = normalizeBaseUrl(inputUrl);
  const u = new URL(base);
  assertAllowedUniversityHost(u.hostname);

  const homeRes = await fetchWithTimeout(base, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; XTU-Search-Validator/2.3.2)", Accept: "text/html,application/xhtml+xml" },
  }, 10000);
  if (!homeRes.ok) throw new Error(`首页访问失败 HTTP ${homeRes.status}`);
  const home = await decodeHtmlResponse(homeRes);
  const title = stripHtml((home.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ""])[1]).slice(0, 200);
  const siteSignature = await sha256Hex(normalizeSiteSignatureInput(home));

  if (u.hostname === "jiuye.xtu.edu.cn") {
    return {
      adapter: "employment",
      source_kind: "employment",
      hostname: u.hostname,
      title,
      base_url: base,
      search_path: "https://dc.bysjy.com.cn/search/provider_new",
      search_method: "GET",
      search_template: "bysjy_api",
      search_params: {},
      native_search: true,
      site_signature: siteSignature,
      latency_ms: Date.now() - started,
      message: "识别为就业信息网专用 API",
    };
  }

  const business = detectBusinessSearch(home, base);
  if (business) {
    const source = {
      id: "validation",
      name: name || title || u.hostname,
      base_url: base,
      adapter: "general",
      source_kind: "business_jsp",
      search_path: business.search_path,
      search_method: "GET",
      search_params_json: JSON.stringify(business.search_params),
    };
    let best = null;
    let lastError = "自定义 JSP 搜索未返回有效结果";
    for (const term of SEARCH_TEST_TERMS) {
      try {
        const result = await liveSearchBusiness(source, term, 1, { validation: true });
        const relevant = rankLiveItems(term, result.items || []);
        const quality = relevant.slice(0, 10).reduce((sum, item) => sum + scoreLiveItem(term, item), 0) + relevant.length * 10;
        if (relevant.length && (!best || quality > best.quality)) best = { term, result, relevant, quality };
        else if (!result.items?.length) lastError = `自定义 JSP 搜索返回 0 条可解析结果（query=${term}）`;
        else lastError = `自定义 JSP 返回 ${result.items.length} 条，但没有与“${term}”相关的结果`;
      } catch (error) { lastError = safeError(error); }
    }
    if (best) {
      return {
        adapter: "general",
        source_kind: "business_jsp",
        hostname: u.hostname,
        title,
        base_url: base,
        search_path: business.search_path,
        search_method: "GET",
        wbtreeid: null,
        search_scope: null,
        search_template: "business_searchlist",
        search_params: business.search_params,
        native_search: true,
        site_signature: siteSignature,
        test_query: best.term,
        test_result_count: best.relevant.length,
        validation_score: best.quality,
        latency_ms: Date.now() - started,
        message: `识别为自定义 JSP 搜索：${business.search_path}`,
      };
    }

    // This signature is specific enough to identify the Business School
    // search protocol from the homepage itself. Do not block source creation
    // merely because the origin returned malformed/empty HTML to a validation
    // probe; live search will keep using the tolerant parser above.
    return {
      adapter: "general",
      source_kind: "business_jsp",
      hostname: u.hostname,
      title,
      base_url: base,
      search_path: business.search_path,
      search_method: "GET",
      wbtreeid: null,
      search_scope: null,
      search_template: "business_searchlist",
      search_params: business.search_params,
      native_search: true,
      site_signature: siteSignature,
      test_query: null,
      test_result_count: 0,
      validation_score: 0,
      validation_warning: lastError,
      latency_ms: Date.now() - started,
      message: `识别为自定义 JSP 搜索：${business.search_path}；验证查询未稳定解析，已按协议识别结果允许添加`,
    };
  }

  const forms = discoverVsbSearchForms(home, base);
  let best = null;
  let lastError = forms.length ? "VSB 搜索表单未返回有效结果" : "首页未发现 VSB Lucene 搜索表单";
  for (const candidate of forms.slice(0, 8)) {
    for (const term of SEARCH_TEST_TERMS) {
      try {
        const source = {
          id: "validation",
          name: name || title || u.hostname,
          base_url: base,
          adapter: "general",
          source_kind: "vsb_lucene",
          search_path: candidate.search_path,
          search_method: candidate.search_method,
          wbtreeid: candidate.wbtreeid,
          search_scope: candidate.search_scope,
          search_params_json: JSON.stringify(candidate.search_params),
        };
        const result = await liveSearchVsb(source, term, 1, { validation: true });
        const relevant = rankLiveItems(term, result.items || []);
        const quality = relevant.slice(0, 10).reduce((sum, item) => sum + scoreLiveItem(term, item), 0)
          + Math.min(relevant.length, 10) * 15 + (result.total !== null ? 5 : 0);
        if (relevant.length && (!best || quality > best.quality)) {
          best = { candidate, term, result, relevant, quality };
        }
      } catch (error) { lastError = safeError(error); }
    }
  }

  if (best) {
    const { candidate, term, result, relevant, quality } = best;
    return {
      adapter: "general",
      source_kind: "vsb_lucene",
      hostname: u.hostname,
      title,
      base_url: base,
      search_path: candidate.search_path,
      search_method: candidate.search_method,
      wbtreeid: candidate.wbtreeid || null,
      search_scope: candidate.search_scope ?? null,
      search_template: result.search_template || "generic_info",
      search_params: candidate.search_params,
      native_search: true,
      site_signature: siteSignature,
      test_query: term,
      test_result_count: relevant.length,
      validation_score: quality,
      latency_ms: Date.now() - started,
      message: `识别为 VSB/Lucene：${candidate.search_path}${candidate.wbtreeid ? `?wbtreeid=${candidate.wbtreeid}` : ""} · ${result.search_template || "generic"}`,
    };
  }

  const crawlProbe = await probeCrawlSource(base, home);
  if (crawlProbe.article_count > 0) {
    return {
      adapter: "general",
      source_kind: "crawl",
      hostname: u.hostname,
      title,
      base_url: base,
      search_path: null,
      search_method: null,
      wbtreeid: null,
      search_scope: null,
      search_template: "crawl_index",
      search_params: {},
      native_search: false,
      site_signature: siteSignature,
      crawl_probe: crawlProbe,
      latency_ms: Date.now() - started,
      message: `未发现兼容的原生搜索接口，已切换 Crawl：探测到 ${crawlProbe.article_count} 个文章链接`,
    };
  }

  throw new Error(`站点可访问，但未发现可用原生搜索或可抓取文章：${lastError}`);
}

function normalizeSiteSignatureInput(htmlText) {
  return String(htmlText || "")
    .replace(/\s+/g, " ")
    .replace(/(?:19|20)\d{2}[-/.]\d{1,2}[-/.]\d{1,2}/g, "<date>")
    .trim()
    .slice(0, 200000);
}

function parseHtmlAttributes(tag) {
  const attrs = {};
  const re = /([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(tag))) {
    const key = String(m[1] || "").toLowerCase();
    if (!key || key === "form" || key === "input") continue;
    attrs[key] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

function parseForms(htmlText, base) {
  const forms = [];
  const re = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let m;
  while ((m = re.exec(htmlText))) {
    const attrs = parseHtmlAttributes(m[1]);
    let action;
    try { action = new URL(attrs.action || base, base); } catch { continue; }
    const inputs = [];
    const inputRe = /<input\b([^>]*)>/gi;
    let im;
    while ((im = inputRe.exec(m[2]))) {
      const ia = parseHtmlAttributes(im[1]);
      if (!ia.name) continue;
      inputs.push({ name: ia.name, value: ia.value || "", type: (ia.type || "text").toLowerCase() });
    }
    forms.push({ action, method: String(attrs.method || "GET").toUpperCase(), inputs, html: m[0] });
  }
  return forms;
}

function discoverVsbSearchForms(htmlText, base) {
  const baseHost = new URL(base).hostname;
  const out = [];
  for (const form of parseForms(htmlText, base)) {
    if (form.action.hostname !== baseHost) continue;
    const names = new Set(form.inputs.map((x) => x.name));
    if (!names.has("lucenenewssearchkey") || !names.has("_lucenesearchtype")) continue;
    const params = {};
    for (const input of form.inputs) {
      if (!input.name || input.name === "lucenenewssearchkey" || input.name === "showkeycode") continue;
      params[input.name] = input.value;
    }
    const tree = form.action.searchParams.get("wbtreeid") || params.wbtreeid || null;
    const scope = params.searchScope ?? form.action.searchParams.get("searchScope") ?? "0";
    out.push({
      search_path: form.action.pathname,
      search_method: form.method || "POST",
      wbtreeid: tree,
      search_scope: String(scope),
      search_params: params,
    });
  }
  return dedupeVsbForms(out);
}

function dedupeVsbForms(items) {
  const seen = new Set();
  return items.filter((x) => {
    const key = `${x.search_method}|${x.search_path}|${x.wbtreeid || ""}|${x.search_scope || ""}|${JSON.stringify(x.search_params || {})}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function detectBusinessSearch(htmlText, base) {
  for (const form of parseForms(htmlText, base)) {
    const names = new Set(form.inputs.map((x) => x.name));
    if (!names.has("searchword")) continue;
    const cc = form.action.searchParams.get("cc");
    const cd = form.action.searchParams.get("cd");
    if (cc === "cindex" && cd === "search") {
      return { search_path: form.action.pathname, search_params: { cc: "cindex", cd: "search" } };
    }
  }
  return null;
}

async function probeCrawlSource(base, homeHtml) {
  const host = new URL(base).hostname;
  const direct = extractInternalLinks(homeHtml, `${base}/`, host);
  const articleSet = new Set(direct.filter((x) => looksLikeArticlePath(new URL(x).pathname)));
  const probed = [];
  if (articleSet.size < 3) {
    const sections = direct.filter((x) => !looksLikeArticlePath(new URL(x).pathname)).slice(0, 6);
    for (const link of sections) {
      try {
        const res = await fetchWithTimeout(link, { headers: { "User-Agent": "Mozilla/5.0 (compatible; XTU-Search-Validator/2.3.2)", Accept: "text/html,application/xhtml+xml" } }, 6000);
        if (!res.ok) continue;
        const html = await decodeHtmlResponse(res);
        probed.push(link);
        for (const item of extractInternalLinks(html, link, host)) {
          if (looksLikeArticlePath(new URL(item).pathname)) articleSet.add(item);
        }
        if (articleSet.size >= 8) break;
      } catch {}
    }
  }
  return { article_count: articleSet.size, sample_articles: [...articleSet].slice(0, 8), probed_sections: probed };
}

function sourceKind(source) {
  if (source?.adapter === "employment") return "employment";
  return String(source?.source_kind || "vsb_lucene");
}

async function liveSearchVsb(source, query, page = 1, opts = {}) {
  const encoded = utf8Base64(query);
  const base = source.base_url.replace(/\/$/, "");
  const searchPath = source.search_path || "/search.jsp";
  const tree = source.wbtreeid ? String(source.wbtreeid) : "";
  const scope = source.search_scope != null ? String(source.search_scope) : "0";
  const saved = safeJsonParse(source.search_params_json || "{}", {});
  const params = { ...saved };
  params.lucenenewssearchkey = encoded;
  params._lucenesearchtype = params._lucenesearchtype || "1";
  params.searchScope = scope;
  delete params.wbtreeid;
  delete params.showkeycode;

  const parseResponse = async (res, sourceUrl) => {
    if (!res.ok) throw new Error(`搜索失败 HTTP ${res.status}`);
    const htmlText = await decodeHtmlResponse(res);
    const template = detectVsbTemplate(htmlText);
    const items = parseVsbSearchResults(htmlText, base, source, template);
    const meta = parsePagination(htmlText);
    return {
      query,
      page,
      source: sourceUrl,
      count: items.length,
      total: meta.total,
      total_pages: meta.totalPages,
      current_page: meta.currentPage || page,
      items,
      search_template: template,
    };
  };

  const makeGetTarget = (pageNo) => {
    const target = new URL(searchPath, `${base}/`);
    if (tree) target.searchParams.set("wbtreeid", tree);
    target.searchParams.set("searchScope", scope);
    target.searchParams.set("currentnum", String(pageNo));
    target.searchParams.set("newskeycode2", encoded);
    target.searchParams.set("order", "");
    target.searchParams.set("range", "");
    return target;
  };

  if (page > 1) {
    const target = makeGetTarget(page);
    const res = await fetchWithTimeout(target.href, {
      headers: { "User-Agent": crawlerUa(source), Accept: "text/html,application/xhtml+xml", Referer: `${base}/` },
    }, 12000);
    return parseResponse(res, target.href);
  }

  const target = new URL(searchPath, `${base}/`);
  if (tree) target.searchParams.set("wbtreeid", tree);
  let primary;
  const method = String(source.search_method || "POST").toUpperCase();
  if (method === "GET") {
    for (const [k, v] of Object.entries(params)) target.searchParams.set(k, String(v ?? ""));
    const res = await fetchWithTimeout(target.href, {
      headers: { "User-Agent": crawlerUa(source), Accept: "text/html,application/xhtml+xml", Referer: `${base}/` },
    }, opts.validation ? 8000 : 12000);
    primary = await parseResponse(res, target.href);
  } else {
    const res = await fetchWithTimeout(target.href, {
      method: "POST",
      headers: { "User-Agent": crawlerUa(source), Accept: "text/html,application/xhtml+xml", "Content-Type": "application/x-www-form-urlencoded", Origin: base, Referer: `${base}/` },
      body: new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v ?? "")])),
    }, opts.validation ? 8000 : 12000);
    primary = await parseResponse(res, target.href);
  }

  // A few newer VSB templates (notably v26_list_search.jsp) expose the usual
  // POST form on the homepage but only return stable result markup through the
  // newskeycode2/currentnum GET route. During validation, or whenever the POST
  // result has no relevant hit, retry that canonical GET route and keep the
  // better result. This avoids misclassifying a valid VSB site as Crawl.
  const primaryRelevant = rankLiveItems(query, primary.items || []);
  if (!primary.items.length || (opts.validation && !primaryRelevant.length)) {
    try {
      const fallbackTarget = makeGetTarget(1);
      const fallbackRes = await fetchWithTimeout(fallbackTarget.href, {
        headers: { "User-Agent": crawlerUa(source), Accept: "text/html,application/xhtml+xml", Referer: `${base}/` },
      }, opts.validation ? 8000 : 12000);
      const fallback = await parseResponse(fallbackRes, fallbackTarget.href);
      const fallbackRelevant = rankLiveItems(query, fallback.items || []);
      if (fallbackRelevant.length > primaryRelevant.length || fallback.items.length > primary.items.length) return fallback;
    } catch {}
  }

  return primary;
}

function detectVsbTemplate(htmlText) {
  if (/class=["'][^"']*list_ul_box/i.test(htmlText)) return "v24_list_ul_box";
  // v26 pages wrap the real hits in <ul class="research-list">.  Matching
  // the outer result-list div with a non-greedy regex truncates at the first
  // nested </div>, so identify this template by its actual result container.
  if (/class=["'][^"']*research-list/i.test(htmlText)) return "v26_result_list";
  if (/class=["'][^"']*(?:list_box|list_main)/i.test(htmlText)) return "ssjgy_list_box";
  if (/class=["'][^"']*listg\d+/i.test(htmlText)) return "listg2412";
  if (/class=["'][^"']*listFrame/i.test(htmlText)) return "listFrame";
  return "generic_info";
}

function parseVsbSearchResults(htmlText, base, source, template) {
  if (template === "listg2412") return parseVsbListG(htmlText, base, source);
  if (template === "v24_list_ul_box") return parseVsbV24(htmlText, base, source);
  if (template === "v26_result_list") return parseVsbV26(htmlText, base, source);
  if (template === "ssjgy_list_box") return parseVsbSsjgy(htmlText, base, source);
  if (template === "listFrame") return parseVsbListFrame(htmlText, base, source);
  return parseVsbGeneric(htmlText, base, source);
}

function parseVsbListG(htmlText, base, source) { return parseVsbGeneric(htmlText, base, source, /<ul[^>]*class=["'][^"']*listg\d+[^"']*["'][^>]*>([\s\S]*?)<\/ul>/gi); }
function parseVsbV24(htmlText, base, source) { return parseVsbGeneric(htmlText, base, source, /<(?:div|ul)[^>]*class=["'][^"']*list_ul_box[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|ul)>/gi); }
function parseVsbV26(htmlText, base, source) {
  // The result-list div contains many nested divs. Parse the flat UL instead;
  // otherwise the previous regex stopped at the first list-item </div> and
  // validation saw unrelated/empty content, causing an incorrect Crawl fallback.
  return parseVsbGeneric(htmlText, base, source, /<ul[^>]*class=["'][^"']*research-list[^"']*["'][^>]*>([\s\S]*?)<\/ul>/gi);
}
function parseVsbSsjgy(htmlText, base, source) { return parseVsbGeneric(htmlText, base, source, /<(?:div|ul)[^>]*class=["'][^"']*(?:list_box|list_main)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|ul)>/gi); }
function parseVsbListFrame(htmlText, base, source) { return parseVsbGeneric(htmlText, base, source, /<(?:table|div|ul)[^>]*class=["'][^"']*listFrame[^"']*["'][^>]*>([\s\S]*?)<\/(?:table|div|ul)>/gi); }

function parseVsbGeneric(htmlText, base, source, regionRe = null) {
  const regions = [];
  if (regionRe) {
    let rm;
    while ((rm = regionRe.exec(htmlText))) regions.push(rm[1] || rm[0]);
  }
  const chunks = regions.length ? regions : [htmlText];
  const items = [];
  const seen = new Set();
  const baseHost = new URL(base).hostname;
  const isMain = source?.id === "main" || /qwssjg/i.test(String(source?.search_path || ""));

  for (const chunk of chunks) {
    const liRe = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
    let li;
    while ((li = liRe.exec(chunk))) {
      const block = li[1];
      const hrefM = block.match(/<a[^>]+href=["']([^"']+)["'][^>]*>/i);
      if (!hrefM) continue;
      let abs;
      try { abs = new URL(decodeEntities(hrefM[1]).trim(), `${base}/`).href; } catch { continue; }
      const uu = new URL(abs);
      if (isMain) {
        if (!(uu.hostname === "xtu.edu.cn" || uu.hostname.endsWith(".xtu.edu.cn"))) continue;
      } else {
        if (uu.hostname !== baseHost || !/\/info\/\d+\/\d+\.htm$/i.test(uu.pathname)) continue;
      }
      const key = normalizeUrl(abs);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(vsbItemFromBlock(block, key));
      if (items.length >= 60) return items.filter((x) => x.title);
    }
  }

  if (!items.length) {
    const aRe = /<a[^>]+href=["']([^"']*\/info\/\d+\/\d+\.htm)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = aRe.exec(htmlText))) {
      let abs;
      try { abs = new URL(decodeEntities(m[1]), `${base}/`).href; } catch { continue; }
      if (new URL(abs).hostname !== baseHost) continue;
      const key = normalizeUrl(abs);
      if (seen.has(key)) continue;
      seen.add(key);
      const context = htmlText.slice(Math.max(0, m.index - 220), Math.min(htmlText.length, aRe.lastIndex + 520));
      const title = stripHtml(m[2]).slice(0, 260);
      const dateM = context.match(/(20\d{2}[-年\/.]\d{1,2}[-月\/.]\d{1,2}(?:日)?)/);
      items.push({ title, date: dateM ? normalizeDate(dateM[1]) : "", snippet: compactText(stripHtml(context)).slice(0, 500), url: key });
      if (items.length >= 60) break;
    }
  }
  return items.filter((x) => x.title);
}

function vsbItemFromBlock(block, url) {
  const titleM = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i) || block.match(/<a[^>]*>([\s\S]*?)<\/a>/i);
  const dateM = block.match(/<(?:span|i|div)[^>]*class=["'][^"']*(?:date|date-list)[^"']*["'][^>]*>([\s\S]*?)<\/(?:span|i|div)>/i)
    || block.match(/(20\d{2}[-年\/.]\d{1,2}[-月\/.]\d{1,2}(?:日)?)/);
  const pM = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  const title = stripHtml(titleM ? titleM[1] : "").slice(0, 260);
  const snippet = compactText(stripHtml(pM ? pM[1] : block)).replace(title, "").slice(0, 500);
  return { title, date: dateM ? normalizeDate(stripHtml(dateM[1])) : "", snippet, url };
}

async function liveSearchBusiness(source, query, page = 1, opts = {}) {
  const base = source.base_url.replace(/\/$/, "");
  const params = safeJsonParse(source.search_params_json || "{}", {});
  const makeTarget = () => {
    const target = new URL(source.search_path || "/index.jsp", `${base}/`);
    target.searchParams.set("cc", params.cc || "cindex");
    target.searchParams.set("cd", params.cd || "search");
    target.searchParams.set("searchword", query);
    if (page > 1) target.searchParams.set("pg", String(page));
    return target;
  };

  const parseResponse = async (res, sourceUrl) => {
    if (!res.ok) throw new Error(`自定义 JSP 搜索失败 HTTP ${res.status}`);
    const htmlText = await decodeHtmlResponse(res);
    const items = parseBusinessSearchResults(htmlText, base);
    return { query, page, source: sourceUrl, count: items.length, total: null, items, search_template: "business_searchlist" };
  };

  const target = makeTarget();
  let result;
  const getRes = await fetchWithTimeout(target.href, {
    headers: { "User-Agent": crawlerUa(source), Accept: "text/html,application/xhtml+xml", Referer: `${base}/` },
  }, opts.validation ? 10000 : 12000);
  result = await parseResponse(getRes, target.href);

  // The current Business School page navigates with GET in JavaScript, but the
  // form itself declares method=POST. Keep a POST retry for origin-side changes
  // or proxies that ignore the query string on the first request.
  if (!result.items.length || (opts.validation && !rankLiveItems(query, result.items).length)) {
    try {
      const postTarget = new URL(source.search_path || "/index.jsp", `${base}/`);
      postTarget.searchParams.set("cc", params.cc || "cindex");
      postTarget.searchParams.set("cd", params.cd || "search");
      const body = new URLSearchParams({ searchword: query });
      if (page > 1) body.set("pg", String(page));
      const postRes = await fetchWithTimeout(postTarget.href, {
        method: "POST",
        headers: { "User-Agent": crawlerUa(source), Accept: "text/html,application/xhtml+xml", "Content-Type": "application/x-www-form-urlencoded", Origin: base, Referer: `${base}/` },
        body,
      }, opts.validation ? 10000 : 12000);
      const retry = await parseResponse(postRes, postTarget.href);
      if (rankLiveItems(query, retry.items).length > rankLiveItems(query, result.items).length || retry.items.length > result.items.length) result = retry;
    } catch {}
  }

  return result;
}

function parseBusinessSearchResults(htmlText, base) {
  const items = [];
  const seen = new Set();
  const text = String(htmlText || "");

  // The Business School origin occasionally serves slightly malformed list
  // markup. Browsers repair it, but Worker fetch() receives the raw HTML, so
  // parsing must not depend on a matching </li>. Identify result anchors by
  // their query parameters first, then derive nearby text as context.
  const anchorRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchorRe.exec(text))) {
    const rawHref = decodeEntities(m[1]);
    let parsed;
    try { parsed = new URL(rawHref, `${base}/`); } catch { continue; }

    const cc = parsed.searchParams.get("cc");
    const cd = parsed.searchParams.get("cd");
    const ac = parsed.searchParams.get("ac");
    const id = parsed.searchParams.get("id");
    if (cc !== "cindex" || cd !== "news" || ac !== "view" || !id) continue;

    const url = normalizeUrl(parsed.href);
    if (seen.has(url)) continue;
    seen.add(url);

    const title = compactText(stripHtml(m[2])).slice(0, 260);
    if (!title) continue;

    // Prefer the enclosing <li> when present. If the raw page has malformed
    // list markup, use the region between this result anchor and the next one.
    const anchorStart = m.index;
    const anchorEnd = anchorRe.lastIndex;
    const liStart = text.lastIndexOf("<li", anchorStart);
    const liEnd = text.indexOf("</li>", anchorEnd);
    let block;
    if (liStart >= 0 && liEnd >= anchorEnd && liEnd - liStart < 12000) {
      block = text.slice(liStart, liEnd + 5);
    } else {
      const nextLi = text.indexOf("<li", anchorEnd);
      const nextAnchor = text.search(/<a\b[^>]*href=["'][^"']*(?:cc=cindex|cd=news|ac=view)/i);
      const hardEnd = nextLi > anchorEnd ? nextLi : Math.min(text.length, anchorEnd + 3000);
      block = text.slice(Math.max(0, anchorStart - 500), hardEnd);
    }

    const plain = compactText(stripHtml(block));
    const dateM = plain.match(/时\s*间[:：]?\s*(20\d{2}[-/.]\d{1,2}[-/.]\d{1,2})/)
      || plain.match(/(20\d{2}[-/.]\d{1,2}[-/.]\d{1,2})/);
    const summaryM = block.match(/内容摘要[:：]?([\s\S]*?)(?=(?:<\/li>|<li\b|$))/i);
    const snippet = compactText(stripHtml(summaryM ? summaryM[1] : block))
      .replace(title, "")
      .slice(0, 500);

    items.push({
      title,
      date: dateM ? normalizeDate(dateM[1]) : "",
      snippet,
      url,
    });
    if (items.length >= 50) break;
  }
  return items;
}

async function searchCrawlIndex(source, query, limit, env) {
  const pattern = `%${String(query).replace(/[%_]/g, " ")}%`;
  const rows = await env.DB.prepare(`SELECT title,url,published_at,search_text,indexed_at FROM articles WHERE source_id=? AND (title LIKE ? OR search_text LIKE ?) ORDER BY CASE WHEN title LIKE ? THEN 0 ELSE 1 END, indexed_at DESC LIMIT ?`)
    .bind(source.id, pattern, pattern, pattern, limit).all();
  return {
    query,
    page: 1,
    source: "d1-crawl-index",
    count: (rows.results || []).length,
    total: null,
    search_template: "crawl_index",
    items: (rows.results || []).map((row) => ({
      title: row.title,
      date: row.published_at || "",
      snippet: snippetAround(row.search_text || "", query, 500),
      url: row.url,
    })),
  };
}

function snippetAround(text, query, max = 500) {
  const clean = compactText(text || "");
  if (!clean) return "";
  const i = clean.toLowerCase().indexOf(String(query || "").toLowerCase());
  if (i < 0) return clean.slice(0, max);
  const start = Math.max(0, i - Math.floor(max / 3));
  return clean.slice(start, start + max);
}

function parsePagination(htmlText) {
  const text = stripHtml(htmlText.slice(-30000));
  const totalM = text.match(/共有\s*([\d,]+)\s*条/);
  const pagesM = text.match(/共有\s*([\d,]+)\s*页/);
  const currentM = text.match(/当前第\s*([\d,]+)\s*页/);
  return {
    total: totalM ? parseInt(totalM[1].replace(/,/g, ""), 10) : null,
    totalPages: pagesM ? parseInt(pagesM[1].replace(/,/g, ""), 10) : null,
    currentPage: currentM ? parseInt(currentM[1].replace(/,/g, ""), 10) : null,
  };
}

async function searchEmployment(query, page, pageSize, type) {
  const t = normalizeEmploymentType(type);
  const totalUrl = new URL("https://dc.bysjy.com.cn/search/provider_new");
  totalUrl.searchParams.set("token", "yxqqnn0000000005");
  totalUrl.searchParams.set("start", "0");
  totalUrl.searchParams.set("count", "0");
  totalUrl.searchParams.set("keyword", query);
  totalUrl.searchParams.set("type", t);
  totalUrl.searchParams.set("is_total", "1");
  totalUrl.searchParams.set("_", String(Date.now()));
  const totalPayload = await fetchEmployment(totalUrl);
  const total = extractEmploymentTotal(totalPayload);

  if (total === 0) return { query, page, page_size: pageSize, type: t, total: 0, items: [] };

  const dataUrl = new URL("https://dc.bysjy.com.cn/search/provider_new");
  dataUrl.searchParams.set("start_page", String(page));
  dataUrl.searchParams.set("token", "yxqqnn0000000005");
  dataUrl.searchParams.set("keyword", query);
  dataUrl.searchParams.set("type", t);
  dataUrl.searchParams.set("count", String(pageSize));
  dataUrl.searchParams.set("start", String((page - 1) * pageSize + 1));
  dataUrl.searchParams.set("_", String(Date.now() + 1));
  const payload = await fetchEmployment(dataUrl);
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return {
    query, page, page_size: pageSize, type: t, total,
    items: rows.map((row) => normalizeEmploymentRow(row, String(row?.type ?? t))),
  };
}

async function fetchEmployment(url) {
  const res = await fetchWithTimeout(url.href, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; XTU-JIUYE-MCP/2.1)",
      Accept: "*/*",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Cache-Control": "no-cache",
      Referer: "https://jiuye.xtu.edu.cn/",
    }
  }, 10000);
  if (!res.ok) throw new Error(`就业网搜索失败 HTTP ${res.status}`);
  const text = await res.text();
  return parseEmploymentPayload(text);
}

function parseEmploymentPayload(text) {
  const s = String(text || '').trim();
  if (s.startsWith('{') || s.startsWith('[')) return JSON.parse(s);
  const m = s.match(/^(?:var\s+)?__result\s*=\s*([\s\S]*?)\s*;?\s*$/);
  if (!m) throw new Error(`无法解析就业网搜索返回格式：${s.slice(0, 160)}`);
  return JSON.parse(m[1]);
}

function extractEmploymentTotal(payload) {
  if (payload && Number(payload.code) !== 1 && payload.msg) throw new Error(`就业网搜索接口返回错误：${payload.msg}`);
  const row = Array.isArray(payload?.data) ? payload.data[0] : null;
  if (row?.total !== undefined && row?.total !== null) {
    const n = Number(row.total);
    if (Number.isFinite(n)) return n;
  }
  const candidates = [payload?.total, payload?.count];
  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function normalizeEmploymentRow(row, type) {
  const title = row.title || row.name || row.subject || row.company_name || row.position_name || "";
  const url = buildEmploymentUrl(row, type);
  const subtitle = row.subtitle || row.company_name || row.address || row.professionals || '';
  return {
    title: String(title),
    date: String(row.time || row.original_time || row.create_time || row.publish_time || row.date || ""),
    snippet: compactText(row.content || row.description || subtitle || row.job_recruitment || "").slice(0, 500),
    url,
    type: type ? TYPE_INFO[type]?.name || String(type) : String(row.type_name || row.type || ""),
  };
}

function buildEmploymentUrl(row, type) {
  const direct = row.url || row.link || row.href;
  if (direct && /^https?:\/\//i.test(direct)) return direct;
  const id = row.id || row.info_id || row.data_id || row.article_id;
  const detail = TYPE_INFO[type]?.detail;
  if (detail && id) return `https://jiuye.xtu.edu.cn/detail/${detail}?id=${encodeURIComponent(id)}`;
  return "https://jiuye.xtu.edu.cn/";
}

function normalizeEmploymentType(value) {
  const t = String(value ?? "").trim();
  return ["", "1", "2", "3", "4", "5", "6"].includes(t) ? t : "";
}

async function fetchArticle(url, source) {
  const target = new URL(url);
  const sourceHost = new URL(source.base_url).hostname;
  if (target.hostname !== sourceHost) throw new Error("正文抓取域名与数据源不匹配");
  const res = await fetchWithTimeout(target.href, {
    headers: { "User-Agent": crawlerUa(source), Accept: "text/html,application/xhtml+xml", Referer: `${source.base_url}/` },
  }, 12000);
  if (!res.ok) throw new Error(`正文抓取失败 HTTP ${res.status}`);
  const raw = await decodeHtmlResponse(res);
  return { ...extractArticleFromHtml(raw, target.href), url: normalizeUrl(target.href), raw_html: raw };
}

function extractArticleFromHtml(htmlText, pageUrl) {
  const title = extractTitle(htmlText) || stripHtml((htmlText.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ""])[1]).slice(0, 300) || pageUrl;
  const main = extractMainHtml(htmlText);
  const text = compactText(stripHtml(main.html));
  const attachments = extractAttachments(htmlText, pageUrl);
  const date = extractDate(htmlText);
  return { title, text, attachments, date, hasMainContainer: main.matched };
}

function extractTitle(htmlText) {
  const patterns = [
    /<h1[^>]*>([\s\S]*?)<\/h1>/i,
    /<h2[^>]*class=["'][^"']*(?:title|detail|article|news)[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i,
    /<div[^>]*class=["'][^"']*(?:title|detail-title|article-title|news-title)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  ];
  for (const re of patterns) {
    const m = htmlText.match(re);
    if (!m) continue;
    const t = stripHtml(m[1]).trim();
    if (t.length >= 2 && t.length <= 300) return t;
  }
  return "";
}

function extractMainHtml(htmlText) {
  const patterns = [
    /<div[^>]*class=["'][^"']*v_news_content[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>)?/i,
    /<div[^>]*id=["']vsb_content[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>)?/i,
    /<div[^>]*class=["'][^"']*(?:article|content|news)[^"']*["'][^>]*>([\s\S]{300,}?)<\/div>/i,
    /<article[^>]*>([\s\S]*?)<\/article>/i,
  ];
  for (const re of patterns) {
    const m = htmlText.match(re);
    if (m) return { html: m[1], matched: true };
  }
  const body = (htmlText.match(/<body[^>]*>([\s\S]*?)<\/body>/i) || [, htmlText])[1];
  return { html: body, matched: false };
}

function extractDate(htmlText) {
  const m = htmlText.match(/(20\d{2}[-年\/.]\d{1,2}[-月\/.]\d{1,2}(?:日)?(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?)/);
  return m ? normalizeDate(m[1]) : "";
}

function extractAttachments(htmlText, pageUrl) {
  const out = [];
  const seen = new Set();
  const re = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(htmlText))) {
    const href = decodeEntities(m[1]).trim();
    const label = stripHtml(m[2]);
    const isFile = /\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|wps|txt)(?:$|[?#])/i.test(href) || /__local\//i.test(href) || /\/system\/resource\/attach\//i.test(href);
    if (!isFile) continue;
    let abs;
    try { abs = new URL(href, pageUrl).href; } catch { continue; }
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push({ name: (label || abs.split("/").pop() || "附件").slice(0, 180), url: abs });
  }
  return out.slice(0, 100);
}

function extractInternalLinks(htmlText, pageUrl, host) {
  const out = [];
  const seen = new Set();
  const re = /<a[^>]+href=["']([^"'#]+(?:#[^"']*)?)["']/gi;
  let m;
  while ((m = re.exec(htmlText))) {
    try {
      const u = new URL(decodeEntities(m[1]), pageUrl);
      u.hash = "";
      if (u.protocol !== "https:" || u.hostname !== host || !isCrawlablePath(u.pathname)) continue;
      const href = normalizeUrl(u.href);
      if (seen.has(href)) continue;
      seen.add(href);
      out.push(href);
    } catch {}
  }
  return out;
}

function isCrawlablePath(path) {
  return !/\.(?:jpg|jpeg|png|gif|webp|svg|ico|css|js|mp4|mp3|avi|mov|pdf|docx?|xlsx?|pptx?|zip|rar|7z)$/i.test(path)
    && !/\/system\/resource\/attach\//i.test(path);
}

function looksLikeArticlePath(path) {
  return /\/info\/|\/content\/|\/article\/|\d{3,}\.html?$/i.test(path);
}

async function getOverview(env) {
  const sourceCount = await env.DB.prepare("SELECT COUNT(*) n FROM sources WHERE enabled=1").first();
  const articleCount = await env.DB.prepare("SELECT COUNT(*) n FROM articles").first();
  const invalidCount = await env.DB.prepare("SELECT COUNT(*) n FROM sources WHERE validation_status='invalid'").first();
  const latest = await env.DB.prepare("SELECT MAX(indexed_at) t FROM articles").first();
  const recent = await env.DB.prepare(`SELECT a.id,a.title,a.url,a.indexed_at,s.name source_name FROM articles a JOIN sources s ON s.id=a.source_id ORDER BY a.indexed_at DESC LIMIT 8`).all();
  return {
    stats: {
      enabled_sources: Number(sourceCount?.n || 0),
      indexed_articles: Number(articleCount?.n || 0),
      invalid_sources: Number(invalidCount?.n || 0),
      latest_indexed_at: latest?.t || null,
    },
    recent_articles: recent.results || [],
  };
}

async function listSources(env, { includeDisabled }) {
  const sql = `SELECT s.*, (SELECT COUNT(*) FROM articles a WHERE a.source_id=s.id) indexed_count FROM sources s ${includeDisabled ? "" : "WHERE s.enabled=1"} ORDER BY s.locked DESC, s.name ASC`;
  const rows = await env.DB.prepare(sql).all();
  return rows.results || [];
}

async function getSource(env, id) {
  return env.DB.prepare("SELECT * FROM sources WHERE id=? LIMIT 1").bind(id).first();
}

async function findSourceByHost(env, hostname) {
  const sources = await listSources(env, { includeDisabled: false });
  return sources.find((s) => {
    try { return new URL(s.base_url).hostname === hostname; } catch { return false; }
  }) || null;
}

async function createSource(env, data) {
  const id = slugify(new URL(data.base_url).hostname.replace(/\.xtu\.edu\.cn$/i, "")) || `source-${crypto.randomUUID().slice(0, 8)}`;
  let finalId = id;
  let i = 2;
  while (await getSource(env, finalId)) finalId = `${id}-${i++}`;
  await env.DB.prepare(`INSERT INTO sources(id,name,base_url,adapter,source_kind,search_path,search_method,wbtreeid,search_scope,search_template,search_params_json,native_search,canonical_host,site_signature,enabled,locked,validation_status,validation_message,last_validated_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`)
    .bind(finalId, data.name, data.base_url, data.adapter, data.source_kind || (data.adapter === "employment" ? "employment" : "vsb_lucene"), data.search_path || null, data.search_method || null, data.wbtreeid || null, data.search_scope ?? null, data.search_template || null, data.search_params_json || "{}", data.native_search ? 1 : 0, data.canonical_host || new URL(data.base_url).hostname, data.site_signature || null, data.enabled, data.locked, data.validation_status, data.validation_message).run();
  return getSource(env, finalId);
}

async function writeAudit(env, actor, action, target, detail) {
  try {
    await env.DB.prepare("INSERT INTO audit_log(id,actor,action,target,detail_json,created_at) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP)")
      .bind(crypto.randomUUID(), actor, action, target, JSON.stringify(detail || {})).run();
  } catch (error) {
    console.warn("audit_failed", error);
  }
}

function publicSource(source) {
  return {
    id: source.id,
    name: source.name,
    base_url: source.base_url,
    adapter: source.adapter,
    source_kind: sourceKind(source),
    native_search: Boolean(source.native_search),
    search_template: source.search_template || null,
    validation_status: source.validation_status,
    indexed_count: Number(source.indexed_count || 0),
  };
}

async function isMcpAuthorized(request, env) {
  if (!env.MCP_TOKEN) return true;
  const auth = request.headers.get("Authorization") || "";
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  const url = new URL(request.url);
  const token = bearer || url.searchParams.get("token") || "";
  return safeEqual(token, String(env.MCP_TOKEN));
}

async function readAdminSession(request, env) {
  if (!env.SESSION_SECRET) return null;
  const cookie = request.headers.get("Cookie") || "";
  const token = cookie.match(/(?:^|;\s*)xtu_admin=([^;]+)/)?.[1];
  if (!token) return null;
  return verifySessionToken(token, env.SESSION_SECRET);
}

async function createSessionToken(user, secret) {
  const payload = base64UrlEncode(JSON.stringify({ user, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS }));
  const sig = await hmac(payload, secret);
  return `${payload}.${sig}`;
}

async function verifySessionToken(token, secret) {
  const [payload, sig] = String(token).split(".");
  if (!payload || !sig) return null;
  const expected = await hmac(payload, secret);
  if (!(await safeEqual(sig, expected))) return null;
  try {
    const obj = JSON.parse(base64UrlDecode(payload));
    if (!obj.exp || obj.exp < Math.floor(Date.now() / 1000)) return null;
    return obj;
  } catch { return null; }
}

async function hmac(value, secret) {
  const key = await crypto.subtle.importKey("raw", textEncoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, textEncoder.encode(value));
  return bytesToBase64Url(new Uint8Array(sig));
}

async function safeEqual(a, b) {
  const [da, db] = await Promise.all([crypto.subtle.digest("SHA-256", textEncoder.encode(String(a))), crypto.subtle.digest("SHA-256", textEncoder.encode(String(b)))]);
  const aa = new Uint8Array(da), bb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

async function sha256Hex(value) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", textEncoder.encode(value)));
  return [...digest].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function normalizeBaseUrl(input) {
  let value = String(input || "").trim();
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  const u = new URL(value);
  if (u.protocol !== "https:") throw new Error("只允许 HTTPS 官网");
  if (u.username || u.password || (u.port && u.port !== "443")) throw new Error("URL 不允许携带凭据或自定义端口");
  u.pathname = "/";
  u.search = "";
  u.hash = "";
  return u.href.replace(/\/$/, "");
}

function assertAllowedUniversityHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  if (!(h === "xtu.edu.cn" || h.endsWith(ALLOWED_DOMAIN_SUFFIX))) {
    throw new Error("仅允许 xtu.edu.cn 及其子域名");
  }
  if (h.includes("..")) throw new Error("非法域名");
}

function normalizeUrl(input) {
  const u = new URL(input);
  u.hash = "";
  if ((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80")) u.port = "";
  return u.href;
}

function crawlerUa(source) {
  return `Mozilla/5.0 (compatible; XTU-Search-MCP/2.3.2; +${source.base_url}/)`;
}

async function fetchWithTimeout(input, init, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort("timeout"), ms);
  try { return await fetch(input, { ...init, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

async function decodeHtmlResponse(res) {
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  const ascii = new TextDecoder("latin1").decode(bytes.slice(0, Math.min(bytes.length, 8192))).toLowerCase();
  const declared = (ct.match(/charset=([^;\s]+)/) || ascii.match(/charset\s*=\s*["']?([a-z0-9_-]+)/))?.[1]?.replace(/["']/g, "") || "";

  // Some XTU VisualSiteBuilder sites declare GBK/GB2312 while actually
  // serving UTF-8 bytes. Prefer strict UTF-8 whenever the byte stream is
  // genuinely valid UTF-8; only fall back to the declared legacy encoding
  // when strict UTF-8 decoding fails.
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {}

  if (/gb2312|gbk|gb18030/i.test(declared)) {
    try { return new TextDecoder("gb18030").decode(bytes); } catch {}
  }

  // Last-resort fallbacks for legacy pages with missing/incorrect metadata.
  try { return new TextDecoder("gb18030").decode(bytes); }
  catch { return new TextDecoder("utf-8").decode(bytes); }
}

function stripHtml(value) {
  return decodeEntities(String(value || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n")
    .replace(/<\/div\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " "));
}

function compactText(value) {
  return String(value || "").replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function utf8Base64(s) {
  const bytes = textEncoder.encode(String(s));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function normalizeDate(s) {
  return String(s || "").replace(/年|\//g, "-").replace(/月/g, "-").replace(/日/g, "").replace(/\.+/g, "-").trim();
}

function slugify(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function safeJsonParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

function safeError(error) {
  if (error instanceof Error) return error.message;
  return String(error || "Unknown error");
}

async function readJson(request) {
  try { return await request.json(); }
  catch { throw new Error("请求体不是有效 JSON"); }
}

function json(body, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function html(body, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  return new Response(body, { ...init, headers });
}

function cors(response) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function rpcResult(id, result) { return { jsonrpc: "2.0", id, result }; }
function rpcError(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }
function textResult(text, isError = false) { return { content: [{ type: "text", text }], isError }; }

function base64UrlEncode(s) {
  const bytes = textEncoder.encode(s);
  return bytesToBase64Url(bytes);
}

function base64UrlDecode(s) {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function loginPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>XTU Search · 登录</title><style>${baseCss()}</style></head>
  <body class="login-body"><main class="login-wrap"><section class="login-card"><div class="brand-mark">X</div><h1>XTU Search</h1><p class="muted">统一搜索管理后台</p><form id="loginForm"><label>账号<input name="username" autocomplete="username" required></label><label>密码<input name="password" type="password" autocomplete="current-password" required></label><button class="btn primary wide" type="submit">登录</button><p id="error" class="form-error"></p></form></section></main><script>
  document.getElementById('loginForm').addEventListener('submit', async (e)=>{e.preventDefault(); const fd=new FormData(e.currentTarget); const btn=e.currentTarget.querySelector('button'); btn.disabled=true; btn.textContent='登录中…'; document.getElementById('error').textContent=''; try{ const r=await fetch('/api/admin/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.fromEntries(fd))}); const j=await r.json(); if(!r.ok) throw new Error(j.error||'登录失败'); location.href='/admin'; }catch(err){document.getElementById('error').textContent=err.message;}finally{btn.disabled=false;btn.textContent='登录';}});
  </script></body></html>`;
}

function adminPage(user) {
  const safeUser = escapeHtml(user);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>XTU Search</title><style>${baseCss()}${adminCss()}</style></head><body>
  <div class="shell"><aside class="sidebar"><div class="brand"><div class="brand-mark small">X</div><div><strong>XTU Search</strong><span>Search MCP</span></div></div><nav><button class="nav active" data-view="overview">概览</button><button class="nav" data-view="sources">数据源</button><button class="nav" data-view="index">索引</button></nav><div class="sidebar-bottom"><div class="account"><div class="avatar">${escapeHtml(safeUser.charAt(0).toUpperCase())}</div><div><strong>${safeUser}</strong><span>Administrator</span></div></div><button id="logout" class="ghost danger-text">退出登录</button></div></aside>
  <main class="main"><header class="topbar"><div><p class="eyebrow">湘潭大学统一搜索</p><h1 id="pageTitle">概览</h1></div><div class="top-actions"><span class="status-dot"></span><span class="muted">Cloudflare Worker</span></div></header>
  <section id="overviewView" class="view"><div id="stats" class="stats-grid"><div class="stat skeleton"></div><div class="stat skeleton"></div><div class="stat skeleton"></div><div class="stat skeleton"></div></div><div class="panel"><div class="panel-head"><div><h2>最近索引</h2><p>最新写入 D1 / R2 / Vectorize 的内容</p></div></div><div id="recentArticles" class="table-wrap"></div></div></section>
  <section id="sourcesView" class="view hidden"><div class="section-head"><div><h2>搜索数据源</h2><p>只有通过同构 CMS 校验的 xtu.edu.cn 域名才允许添加。</p></div><button id="addSource" class="btn primary">+ 添加域名</button></div><div class="toolbar"><input id="sourceSearch" class="search-input" placeholder="搜索名称或域名"><select id="sourceFilter"><option value="all">全部状态</option><option value="valid">正常</option><option value="invalid">异常</option><option value="disabled">已停用</option></select></div><div class="panel flush"><div id="sourcesTable" class="table-wrap"></div></div></section>
  <section id="indexView" class="view hidden"><div class="section-head"><div><h2>索引状态</h2><p>后台爬取经 Queue 执行；正文存 R2，元数据存 D1，语义向量存 Vectorize。</p></div></div><div class="panel"><div class="panel-head"><div><h2>最近写入</h2><p>这里只显示真实索引数据，不绘制估算曲线。</p></div></div><div id="indexArticles" class="table-wrap"></div></div></section>
  </main></div>
  <dialog id="sourceDialog"><form method="dialog" class="dialog-card" id="sourceForm"><div class="dialog-head"><div><h2>添加搜索域名</h2><p>系统会从官网真实搜索表单自动识别 VSB/Lucene、自定义 JSP 或 Crawl，无需预设搜索文件名。</p></div><button class="icon-btn" value="cancel" type="button" id="closeDialog">×</button></div><div class="form-grid"><label>名称<input id="sourceName" placeholder="例如：材料科学与工程学院" required></label><label>官网地址<input id="sourceUrl" placeholder="https://xxx.xtu.edu.cn" required></label></div><div id="validationBox" class="validation-box"><div><strong>尚未校验</strong><p>保存前会自动识别站点搜索协议；无原生搜索时自动降级为 Crawl。</p></div><button type="button" id="validateSource" class="btn secondary">检测并校验</button></div><div class="dialog-actions"><button type="button" class="btn secondary" id="cancelDialog">取消</button><button type="submit" id="saveSource" class="btn primary" disabled>添加数据源</button></div></form></dialog>
  <div id="toast" class="toast"></div>
  <script>${adminJs()}</script></body></html>`;
}

function baseCss() {
  return `:root{--bg:#f7f7f8;--panel:#fff;--text:#171719;--muted:#6c6c73;--line:#e7e7ea;--soft:#f1f1f3;--primary:#171719;--danger:#b42318;--success:#087443;--warning:#a15c00;--radius:12px;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--text);background:var(--bg)}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text)}button,input,select{font:inherit}button{cursor:pointer}.muted{color:var(--muted)}.login-body{min-height:100vh;display:grid;place-items:center;background:#f5f6f7}.login-wrap{width:min(420px,calc(100vw - 32px))}.login-card{background:#fff;border:1px solid var(--line);border-radius:16px;padding:32px;box-shadow:0 18px 50px rgba(0,0,0,.06)}.brand-mark{width:42px;height:42px;border-radius:12px;display:grid;place-items:center;background:#171719;color:white;font-weight:800;margin-bottom:24px}.login-card h1{font-size:24px;margin:0 0 6px}.login-card p{margin:0 0 26px}.login-card label,.form-grid label{display:grid;gap:8px;font-size:13px;font-weight:600;margin:16px 0}.login-card input,.form-grid input,.search-input,select{height:42px;border:1px solid #d9d9de;border-radius:8px;padding:0 12px;background:#fff;outline:none}.login-card input:focus,.form-grid input:focus,.search-input:focus,select:focus{border-color:#8f8f98;box-shadow:0 0 0 3px rgba(0,0,0,.05)}.btn{border:1px solid transparent;border-radius:8px;min-height:38px;padding:0 14px;font-weight:650}.btn.primary{background:var(--primary);color:#fff}.btn.secondary{background:#fff;border-color:#d9d9de;color:#252528}.btn:disabled{opacity:.45;cursor:not-allowed}.wide{width:100%;margin-top:8px}.form-error{color:var(--danger);font-size:13px;margin:12px 0 0!important}`;
}

function adminCss() {
  return `.shell{min-height:100vh;display:grid;grid-template-columns:236px 1fr}.sidebar{position:sticky;top:0;height:100vh;padding:18px 14px;border-right:1px solid var(--line);background:#fbfbfc;display:flex;flex-direction:column}.brand{display:flex;align-items:center;gap:10px;padding:4px 8px 20px}.brand-mark.small{width:30px;height:30px;border-radius:8px;margin:0;font-size:13px}.brand strong,.account strong{display:block;font-size:13px}.brand span,.account span{display:block;font-size:11px;color:var(--muted);margin-top:2px}.sidebar nav{display:grid;gap:4px}.nav{height:38px;border:0;border-radius:8px;background:transparent;text-align:left;padding:0 11px;color:#4d4d53;font-weight:600}.nav:hover,.nav.active{background:#ececef;color:#141416}.sidebar-bottom{margin-top:auto;display:grid;gap:12px}.account{display:flex;gap:10px;align-items:center;padding:10px 8px;border-top:1px solid var(--line)}.avatar{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;background:#e4e4e8;font-size:12px;font-weight:700}.ghost{border:0;background:transparent;text-align:left;padding:0 8px}.danger-text{color:var(--danger)}.main{padding:0 30px 48px;min-width:0}.topbar{height:92px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);margin-bottom:28px}.topbar h1{font-size:22px;margin:3px 0 0}.eyebrow{font-size:11px;color:var(--muted);margin:0}.top-actions{display:flex;align-items:center;gap:8px;font-size:12px}.status-dot{width:8px;height:8px;border-radius:50%;background:#18a46b;box-shadow:0 0 0 3px rgba(24,164,107,.12)}.view{max-width:1260px}.hidden{display:none!important}.stats-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:18px}.stat{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;min-height:110px}.stat p{font-size:12px;color:var(--muted);margin:0}.stat strong{display:block;font-size:28px;margin-top:14px;letter-spacing:-.03em}.stat span{display:block;font-size:11px;color:var(--muted);margin-top:5px}.skeleton{background:linear-gradient(90deg,#fff,#f4f4f6,#fff);background-size:200% 100%;animation:pulse 1.4s infinite}@keyframes pulse{to{background-position:-200% 0}}.panel{background:#fff;border:1px solid var(--line);border-radius:10px;overflow:hidden}.panel.flush{margin-top:12px}.panel-head,.section-head{display:flex;align-items:center;justify-content:space-between;padding:16px 18px}.section-head{padding:0 0 16px}.panel h2,.section-head h2,.dialog-card h2{font-size:16px;margin:0}.panel-head p,.section-head p,.dialog-head p{font-size:12px;color:var(--muted);margin:5px 0 0}.toolbar{display:flex;gap:10px}.search-input{width:min(360px,55vw)}select{min-width:140px}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;font-size:12px}th{text-align:left;color:#77777e;font-weight:600;background:#fafafa;border-bottom:1px solid var(--line);padding:10px 14px;white-space:nowrap}td{padding:12px 14px;border-bottom:1px solid #efeff1;vertical-align:middle}tr:last-child td{border-bottom:0}.source-cell{display:flex;gap:10px;align-items:center}.source-icon{width:28px;height:28px;border:1px solid var(--line);border-radius:7px;display:grid;place-items:center;font-weight:750;background:#fafafa}.source-cell strong{display:block;font-size:12px}.source-cell span{display:block;color:var(--muted);font-size:11px;margin-top:3px}.badge{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:4px 8px;font-size:11px;font-weight:650;background:#f1f1f3;color:#55555d}.badge::before{content:"";width:6px;height:6px;border-radius:50%;background:#888}.badge.ok{background:#edf8f3;color:var(--success)}.badge.ok::before{background:#18a46b}.badge.bad{background:#fdf0ef;color:var(--danger)}.badge.bad::before{background:#d92d20}.badge.off{background:#f0f0f2;color:#73737a}.badge.warn{background:#fff6e5;color:var(--warning)}.badge.warn::before{background:#f59e0b}.row-actions{display:flex;gap:6px;justify-content:flex-end}.mini{border:1px solid var(--line);background:#fff;border-radius:7px;height:30px;padding:0 9px;font-size:11px}.mini:hover{background:#f7f7f8}.danger{color:var(--danger)}dialog{border:0;border-radius:14px;padding:0;width:min(600px,calc(100vw - 30px));box-shadow:0 25px 80px rgba(0,0,0,.22)}dialog::backdrop{background:rgba(15,15,18,.45)}.dialog-card{padding:0}.dialog-head{display:flex;justify-content:space-between;padding:20px;border-bottom:1px solid var(--line)}.icon-btn{border:0;background:transparent;font-size:22px;color:#666}.form-grid{padding:0 20px}.validation-box{margin:6px 20px 20px;border:1px solid var(--line);border-radius:9px;background:#fafafa;padding:14px;display:flex;gap:18px;align-items:center;justify-content:space-between}.validation-box strong{font-size:12px}.validation-box p{font-size:11px;color:var(--muted);margin:4px 0 0}.validation-box.ok{border-color:#b8e1cf;background:#f2fbf7}.validation-box.bad{border-color:#f3b9b4;background:#fff6f5}.dialog-actions{border-top:1px solid var(--line);padding:14px 20px;display:flex;justify-content:flex-end;gap:8px}.toast{position:fixed;right:24px;bottom:24px;background:#171719;color:#fff;border-radius:9px;padding:11px 14px;font-size:12px;opacity:0;transform:translateY(8px);pointer-events:none;transition:.2s}.toast.show{opacity:1;transform:none}.empty{padding:42px 20px;text-align:center;color:var(--muted)}a.link{color:inherit;text-decoration:none}a.link:hover{text-decoration:underline}@media(max-width:850px){.shell{grid-template-columns:72px 1fr}.brand>div:last-child,.nav{font-size:0}.nav::first-letter{font-size:12px}.sidebar{padding:14px 8px}.account>div:not(.avatar),.ghost{display:none}.main{padding:0 16px 40px}.stats-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.topbar{height:76px}.section-head{align-items:flex-end}.toolbar{flex-wrap:wrap}.search-input{width:100%}}`;
}

function adminJs() {
  return `const state={sources:[],overview:null,validated:null};
  const $=(s)=>document.querySelector(s); const $$=(s)=>[...document.querySelectorAll(s)];
  const esc=(s)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const toast=(m)=>{const t=$('#toast');t.textContent=m;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2200)};
  async function api(path,opts={}){const r=await fetch(path,{headers:{'content-type':'application/json',...(opts.headers||{})},...opts});let j={};try{j=await r.json()}catch{}if(r.status===401){location.href='/admin';throw new Error('未登录')}if(!r.ok)throw new Error(j.error||('HTTP '+r.status));return j}
  function setView(name){$$('.view').forEach(x=>x.classList.add('hidden'));$('#'+name+'View').classList.remove('hidden');$$('.nav').forEach(x=>x.classList.toggle('active',x.dataset.view===name));$('#pageTitle').textContent={overview:'概览',sources:'数据源',index:'索引'}[name]||name;if(name==='sources')loadSources();if(name==='index')loadIndex();}
  $$('.nav').forEach(x=>x.onclick=()=>setView(x.dataset.view));
  $('#logout').onclick=async()=>{await api('/api/admin/logout',{method:'POST',body:'{}'});location.href='/admin'};
  async function loadOverview(){const j=await api('/api/admin/overview');state.overview=j;const s=j.stats;$('#stats').innerHTML=[['已启用数据源',s.enabled_sources,'WebUI 动态配置'],['已索引文章',s.indexed_articles,'D1 + R2 + Vectorize'],['异常数据源',s.invalid_sources,s.invalid_sources?'建议重新校验':'当前正常'],['最近索引',s.latest_indexed_at?new Date(s.latest_indexed_at+'Z').toLocaleString():'暂无','Queue 后台任务']].map(x=>'<div class="stat"><p>'+esc(x[0])+'</p><strong>'+esc(x[1])+'</strong><span>'+esc(x[2])+'</span></div>').join('');renderArticles('#recentArticles',j.recent_articles)}
  function renderArticles(sel,rows){const el=$(sel);if(!rows?.length){el.innerHTML='<div class="empty">暂无索引内容</div>';return}el.innerHTML='<table><thead><tr><th>标题</th><th>来源</th><th>索引时间</th></tr></thead><tbody>'+rows.map(r=>'<tr><td><a class="link" target="_blank" href="'+esc(r.url)+'">'+esc(r.title)+'</a></td><td>'+esc(r.source_name)+'</td><td>'+esc(r.indexed_at||'')+'</td></tr>').join('')+'</tbody></table>'}
  async function loadSources(){const j=await api('/api/admin/sources');state.sources=j.sources;renderSources()}
  function renderSources(){const q=$('#sourceSearch').value.trim().toLowerCase();const f=$('#sourceFilter').value;let rows=state.sources.filter(s=>(!q||(s.name+s.base_url).toLowerCase().includes(q))&&(f==='all'||(f==='disabled'?!s.enabled:s.validation_status===f&&s.enabled)));const el=$('#sourcesTable');if(!rows.length){el.innerHTML='<div class="empty">没有匹配的数据源</div>';return}el.innerHTML='<table><thead><tr><th>数据源</th><th>适配器</th><th>搜索入口</th><th>状态</th><th>索引</th><th>上次校验</th><th></th></tr></thead><tbody>'+rows.map(s=>{let badge=!s.enabled?'off':s.validation_status==='valid'?'ok':s.validation_status==='invalid'?'bad':'warn';let label=!s.enabled?'已停用':s.validation_status==='valid'?'正常':s.validation_status==='invalid'?'异常':'待校验';return '<tr><td><div class="source-cell"><div class="source-icon">'+esc((s.name||'X')[0])+'</div><div><strong>'+esc(s.name)+'</strong><span>'+esc(s.base_url)+'</span></div></div></td><td>'+esc(s.source_kind||s.adapter)+'</td><td>'+esc(s.adapter==='employment'?'专用 API':(s.native_search?(s.search_path+' · '+(s.wbtreeid||s.search_template||'')):'Crawl 索引'))+'</td><td><span class="badge '+badge+'">'+label+'</span></td><td>'+Number(s.indexed_count||0)+'</td><td>'+esc(s.last_validated_at||'—')+'</td><td><div class="row-actions"><button class="mini" data-act="toggle" data-id="'+esc(s.id)+'">'+(s.enabled?'停用':'启用')+'</button><button class="mini" data-act="validate" data-id="'+esc(s.id)+'">校验</button>'+(s.adapter!=='employment'?'<button class="mini" data-act="reindex" data-id="'+esc(s.id)+'">重建索引</button>':'')+(!s.locked?'<button class="mini danger" data-act="delete" data-id="'+esc(s.id)+'">删除</button>':'')+'</div></td></tr>'}).join('')+'</tbody></table>';$$('[data-act]').forEach(b=>b.onclick=()=>sourceAction(b.dataset.act,b.dataset.id))}
  async function sourceAction(act,id){try{if(act==='delete'&&!confirm('确定删除这个数据源？已索引的元数据也会删除。'))return;if(act==='toggle'){const s=state.sources.find(x=>x.id===id);await api('/api/admin/sources/'+encodeURIComponent(id)+'/toggle',{method:'POST',body:JSON.stringify({enabled:!s.enabled})});toast('状态已更新')}if(act==='validate'){toast('正在校验真实搜索入口…');await api('/api/admin/sources/'+encodeURIComponent(id)+'/validate',{method:'POST',body:'{}'});toast('校验通过')}if(act==='reindex'){await api('/api/admin/sources/'+encodeURIComponent(id)+'/reindex',{method:'POST',body:'{}'});toast('已加入 Queue')}if(act==='delete'){await api('/api/admin/sources/'+encodeURIComponent(id),{method:'DELETE'});toast('已删除')}await loadSources();}catch(e){toast(e.message)}}
  $('#sourceSearch').oninput=renderSources;$('#sourceFilter').onchange=renderSources;
  const dlg=$('#sourceDialog');$('#addSource').onclick=()=>{state.validated=null;$('#sourceForm').reset();$('#saveSource').disabled=true;$('#validationBox').className='validation-box';$('#validationBox').innerHTML='<div><strong>尚未校验</strong><p>保存前会自动识别站点搜索协议；无原生搜索时自动降级为 Crawl。</p></div><button type="button" id="validateSource" class="btn secondary">检测并校验</button>';bindValidate();dlg.showModal()};$('#closeDialog').onclick=$('#cancelDialog').onclick=()=>dlg.close();
  function bindValidate(){const b=$('#validateSource');if(!b)return;b.onclick=validateForm}
  async function validateForm(){const name=$('#sourceName').value.trim(),url=$('#sourceUrl').value.trim();if(!url){toast('请填写官网地址');return}const box=$('#validationBox');box.innerHTML='<div><strong>检测中…</strong><p>正在识别 VSB、自定义 JSP 或 Crawl 模式。</p></div>';try{const j=await api('/api/admin/sources/validate',{method:'POST',body:JSON.stringify({name,url})});state.validated=j.result;box.className='validation-box ok';box.innerHTML='<div><strong>校验通过 · '+esc(j.result.source_kind)+'</strong><p>'+esc(j.result.message)+' · '+esc(j.result.latency_ms)+'ms</p></div><button type="button" id="validateSource" class="btn secondary">重新检测</button>';$('#saveSource').disabled=false;bindValidate()}catch(e){state.validated=null;box.className='validation-box bad';box.innerHTML='<div><strong>校验失败</strong><p>'+esc(e.message)+'</p></div><button type="button" id="validateSource" class="btn secondary">重试</button>';$('#saveSource').disabled=true;bindValidate()}}
  $('#sourceForm').onsubmit=async(e)=>{e.preventDefault();if(!state.validated)return;const btn=$('#saveSource');btn.disabled=true;btn.textContent='添加中…';try{await api('/api/admin/sources',{method:'POST',body:JSON.stringify({name:$('#sourceName').value.trim(),url:$('#sourceUrl').value.trim()})});dlg.close();toast('数据源已添加');await loadSources()}catch(err){toast(err.message)}finally{btn.textContent='添加数据源';btn.disabled=false}};
  async function loadIndex(){const j=await api('/api/admin/articles?limit=50');renderArticles('#indexArticles',j.articles)}
  loadOverview();`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
