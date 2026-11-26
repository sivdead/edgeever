# #879 共享表服务回滚复验

此快照保留了 [PR #900](https://github.com/tianma-if/edgeever/pull/900) 回滚演练使用的 0101 自托管服务源码。使用 Bun 1.3.14，在仓库根目录执行以下命令。

```sh
bun install --frozen-lockfile --ignore-scripts
bun run build:self-hosted
shasum -a 256 dist/self-hosted/self-hosted-server.js
```

预期 SHA-256 为 `6d7853e3cc070864915fb50ddcf2cf464b5bac46b23effa273e54bd7c6a6a474`。演练在升级后的 Docker 数据卷上运行重建的服务，切换服务时沿用 PR 的 0105 迁移目录和该数据卷。升级与回滚结果见 PR #900 的变更说明。
