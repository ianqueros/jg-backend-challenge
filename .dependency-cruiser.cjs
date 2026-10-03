module.exports = {
  forbidden: [
    { name: 'no-cycles', severity: 'error', from: {}, to: { circular: true } },
    {
      name: 'domain-independent',
      severity: 'error',
      from: { path: '^src/domains/.*/entities/' },
      to: { path: '^src/core|node_modules/(?:@nestjs|@mikro-orm)' },
    },
    {
      name: 'shared-independent',
      severity: 'error',
      from: {
        path: '^src/shared/',
        pathNot: '^src/shared/transaction-repositories\\.ts$',
      },
      to: { path: '^src/(?:core|domains)/' },
    },
    {
      name: 'database-independent',
      severity: 'error',
      from: {
        path: '^src/core/database/',
        pathNot: '^src/core/database/database\\.config\\.ts$',
      },
      to: { path: '^src/domains/' },
    },
    {
      name: 'transaction-composition-only',
      severity: 'error',
      from: { path: '^src/shared/transaction-repositories\\.ts$' },
      to: {
        path: '^src/(?:core|domains)/',
        pathNot:
          '^(?:src/core/database/transaction-record-store\\.ts|src/domains/(?:wallet|wagering|inbox|outbox)/repositories/[^/]+\\.ts)$',
      },
    },
    {
      name: 'database-registration-only',
      severity: 'error',
      from: { path: '^src/core/database/database\\.config\\.ts$' },
      to: {
        path: '^src/domains/',
        pathNot: '^src/domains/(?:wallet|wagering|inbox|outbox)/schemas/[^/]+\\.ts$',
      },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
  },
};
