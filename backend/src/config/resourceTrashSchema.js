export const RESOURCE_TRASH_TABLE = 'resource_trash_entries'

export const CREATE_RESOURCE_TRASH_SQL = `CREATE TABLE resource_trash_entries (
  resource_type TEXT NOT NULL,
  resource_id INTEGER NOT NULL,
  original_parent_id INTEGER,
  original_path TEXT,
  deleted_at TEXT NOT NULL,
  purge_after TEXT,
  metadata_json TEXT,
  PRIMARY KEY (resource_type, resource_id)
)`

export const RESOURCE_TRASH_SHAPE = Object.freeze({
  strict: false,
  withoutRowid: false,
  columns: Object.freeze([
    { name: 'resource_type', type: 'TEXT', notNull: true, defaultValue: null, primaryKeyPosition: 1 },
    { name: 'resource_id', type: 'INTEGER', notNull: true, defaultValue: null, primaryKeyPosition: 2 },
    { name: 'original_parent_id', type: 'INTEGER', notNull: false, defaultValue: null, primaryKeyPosition: 0 },
    { name: 'original_path', type: 'TEXT', notNull: false, defaultValue: null, primaryKeyPosition: 0 },
    { name: 'deleted_at', type: 'TEXT', notNull: true, defaultValue: null, primaryKeyPosition: 0 },
    { name: 'purge_after', type: 'TEXT', notNull: false, defaultValue: null, primaryKeyPosition: 0 },
    { name: 'metadata_json', type: 'TEXT', notNull: false, defaultValue: null, primaryKeyPosition: 0 }
  ].map(Object.freeze)),
  foreignKeys: Object.freeze([]),
  uniqueConstraints: Object.freeze([])
})
