export const NOTE_EDITING_MIGRATIONS = Object.freeze([
  ['0090_note_revision', 'revision', 'INTEGER', true, '0'],
  ['0091_note_creation_key', 'creation_key', 'TEXT', false, null],
  ['0092_note_last_mutation_id', 'last_mutation_id', 'TEXT', false, null]
].map(([id, name, type, notNull, defaultValue]) => ({
  id,
  source: `ALTER TABLE blog_posts ADD COLUMN ${name} ${type}${notNull ? ' NOT NULL DEFAULT 0' : ''};`,
  compatibility: { kind: 'column', table: 'blog_posts', column: { name, type, notNull, defaultValue } }
})))
