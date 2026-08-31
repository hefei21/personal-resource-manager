export const EBOOK_READING_PROGRESS_MIGRATIONS = Object.freeze([
  {
    id: '0087_reading_progress_revision',
    source: 'ALTER TABLE reading_progress ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;',
    compatibility: {
      kind: 'column',
      table: 'reading_progress',
      column: {
        name: 'revision',
        type: 'INTEGER',
        notNull: true,
        defaultValue: '0'
      }
    }
  },
  {
    id: '0088_reading_progress_last_mutation_id',
    source: 'ALTER TABLE reading_progress ADD COLUMN last_mutation_id TEXT;',
    compatibility: {
      kind: 'column',
      table: 'reading_progress',
      column: {
        name: 'last_mutation_id',
        type: 'TEXT',
        notNull: false,
        defaultValue: null
      }
    }
  },
  {
    id: '0089_reading_progress_chapter_fraction',
    source: 'ALTER TABLE reading_progress ADD COLUMN chapter_fraction REAL;',
    compatibility: {
      kind: 'column',
      table: 'reading_progress',
      column: {
        name: 'chapter_fraction',
        type: 'REAL',
        notNull: false,
        defaultValue: null
      }
    }
  }
])
