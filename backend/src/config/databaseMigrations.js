import { createMigrationRegistry } from './migrationPlan.js'

export const applicationMigrationRegistry = createMigrationRegistry([
  {
    id: '0001_documents_subcategory',
    source: 'ALTER TABLE documents ADD COLUMN subcategory TEXT;',
    compatibility: {
      kind: 'column',
      table: 'documents',
      column: {
        name: 'subcategory',
        type: 'TEXT',
        notNull: false,
        defaultValue: null
      }
    }
  },
  {
    id: '0002_categories_sort_order',
    source: 'ALTER TABLE categories ADD COLUMN sort_order INTEGER DEFAULT 0;',
    compatibility: {
      kind: 'column',
      table: 'categories',
      column: {
        name: 'sort_order',
        type: 'INTEGER',
        notNull: false,
        defaultValue: '0'
      }
    }
  },
  {
    id: '0003_todos_confirmed',
    source: 'ALTER TABLE todos ADD COLUMN confirmed INTEGER DEFAULT 0;',
    compatibility: {
      kind: 'column',
      table: 'todos',
      column: {
        name: 'confirmed',
        type: 'INTEGER',
        notNull: false,
        defaultValue: '0'
      }
    }
  },
  {
    id: '0004_books_content_cache',
    source: 'ALTER TABLE books ADD COLUMN content_cache TEXT;',
    compatibility: {
      kind: 'column',
      table: 'books',
      column: {
        name: 'content_cache',
        type: 'TEXT',
        notNull: false,
        defaultValue: null
      }
    }
  }
])
