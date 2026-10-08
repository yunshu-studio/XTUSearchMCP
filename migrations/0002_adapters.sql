ALTER TABLE sources ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'vsb_lucene';
ALTER TABLE sources ADD COLUMN search_method TEXT;
ALTER TABLE sources ADD COLUMN search_template TEXT;
ALTER TABLE sources ADD COLUMN search_params_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE sources ADD COLUMN native_search INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sources ADD COLUMN canonical_host TEXT;
ALTER TABLE sources ADD COLUMN site_signature TEXT;
ALTER TABLE sources ADD COLUMN alias_of TEXT;
ALTER TABLE articles ADD COLUMN search_text TEXT;

UPDATE sources
SET source_kind = CASE WHEN adapter='employment' THEN 'employment' ELSE 'vsb_lucene' END,
    search_method = CASE WHEN adapter='employment' THEN 'GET' ELSE 'POST' END,
    search_template = CASE WHEN adapter='employment' THEN 'bysjy_api' ELSE COALESCE(search_template, 'generic_info') END,
    native_search = CASE WHEN adapter='employment' THEN 1 ELSE 1 END,
    canonical_host = CASE
      WHEN base_url LIKE 'https://%' THEN substr(base_url, 9)
      ELSE base_url
    END
WHERE source_kind IS NULL OR source_kind='' OR canonical_host IS NULL;

UPDATE sources SET canonical_host = rtrim(canonical_host, '/');
UPDATE sources SET search_params_json = '{}' WHERE search_params_json IS NULL OR search_params_json='';

CREATE INDEX IF NOT EXISTS idx_sources_kind ON sources(source_kind);
CREATE INDEX IF NOT EXISTS idx_sources_signature ON sources(site_signature);
CREATE INDEX IF NOT EXISTS idx_articles_source_indexed ON articles(source_id, indexed_at DESC);
