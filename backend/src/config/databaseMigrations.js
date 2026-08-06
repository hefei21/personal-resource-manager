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
  },
  {
    id: '0005_bookmarks_icon',
    source: 'ALTER TABLE bookmarks ADD COLUMN icon TEXT;',
    compatibility: {
      kind: 'column',
      table: 'bookmarks',
      column: {
        name: 'icon',
        type: 'TEXT',
        notNull: false,
        defaultValue: null
      }
    }
  },
  {
    id: '0006_bookmarks_icon_data',
    source: 'ALTER TABLE bookmarks ADD COLUMN icon_data TEXT;',
    compatibility: {
      kind: 'column',
      table: 'bookmarks',
      column: {
        name: 'icon_data',
        type: 'TEXT',
        notNull: false,
        defaultValue: null
      }
    }
  },
  {
    id: '0007_anime_name_cn',
    source: 'ALTER TABLE anime ADD COLUMN name_cn TEXT;',
    compatibility: {
      kind: 'column',
      table: 'anime',
      column: {
        name: 'name_cn',
        type: 'TEXT',
        notNull: false,
        defaultValue: null
      }
    }
  },
  {
    id: '0008_anime_name_original',
    source: 'ALTER TABLE anime ADD COLUMN name_original TEXT;',
    compatibility: {
      kind: 'column',
      table: 'anime',
      column: {
        name: 'name_original',
        type: 'TEXT',
        notNull: false,
        defaultValue: null
      }
    }
  },
  {
    id: '0009_anime_rating_count',
    source: 'ALTER TABLE anime ADD COLUMN rating_count INTEGER DEFAULT 0;',
    compatibility: {
      kind: 'column',
      table: 'anime',
      column: {
        name: 'rating_count',
        type: 'INTEGER',
        notNull: false,
        defaultValue: '0'
      }
    }
  },
  {
    id: '0010_anime_air_date',
    source: 'ALTER TABLE anime ADD COLUMN air_date TEXT;',
    compatibility: {
      kind: 'column',
      table: 'anime',
      column: {
        name: 'air_date',
        type: 'TEXT',
        notNull: false,
        defaultValue: null
      }
    }
  },
  {
    id: '0011_anime_eps',
    source: 'ALTER TABLE anime ADD COLUMN eps INTEGER DEFAULT 0;',
    compatibility: {
      kind: 'column',
      table: 'anime',
      column: {
        name: 'eps',
        type: 'INTEGER',
        notNull: false,
        defaultValue: '0'
      }
    }
  },
  {
    id: '0012_anime_eps_total',
    source: 'ALTER TABLE anime ADD COLUMN eps_total INTEGER DEFAULT 0;',
    compatibility: {
      kind: 'column',
      table: 'anime',
      column: {
        name: 'eps_total',
        type: 'INTEGER',
        notNull: false,
        defaultValue: '0'
      }
    }
  },
  {
    id: '0013_anime_author',
    source: 'ALTER TABLE anime ADD COLUMN author TEXT;',
    compatibility: {
      kind: 'column',
      table: 'anime',
      column: {
        name: 'author',
        type: 'TEXT',
        notNull: false,
        defaultValue: null
      }
    }
  },
  {
    id: '0014_anime_director',
    source: 'ALTER TABLE anime ADD COLUMN director TEXT;',
    compatibility: {
      kind: 'column',
      table: 'anime',
      column: {
        name: 'director',
        type: 'TEXT',
        notNull: false,
        defaultValue: null
      }
    }
  },
  {
    id: '0015_anime_studio',
    source: 'ALTER TABLE anime ADD COLUMN studio TEXT;',
    compatibility: {
      kind: 'column',
      table: 'anime',
      column: {
        name: 'studio',
        type: 'TEXT',
        notNull: false,
        defaultValue: null
      }
    }
  },
  {
    id: '0016_anime_infobox',
    source: 'ALTER TABLE anime ADD COLUMN infobox TEXT;',
    compatibility: {
      kind: 'column',
      table: 'anime',
      column: {
        name: 'infobox',
        type: 'TEXT',
        notNull: false,
        defaultValue: null
      }
    }
  },
  {
    id: '0017_anime_characters',
    source: 'ALTER TABLE anime ADD COLUMN characters TEXT;',
    compatibility: {
      kind: 'column',
      table: 'anime',
      column: {
        name: 'characters',
        type: 'TEXT',
        notNull: false,
        defaultValue: null
      }
    }
  },
  {
    id: '0018_anime_staff',
    source: 'ALTER TABLE anime ADD COLUMN staff TEXT;',
    compatibility: {
      kind: 'column',
      table: 'anime',
      column: {
        name: 'staff',
        type: 'TEXT',
        notNull: false,
        defaultValue: null
      }
    }
  },
  {
    id: '0019_anime_user_rating',
    source: 'ALTER TABLE anime ADD COLUMN user_rating INTEGER DEFAULT 0;',
    compatibility: {
      kind: 'column',
      table: 'anime',
      column: {
        name: 'user_rating',
        type: 'INTEGER',
        notNull: false,
        defaultValue: '0'
      }
    }
  },
  {
    id: '0020_anime_is_hidden',
    source: 'ALTER TABLE anime ADD COLUMN is_hidden INTEGER DEFAULT 0;',
    compatibility: {
      kind: 'column',
      table: 'anime',
      column: {
        name: 'is_hidden',
        type: 'INTEGER',
        notNull: false,
        defaultValue: '0'
      }
    }
  },
  {
    id: '0021_anime_cover_image_data',
    source: 'ALTER TABLE anime ADD COLUMN cover_image_data TEXT;',
    compatibility: {
      kind: 'column',
      table: 'anime',
      column: {
        name: 'cover_image_data',
        type: 'TEXT',
        notNull: false,
        defaultValue: null
      }
    }
  },
  {
    id: '0022_games_achievements_total',
    source: 'ALTER TABLE games ADD COLUMN achievements_total INTEGER DEFAULT 0;',
    compatibility: {
      kind: 'column',
      table: 'games',
      column: {
        name: 'achievements_total',
        type: 'INTEGER',
        notNull: false,
        defaultValue: '0'
      }
    }
  },
  {
    id: '0023_games_achievements_completed',
    source: 'ALTER TABLE games ADD COLUMN achievements_completed INTEGER DEFAULT 0;',
    compatibility: {
      kind: 'column',
      table: 'games',
      column: {
        name: 'achievements_completed',
        type: 'INTEGER',
        notNull: false,
        defaultValue: '0'
      }
    }
  },
  {
    id: '0024_games_header_cover_image',
    source: 'ALTER TABLE games ADD COLUMN header_cover_image TEXT;',
    compatibility: {
      kind: 'column',
      table: 'games',
      column: {
        name: 'header_cover_image',
        type: 'TEXT',
        notNull: false,
        defaultValue: null
      }
    }
  },
  {
    id: '0025_games_header_cover_image_data',
    source: 'ALTER TABLE games ADD COLUMN header_cover_image_data TEXT;',
    compatibility: {
      kind: 'column',
      table: 'games',
      column: {
        name: 'header_cover_image_data',
        type: 'TEXT',
        notNull: false,
        defaultValue: null
      }
    }
  },
  {
    id: '0026_music_artist',
    source: 'ALTER TABLE music ADD COLUMN artist TEXT;',
    compatibility: {
      kind: 'column',
      table: 'music',
      column: {
        name: 'artist',
        type: 'TEXT',
        notNull: false,
        defaultValue: null
      }
    }
  },
  {
    id: '0027_music_album',
    source: 'ALTER TABLE music ADD COLUMN album TEXT;',
    compatibility: {
      kind: 'column',
      table: 'music',
      column: {
        name: 'album',
        type: 'TEXT',
        notNull: false,
        defaultValue: null
      }
    }
  },
  {
    id: '0028_music_duration',
    source: 'ALTER TABLE music ADD COLUMN duration INTEGER DEFAULT 0;',
    compatibility: {
      kind: 'column',
      table: 'music',
      column: {
        name: 'duration',
        type: 'INTEGER',
        notNull: false,
        defaultValue: '0'
      }
    }
  },
  {
    id: '0029_music_file_size',
    source: 'ALTER TABLE music ADD COLUMN file_size INTEGER DEFAULT 0;',
    compatibility: {
      kind: 'column',
      table: 'music',
      column: {
        name: 'file_size',
        type: 'INTEGER',
        notNull: false,
        defaultValue: '0'
      }
    }
  },
  {
    id: '0030_music_file_type',
    source: 'ALTER TABLE music ADD COLUMN file_type TEXT;',
    compatibility: {
      kind: 'column',
      table: 'music',
      column: {
        name: 'file_type',
        type: 'TEXT',
        notNull: false,
        defaultValue: null
      }
    }
  },
  {
    id: '0031_music_cover_image',
    source: 'ALTER TABLE music ADD COLUMN cover_image TEXT;',
    compatibility: {
      kind: 'column',
      table: 'music',
      column: {
        name: 'cover_image',
        type: 'TEXT',
        notNull: false,
        defaultValue: null
      }
    }
  },
  {
    id: '0032_music_lyrics',
    source: 'ALTER TABLE music ADD COLUMN lyrics TEXT;',
    compatibility: {
      kind: 'column',
      table: 'music',
      column: {
        name: 'lyrics',
        type: 'TEXT',
        notNull: false,
        defaultValue: null
      }
    }
  },
  {
    id: '0033_music_lyrics_source',
    source: 'ALTER TABLE music ADD COLUMN lyrics_source TEXT;',
    compatibility: {
      kind: 'column',
      table: 'music',
      column: {
        name: 'lyrics_source',
        type: 'TEXT',
        notNull: false,
        defaultValue: null
      }
    }
  },
  {
    id: '0034_music_has_lyrics',
    source: 'ALTER TABLE music ADD COLUMN has_lyrics INTEGER DEFAULT 0;',
    compatibility: {
      kind: 'column',
      table: 'music',
      column: {
        name: 'has_lyrics',
        type: 'INTEGER',
        notNull: false,
        defaultValue: '0'
      }
    }
  },
  {
    id: '0035_music_lyrics_updated_at',
    source: 'ALTER TABLE music ADD COLUMN lyrics_updated_at TEXT;',
    compatibility: {
      kind: 'column',
      table: 'music',
      column: {
        name: 'lyrics_updated_at',
        type: 'TEXT',
        notNull: false,
        defaultValue: null
      }
    }
  }
])
