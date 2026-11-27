import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const modules = resolve(
  process.env.GIGMA_NODE_MODULES || join(here, "node_modules"),
);
const require = createRequire(import.meta.url);
const esbuild = require(join(modules, "esbuild"));
const app = resolve(here, "../../src");
const editor = join(app, "gigma");
const native = join(app, "native/gigma");
const common = {
  absWorkingDir: here,
  bundle: true,
  minify: true,
  legalComments: "eof",
  nodePaths: [modules],
  logLevel: "info",
  define: { "process.env.NODE_ENV": '"production"' },
};
await mkdir(editor, { recursive: true });
await esbuild.build({
  ...common,
  entryPoints: ["src/main.tsx"],
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  target: "chrome130",
  outfile: join(editor, "editor.js"),
});
await esbuild.build({
  ...common,
  entryPoints: ["shared/assistant.ts"],
  platform: "browser",
  format: "esm",
  target: "chrome130",
  outfile: join(editor, "artwork-model.js"),
});
if (!process.argv.includes("--editor-only")) {
  await mkdir(native, { recursive: true });
  await esbuild.build({
    ...common,
    entryPoints: ["desktop/illustrator.ts"],
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile: join(native, "illustrator.cjs"),
  });
  for (const file of ["illustrator-import.jsx", "illustrator-links.jsx"])
    await copyFile(join(here, "desktop", file), join(native, file));
}
const licenses = new Map([
  ["lucide-react", ["LICENSE"]],
  ["react", ["LICENSE"]],
  ["react-dom", ["LICENSE"]],
  ["scheduler", ["LICENSE"]],
  ["zod", ["LICENSE"]],
  ["pdf-lib", ["LICENSE.md"]],
  ["@pdf-lib/standard-fonts", ["LICENSE.md"]],
  ["@pdf-lib/upng", ["LICENSE"]],
  ["pako", ["LICENSE"]],
  ["pdf-lib/node_modules/tslib", ["CopyrightNotice.txt", "LICENSE.txt"]],
]);
const notices = [
  "Gigma 0.2.9 · sunakle · https://github.com/sunakle/gigma",
  "Bundled dependencies",
];
for (const [name, files] of licenses) {
  const base = join(modules, name);
  for (const file of files)
    notices.push(
      name + "\n\n" + (await readFile(join(base, file), "utf8")).trim(),
    );
}
await writeFile(
  join(editor, "THIRD-PARTY-NOTICES.txt"),
  notices.join("\n\n") + "\n",
);
