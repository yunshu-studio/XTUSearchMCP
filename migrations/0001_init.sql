PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL UNIQUE,
  adapter TEXT NOT NULL DEFAULT 'general' CHECK(adapter IN ('general','employment')),
  search_path TEXT,
  wbtreeid TEXT,
  search_scope TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  locked INTEGER NOT NULL DEFAULT 0,
  validation_status TEXT NOT NULL DEFAULT 'pending' CHECK(validation_status IN ('pending','valid','invalid')),
  validation_message TEXT,
  last_validated_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  published_at TEXT,
  content_hash TEXT,
  raw_key TEXT,
  text_key TEXT NOT NULL,
  attachments_json TEXT NOT NULL DEFAULT '[]',
  indexed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(source_id) REFERENCES sources(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_articles_source ON articles(source_id);
CREATE INDEX IF NOT EXISTS idx_articles_indexed_at ON articles(indexed_at DESC);

CREATE TABLE IF NOT EXISTS crawl_seen (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  url TEXT NOT NULL,
  last_crawled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(source_id) REFERENCES sources(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_crawl_seen_source ON crawl_seen(source_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at DESC);

INSERT OR IGNORE INTO sources
(id,name,base_url,adapter,search_path,wbtreeid,search_scope,enabled,locked,validation_status,validation_message,last_validated_at)
VALUES
('main','湘潭大学官网','https://www.xtu.edu.cn','general','/qwssjg.jsp','1001','0',1,0,'valid','由旧 xtu-main-mcp 迁移',CURRENT_TIMESTAMP),
('jwc','湘潭大学教务处','https://jwc.xtu.edu.cn','general','/ssjg.jsp','1001','1',1,0,'valid','由旧 xtu-jwc-mcp 迁移',CURRENT_TIMESTAMP),
('cs','计算机学院·网络空间安全学院','https://jwxy.xtu.edu.cn','general','/search.jsp','1001','0',1,0,'valid','由旧 xtu-cs-mcp 迁移',CURRENT_TIMESTAMP),
('kjc','湘潭大学科技处','https://kjc.xtu.edu.cn','general','/search.jsp','1001','0',1,0,'valid','由旧 xtu-kjc-mcp 迁移',CURRENT_TIMESTAMP),
('jszy','湘潭大学技术转移中心','https://jszy.xtu.edu.cn','general','/ssjg.jsp','1064','0',1,0,'valid','由旧 xtu-jszy-mcp 迁移',CURRENT_TIMESTAMP),
('nic','湘潭大学网络与信息中心','https://nic.xtu.edu.cn','general','/search.jsp','1001','0',1,0,'valid','由旧 xtu-nic-mcp 迁移',CURRENT_TIMESTAMP),
('jiuye','湘潭大学就业信息网','https://jiuye.xtu.edu.cn','employment','https://dc.bysjy.com.cn/search/provider_new',NULL,NULL,1,1,'valid','就业网使用专用 API 适配器',CURRENT_TIMESTAMP);
