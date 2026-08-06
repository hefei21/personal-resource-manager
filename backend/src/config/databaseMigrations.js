import { createMigrationRegistry } from './migrationPlan.js'

// C1b-4b keeps the application registry empty. Existing inline schema changes
// will be migrated here incrementally in C2 with explicit compatibility plans.
export const applicationMigrationRegistry = createMigrationRegistry([])
