import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../../../admin-clientes.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../../../admin-clientes.html", import.meta.url), "utf8");

test("o painel do modal é localizado por classe a partir do modal existente", () => {
  assert.match(html, /id="client-modal"/);
  assert.match(html, /class="client-modal"/);
  assert.match(source, /const modal = \$\("client-modal"\);/);
  assert.match(source, /const modalPanel = modal\.querySelector\("\.client-modal"\);/);
  assert.doesNotMatch(source, /\$\("\.client-modal"\)/);
  assert.match(source, /modalPanel\.scrollTop = 0/);
  assert.match(source, /modalPanel\.setAttribute\("aria-busy", "true"\)/);
  assert.match(source, /modalPanel\.setAttribute\("aria-busy", "false"\)/);
});
