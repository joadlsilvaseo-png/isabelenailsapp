/**
 * Valida a migração 020 com PostgreSQL 17 isolado do GitHub Actions.
 * Nunca conecta à produção: exige uma URL de teste explícita.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";

const url = process.env.PGTEST_URL;
if (!url) throw new Error("PGTEST_URL é obrigatório; nunca use a conexão da VPS para este teste.");
const conn = new pg.Client({ connectionString: url, ssl: false });
const op = "11111111-1111-4111-8111-111111111111";

await conn.connect();
try {
  const migration = await readFile(
    new URL("../../migrations/020_agendamento_alteracoes_servico.sql", import.meta.url),
    "utf8",
  );
  // Idempotência do DDL: aplicar a migração duas vezes não apaga operações.
  await conn.query(migration);
  await conn.query(migration);

  const columns = await conn.query(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'agendamento_alteracoes_servico'
  `);
  assert.equal(columns.rowCount, 27, "O preflight exige 27 colunas");
  assert.deepEqual(
    columns.rows.find((c) => c.column_name === "nome_cliente"),
    { column_name: "nome_cliente", data_type: "text", is_nullable: "YES" },
  );

  await conn.query(`
    INSERT INTO public.agendamento_alteracoes_servico
      (operation_id, agendamento_id, admin_uid, servico_novo_id)
    VALUES ($1, 'agendamento-ci', 'admin-ci', 'servico-novo')
  `, [op]);

  // Mesmo UPDATE e campos usados por gravarSnapshotOperacao no backend.
  const changed = await conn.query(`
    UPDATE public.agendamento_alteracoes_servico
    SET cliente_uid = $2, nome_cliente = $3, data_servico = $4,
        inicio_minuto = $5, calendar_event_id = $6,
        servico_anterior_id = $7, servico_anterior_nome = $8,
        duracao_anterior = $9, preco_anterior_centavos = $10,
        servico_novo_nome = $11, duracao_nova = $12,
        preco_novo_centavos = $13, sinal_pago_centavos = $14,
        restante_novo_centavos = GREATEST(0, $13 - $14),
        atualizado_em = NOW()
    WHERE operation_id = $1 AND estado IN ('solicitada', 'processando')
    RETURNING nome_cliente, restante_novo_centavos, estado, calendar_estado
  `, [
    op, "cliente-ci", "Cliente fictícia CI", "2026-11-05", 660, "evt_agendamento-ci",
    "servico-antigo", "Serviço anterior", 120, 20000, "Serviço novo", 60, 12500, 5000,
  ]);
  assert.equal(changed.rowCount, 1);
  assert.equal(changed.rows[0].nome_cliente, "Cliente fictícia CI");
  assert.equal(Number(changed.rows[0].restante_novo_centavos), 7500);
  assert.equal(changed.rows[0].estado, "solicitada");
  assert.equal(changed.rows[0].calendar_estado, "pendente");

  const indexes = await conn.query(`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'agendamento_alteracoes_servico'
  `);
  for (const name of [
    "agendamento_alteracoes_servico_pkey",
    "idx_agendamento_alteracoes_servico_pendentes",
    "idx_agendamento_alteracoes_servico_agendamento",
  ]) assert.ok(indexes.rows.some((x) => x.indexname === name), name);

  console.log("Migração 020 validada no PostgreSQL real: 27 colunas, UPDATE financeiro e índices.");
} finally {
  await conn.end();
}
