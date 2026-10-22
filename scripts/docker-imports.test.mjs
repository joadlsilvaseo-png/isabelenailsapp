import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "infra/backend/src");
test("modified availability modules import only files included by the Docker context", async () => {
  const files = ["agendamentoRegras.mjs", "pixDisponibilidade.js", "pixDisponibilidadeApi.js"];
  const localImport = /(?:from\s*["']|import\(\s*["'])(\.{1,2}\/[^"']+)["']/g;
  for (const name of files) {
    const file = path.join(src, name);
    const content = await readFile(file, "utf8");
    for (const match of content.matchAll(localImport)) {
      const resolved = path.resolve(path.dirname(file), match[1]);
      assert.ok(resolved.startsWith(src + path.sep), `${name} importa fora de src: ${match[1]}`);
      assert.ok(await stat(resolved).then(() => true, () => false), `Import local não resolvido em ${name}: ${match[1]}`);
    }
  }
});
