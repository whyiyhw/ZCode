import { defineConfig } from "vitest/config";

// 对齐根仓 vitest.config.ts 的负载口径：Windows 上插件缓存解压/文件监视/spawn 明显慢于 CI Linux，
// 5s 默认超时造成假失败；保留单测语义不变，仅放宽超时上限。
const baseTimeouts = {
  testTimeout: 30_000,
  hookTimeout: 30_000,
} as const;

// workflow-fault-matrix* 会拉起真实多进程 workflow 链（runner/fake provider/子代理），
// 全量并发跑时 CPU 争用会打破其确定性计数假设（B1/B2/B8a 在不同轮次轮流假失败，
// 单文件运行 3/3 稳定）。按根仓 unit/fork-isolated 的既有模式：forks 池 + 文件内串行
// + groupOrder=1（在默认组全部结束后才开跑，消除跨文件并发争用）。
export default defineConfig({
  test: {
    ...baseTimeouts,
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/**"],
          exclude: ["tests/workflow-fault-matrix*.test.ts"],
          ...baseTimeouts,
          sequence: { groupOrder: 0 },
        },
      },
      {
        test: {
          name: "fault-matrix",
          include: ["tests/workflow-fault-matrix*.test.ts"],
          pool: "forks",
          fileParallelism: false,
          maxWorkers: 1,
          ...baseTimeouts,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
