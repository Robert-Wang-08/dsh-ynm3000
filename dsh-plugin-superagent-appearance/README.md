# dsh-plugin-superagent-appearance

superagent profile 的外观层：把**浅色主题**整体配色改成视觉保护绿（#c7edcc 画布 + 同色系层级），深色主题保持不变。

## 用法

插件本体只做一件事：在 `webserver/index-inject` 里追加一条 `<style>`，用 `body:not([data-ds-dark-theme])` 限定作用域覆盖 `--dsw-alias-bg-*` 等设计令牌。

在 profile 的 `cordis.patch.yml` 里挂载（本机由 `dsh-superagent-profile-sync.ps1` 生成）：

```yaml
- insert:
    - id: superagent-appearance
      name: dsh-plugin-superagent-appearance
```

依赖以 `link:D:/src/dsh/dsh-plugin-superagent-appearance` 登记，改 `lib/index.js` 后重启服务即生效（无需构建）。

## 开关与回滚

- 关掉：删掉 profile patch 里的 `superagent-appearance` 挂载行并重启服务；
- 换色：只改 `lib/index.js` 里的 CSS（18 个令牌），重启服务；
- web profile 不受影响：插件只在 superagent profile 挂载。
