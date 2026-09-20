// Expand derived storage without changing source bytes, snapshots or vectors.
// Existing snapshots keep their old lexical coverage until the explicit index
// refresh builds the versioned small chunks and their CJK projection.
export const RAG_SEARCH_PROJECTION_MIGRATIONS = Object.freeze([{
  id: '0093_rag_search_projection',
  source: `
ALTER TABLE rag_chunks ADD COLUMN search_body TEXT NOT NULL DEFAULT '';
UPDATE rag_chunks SET search_body = body;
DROP TABLE rag_chunks_fts;
CREATE VIRTUAL TABLE rag_chunks_fts USING fts5(
  title, section_path_json, search_body,
  content='rag_chunks', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);
INSERT INTO rag_chunks_fts(rag_chunks_fts) VALUES ('rebuild');
UPDATE rag_chunks_fts_meta SET schema_version = 2, updated_at = CURRENT_TIMESTAMP;
`.trim()
}])
