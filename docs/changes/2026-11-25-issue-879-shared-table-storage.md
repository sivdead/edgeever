# Shared table rollback verification for #879

This snapshot preserves the 0101 self-hosted service used in the rollback drill for [PR #900](https://github.com/tianma-if/edgeever/pull/900). Build with Bun 1.3.14 from the repository root.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run build:self-hosted
shasum -a 256 dist/self-hosted/self-hosted-server.js
```

Expected SHA-256 is `6d7853e3cc070864915fb50ddcf2cf464b5bac46b23effa273e54bd7c6a6a474`. During the drill the rebuilt service runs on the upgraded Docker volume with the PR’s 0105 migration directory. Keep that directory and the data volume when switching the service. See the change note in PR #900 for the upgrade and rollback results.
