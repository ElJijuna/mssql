## [1.0.1](https://github.com/ElJijuna/mssql/compare/v1.0.0...v1.0.1) (2026-09-28)


### Bug Fixes

* publish to GitHub Packages and docs even if the changelog PR fails ([e5ce113](https://github.com/ElJijuna/mssql/commit/e5ce1133f7f402e5e31526f430244d2fe6d0b473))

# 1.0.0 (2026-09-28)


### Bug Fixes

* add sideEffects property to package.json ([e24b544](https://github.com/ElJijuna/mssql/commit/e24b54471bd81ed4681df0dfb1b9b09b3a42e02a))
* roll back timed-out transactions and type exec outputs with explicit rows ([b496ab0](https://github.com/ElJijuna/mssql/commit/b496ab0cd627f38348f2b626eb0325dc10f323b6))
* update installation instructions and add mssql as a peer dependency ([f4fa4b7](https://github.com/ElJijuna/mssql/commit/f4fa4b7e253f34500e70205d9c16c6ecb00a5634))


### Features

* add client.transaction with the same helpers on tx ([e5248d0](https://github.com/ElJijuna/mssql/commit/e5248d055b86dcd5d096e25bf9cd4899d06ad484))
* add debug mode to print the SQL sent by each helper ([63d36e2](https://github.com/ElJijuna/mssql/commit/63d36e2af00eb28ebdbd5f18c77cb3095de4196c))
* add exec for stored procedures ([1fd3219](https://github.com/ElJijuna/mssql/commit/1fd321945b431adf2bd530d04bf068c82fab3afe))
* add merge (upsert), update and delete helpers ([e8d584d](https://github.com/ElJijuna/mssql/commit/e8d584d38c83fffe9e0919435458cbf7936d0891))
* add per-call signal and timeout ([db068de](https://github.com/ElJijuna/mssql/commit/db068de20acc1fcd6a006ac21174e6bb948cb182))
* add query and queryFile for raw SQL and .sql files ([18894fc](https://github.com/ElJijuna/mssql/commit/18894fc6d69542bf41dcbd984338dabb68599b6d))
* add select and findOne helpers ([1a8619d](https://github.com/ElJijuna/mssql/commit/1a8619d4c048a8ce3dbe943d36c51a5e7b36baad))
* add tagged template queries with tsql fragments ([cb2c140](https://github.com/ElJijuna/mssql/commit/cb2c140143bad6abdf0b6ed77416c635075f752e))
* add typed event emitter to SqlClient ([16a1943](https://github.com/ElJijuna/mssql/commit/16a194388a76cc9dde6835c38609b2205dc81b2b))
* add typed parameters support and bindInput utility for SqlClient ([28c8e34](https://github.com/ElJijuna/mssql/commit/28c8e34e4c40a131d0e8cd68faf3973f57ee6d2b))
* enhance error handling in insertMany method to support row-by-row retries and update error reporting ([7738aef](https://github.com/ElJijuna/mssql/commit/7738aef2d55cba6e0747528b8975adf3697ecd61))
* implement insert method in SqlClient and add quoteIdentifier utility with tests ([139a1b8](https://github.com/ElJijuna/mssql/commit/139a1b839cd5f41549573b7055886344a6e0fb34))
* implement insertMany method in SqlClient with error handling and batch processing ([15fa30e](https://github.com/ElJijuna/mssql/commit/15fa30e3a10e3e0c3b672eb9b54caa14a620cfb2))
* initialize @pilmee/mssql package with SqlClient implementation and tests ([8f7d13e](https://github.com/ElJijuna/mssql/commit/8f7d13eb5d657b5d95c629412825b3345bf2d6de))
* retry transient errors with exponential backoff ([ed6495d](https://github.com/ElJijuna/mssql/commit/ed6495dfef9e5de8e932ca52a39647c404dfb447))
* update ESLint configuration and improve test cases for SqlClient and debug utilities ([8505098](https://github.com/ElJijuna/mssql/commit/8505098130cc87522617e85c4705c5c4d8efd588))
