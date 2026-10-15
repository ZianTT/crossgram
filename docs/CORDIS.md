# Cordis 开发说明

CrossGram 基于 [Cordis v4](https://github.com/cordiverse/cordis) 插件与依赖注入框架构建。

## 1. 核心概念

1. **Context（作用域树）**：`new Context()` 为根上下文，每个加载的插件运行在独立的派生 `Context` 与 `Fiber` 中。
2. **依赖注入（`inject`）**：插件通过 `export const inject = ['db', 'mtproto']` 声明依赖。只有当依赖的全部服务均已就绪时，插件的 `apply(ctx, config)` 才会执行；当任一依赖卸载时，当前插件会自动卸载并在依赖恢复后重新挂载。
3. **副作用自动回收（Effect）**：`ctx.on()`、`ctx.set()`、`ctx.effect()`、`ctx.plugin()` 注册的监听器与资源均绑定在当前插件的 `Fiber` 上，插件卸载或热重载时自动清理。
4. **服务（Service）**：继承 `Service` 并调用 `super(ctx, 'serviceName', true)` 即可在上下文上挂载 `ctx.serviceName`。

## 2. 插件写法

```ts
import type { Context } from 'cordis'
import z from 'schemastery'

export const name = 'my-plugin'
export const inject = ['mtproto', 'database']

export interface Config {
  enabled?: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
})

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('my-plugin')

  // 注册事件监听（插件卸载时自动移除）
  ctx.on('ready', () => {
    logger.info('plugin ready')
  })

  // 注册自定义资源并在卸载时清理
  ctx.effect(() => {
    const timer = setInterval(() => {}, 5000)
    return () => clearInterval(timer)
  })
}
```

## 3. 编写 Service

```ts
import { Context, Service } from 'cordis'

declare module 'cordis' {
  interface Context {
    myService: MyService
  }
}

export class MyService extends Service {
  static inject = ['database']

  constructor(ctx: Context) {
    super(ctx, 'myService', true)
  }

  // 可选：异步初始化或返回清理函数
  async [Service.init]() {
    return () => {
      // 卸载清理逻辑
    }
  }
}
```

## 4. 事件分发机制

- `ctx.emit(name, ...args)`：同步触发所有监听器（不等待 Promise）。
- `await ctx.parallel(name, ...args)`：并发执行所有监听器并等待全部完成。
- `await ctx.serial(name, ...args)`：按顺序执行监听器，任一监听器返回非 `undefined` 值时立即中止并返回该值（常用于路由匹配）。
- `await ctx.bail(name, ...args)`：同步顺序执行，任一监听器返回非 `undefined` 值时立即返回。
- `await ctx.waterfall(name, ...args, next)`：洋葱圈/管道模型，用于数据包或 RPC 前置拦截。

CrossGram 中 MTProto 与平台事件的具体管线设计见 [Cordis 管线与生命周期](cordis-native-pipelines.md)。
