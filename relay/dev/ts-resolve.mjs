/**
 * 让 Node 原生 TypeScript 支持能解析本项目「.js 后缀指向 .ts 源文件」的写法。
 *
 * 背景：tsconfig 用的是 NodeNext，源码里一律写 `./foo.js`；
 * 而 Node 的 --experimental-strip-types 不会把 .js 改写成 .ts，
 * 直接 `node src/main.ts` 会报 Cannot find module './foo.js'。
 *
 * 仅用于本地验证（不依赖 tsx / esbuild），不影响正常 `npm run ...` 流程。
 * 只在父模块位于本仓库的 src 目录内、且是相对导入时才做替换。
 */
export async function resolve(specifier, context, nextResolve) {
  const isRelative = specifier.startsWith("./") || specifier.startsWith("../");

  if (isRelative && specifier.endsWith(".js")) {
    const parent = context.parentURL ?? "";

    if (parent.includes("/src/")) {
      const candidate = `${specifier.slice(0, -3)}.ts`;

      try {
        return await nextResolve(candidate, context);
      } catch {
        // 真正的 .js 文件，回落到原始说明符
      }
    }
  }

  return nextResolve(specifier, context);
}
