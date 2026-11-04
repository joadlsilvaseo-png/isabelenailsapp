import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  iniciarReagendamentoPixPago,
  processarProximoReagendamentoPixPago,
  consultarReagendamentoPixPago,
} from "../src/pixReagendamentoPagoOperacao.js";

const { Pool } = pg;
const UID = "cliente_pg17";
const ADMIN = "admin_pg17";
const SERVICO = "manicure";
const CLIENTE = "Cliente Fictícia";

function firestoreFicticio() {
  const documentos = new Map();
  let falharTransacao = false;

  function snap(dados) {
    return { exists: Boolean(dados), data: () => dados && structuredClone(dados) };
  }
  function collection(nome) {
    return {
      doc(id) {
        return { path: nome + "/" + id, id, get: async () => snap(documentos.get(nome + "/" + id)) };
      },
      where(campo, _operador, valor) {
        return {
          kind: "query",
          async get() {
            return { docs: [...documentos.entries()].filter(([key, value]) =>
              key.startsWith(nome + "/") && value[campo] === valor).map(([key, value]) => ({
              id: key.slice(nome.length + 1), data: () => structuredClone(value),
            })) };
          },
          campo, valor, nome,
        };
      },
    };
  }

  const db = {
    collection,
    documentos,
    falharProximaTransacao() { falharTransacao = true; },
    async runTransaction(fn) {
      const draft = new Map([...documentos.entries()].map(([key, value]) => [key, structuredClone(value)]));
      const tx = {
        async get(ref) {
          if (ref.kind === "query") {
            const docs = [...draft.entries()].filter(([key, value]) =>
              key.startsWith(ref.nome + "/") && value[ref.campo] === ref.valor).map(([key, value]) => ({
              id: key.slice(ref.nome.length + 1), data: () => structuredClone(value),
            }));
            return { docs };
          }
          return snap(draft.get(ref.path));
        },
        update(ref, changes) {
          const atual = draft.get(ref.path);
          if (!atual) throw new Error("Documento inexistente");
          const novo = { ...atual, ...changes };
          for (const [key, value] of Object.entries(novo)) {
            if (value === "__DELETE__") delete novo[key];
          }
          draft.set(ref.path, novo);
        },
      };
      const result = await fn(tx);
      if (falharTransacao) {
        falharTransacao = false;
        throw new Error("Firestore fictício indisponível");
      }
      for (const [key, value] of draft) documentos.set(key, value);
      return result;
    },
  };
  return db;
}

const FieldValue = {
  serverTimestamp: () => "SIMULADO",
  delete: () => "__DELETE__",
};

async function criarAgendamento(pool, db, {
  id, dataOrigem, horarioOrigem, duracao = 60,
}) {
  const charge = randomUUID();
  const reserva = randomUUID();
  await pool.query(
    "INSERT INTO public.pix_cobrancas (id,cliente_uid,agendamento_id,estado) VALUES ($1,$2,$3,'paga')",
    [charge, UID, id],
  );
  const inicio = Number(horarioOrigem.slice(0, 2)) * 60 + Number(horarioOrigem.slice(3));
  await pool.query(
    "INSERT INTO public.pix_reservas (id,cliente_uid,servico_id,data_servico,inicio_minuto,fim_minuto,estado,vence_em,cobranca_id,agendamento_id) VALUES ($1,$2,$3,$4,$5,$6,'confirmada',NOW(),$7,$8)",
    [reserva, UID, SERVICO, dataOrigem, inicio, inicio + duracao, charge, id],
  );
  await pool.query(
    "INSERT INTO public.pix_calendar_outbox(event_id,agendamento_id,status) VALUES ($1,$2,'enviado')",
    ["evt_" + id, id],
  );
  const documento = {
    clienteId: UID, nomeCliente: CLIENTE, servico: "Manicure",
    idServico: SERVICO, data: dataOrigem, horario: horarioOrigem,
    duracao, duracaoSnapshot: duracao, status: "confirmado",
    calendarEventId: "evt_" + id, pixCobrancaId: charge,
    pixReservaId: reserva, pixStatusFinanceiro: "pago",
    valorSinalCentavos: 5000, valorRestanteCentavos: 3000,
  };
  db.documentos.set("agendamentos/" + id, documento);
  return { documento, charge, reserva };
}

function iniciar(pool, db, id, documento, op, data, horario) {
  return iniciarReagendamentoPixPago({
    pool, firestore: db, uid: ADMIN, agendamentoId: id,
    servicoId: SERVICO, data, horario, duracao: documento.duracao,
    servico: { nome: "Manicure" }, agendamento: documento,
    operationId: op,
    dependencies: { possuiBloqueio: async () => false },
  });
}

test("PostgreSQL 17: saga PIX protege os intervalos, preserva pagamento e recupera falhas", async (t) => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  t.after(async () => pool.end());
  const db = firestoreFicticio();
  let chamadasCalendar = 0;
  const deps = {
    firestore: db, FieldValue,
    async enviarCalendar(payload) {
      chamadasCalendar++;
      assert.equal(payload.acao, "REAGENDAR");
      assert.match(payload.eventId, /^evt_/);
      return { ok: true, status: "REAGENDADO", eventId: payload.eventId };
    },
  };

  // Origem e destino em dias distintos: reservar AMBOS antes do Calendar.
  const primeiro = await criarAgendamento(pool, db, {
    id: "pago01", dataOrigem: "2027-03-10", horarioOrigem: "10:00",
  });
  const op = randomUUID();
  const criado = await iniciar(pool, db, "pago01", primeiro.documento, op, "2027-03-12", "14:00");
  assert.equal(criado.estado, "solicitada");
  const original = await pool.query("SELECT * FROM public.pix_reservas WHERE id=$1", [primeiro.reserva]);
  assert.equal(original.rows[0].inicio_minuto, 600);
  const holds = await pool.query(
    "SELECT * FROM public.pix_reservas WHERE agendamento_id=$1", ["pix_reag_hold_" + op],
  );
  assert.equal(holds.rowCount, 1);
  assert.equal(holds.rows[0].cobranca_id, null);
  assert.equal(holds.rows[0].estado, "confirmada");
  await assert.rejects(
    iniciar(pool, db, "pago01", primeiro.documento, randomUUID(), "2027-03-13", "13:00"),
    /reagendamento em processamento/i,
  );
  const repetido = await iniciar(pool, db, "pago01", primeiro.documento, op, "2027-03-12", "14:00");
  assert.equal(repetido.operationId, op);
  const sucesso = await processarProximoReagendamentoPixPago(pool, deps);
  assert.equal(sucesso.estado, "concluida");
  assert.equal(chamadasCalendar, 1);
  const reservaPos = await pool.query(
    "SELECT TO_CHAR(data_servico,'YYYY-MM-DD') AS data_iso,* FROM public.pix_reservas WHERE id=$1",
    [primeiro.reserva],
  );
  assert.equal(reservaPos.rows[0].data_iso, "2027-03-12");
  assert.equal(reservaPos.rows[0].inicio_minuto, 840);
  assert.equal(reservaPos.rows[0].cobranca_id, primeiro.charge);
  assert.equal((await pool.query("SELECT * FROM public.pix_reservas WHERE agendamento_id=$1", ["pix_reag_hold_" + op])).rowCount, 0);
  const doc = db.documentos.get("agendamentos/pago01");
  assert.equal(doc.status, "reagendado");
  assert.equal(doc.calendarEventId, "evt_pago01");
  assert.equal(doc.pixCobrancaId, primeiro.charge);
  assert.equal(doc.valorSinalCentavos, 5000);
  assert.equal(doc.valorRestanteCentavos, 3000);
  assert.equal("reagendamentoPixOperacaoPendente" in doc, false);
  assert.equal((await pool.query("SELECT estado FROM public.pix_cobrancas WHERE id=$1", [primeiro.charge])).rows[0].estado, "paga");
  assert.equal((await consultarReagendamentoPixPago({ pool, uid: UID, operationId: op })).estado, "concluida");

  // Horários parcialmente sobrepostos: a mesma reserva protege a união.
  const segundo = await criarAgendamento(pool, db, {
    id: "pago02", dataOrigem: "2027-03-16", horarioOrigem: "10:00",
  });
  const op2 = randomUUID();
  await iniciar(pool, db, "pago02", segundo.documento, op2, "2027-03-16", "10:30");
  assert.equal((await pool.query("SELECT inicio_minuto, fim_minuto FROM public.pix_reservas WHERE id=$1", [segundo.reserva])).rows[0].fim_minuto, 690);
  assert.equal((await pool.query("SELECT * FROM public.pix_reservas WHERE agendamento_id=$1", ["pix_reag_hold_" + op2])).rowCount, 0);
  await processarProximoReagendamentoPixPago(pool, deps);
  const nova = (await pool.query("SELECT inicio_minuto,fim_minuto FROM public.pix_reservas WHERE id=$1", [segundo.reserva])).rows[0];
  assert.deepEqual({ inicio: nova.inicio_minuto, fim: nova.fim_minuto }, { inicio: 630, fim: 690 });

  // Firestore falha DEPOIS da resposta Calendar; repetir não dispara Calendar novamente.
  const terceiro = await criarAgendamento(pool, db, {
    id: "pago03", dataOrigem: "2027-03-18", horarioOrigem: "10:00",
  });
  const op3 = randomUUID();
  await iniciar(pool, db, "pago03", terceiro.documento, op3, "2027-03-19", "14:00");
  db.falharProximaTransacao();
  const calendarioAntes = chamadasCalendar;
  const pendente = await processarProximoReagendamentoPixPago(pool, deps);
  assert.equal(pendente.estado, "pendente");
  assert.equal(chamadasCalendar, calendarioAntes + 1);
  const estadoPendente = (await pool.query("SELECT estado FROM public.pix_reagendamentos_pagos WHERE operation_id=$1", [op3])).rows[0];
  assert.equal(estadoPendente.estado, "calendar_enviado");
  assert.equal(db.documentos.get("agendamentos/pago03").data, "2027-03-18");
  await pool.query("UPDATE public.pix_reagendamentos_pagos SET proxima_tentativa_em=NOW(), bloqueado_ate=NULL WHERE operation_id=$1", [op3]);
  const retomada = await processarProximoReagendamentoPixPago(pool, deps);
  assert.equal(retomada.estado, "concluida");
  assert.equal(chamadasCalendar, calendarioAntes + 1, "Calendar não é chamado duas vezes após confirmação gravada");
  assert.equal(db.documentos.get("agendamentos/pago03").data, "2027-03-19");
  assert.equal((await pool.query("SELECT estado FROM public.pix_cobrancas WHERE id=$1", [terceiro.charge])).rows[0].estado, "paga");

  // Falha do Apps Script antes da confirmação: a origem e o destino
  // permanecem protegidos e o Firestore não é modificado.
  const quarto = await criarAgendamento(pool, db, {
    id: "pago04", dataOrigem: "2027-03-21", horarioOrigem: "10:00",
  });
  const op4 = randomUUID();
  await iniciar(pool, db, "pago04", quarto.documento, op4, "2027-03-22", "14:00");
  const calendarAntesFalha = chamadasCalendar;
  const falhaCalendar = await processarProximoReagendamentoPixPago(pool, {
    ...deps,
    enviarCalendar: async () => { throw new Error("Calendar fictício indisponível"); },
  });
  assert.equal(falhaCalendar.estado, "pendente");
  assert.equal(db.documentos.get("agendamentos/pago04").data, "2027-03-21");
  assert.equal((await pool.query("SELECT * FROM public.pix_reservas WHERE agendamento_id=$1", ["pix_reag_hold_" + op4])).rowCount, 1);
  await pool.query("UPDATE public.pix_reagendamentos_pagos SET proxima_tentativa_em=NOW(), bloqueado_ate=NULL WHERE operation_id=$1", [op4]);
  const retomadaCalendar = await processarProximoReagendamentoPixPago(pool, deps);
  assert.equal(retomadaCalendar.estado, "concluida");
  assert.equal(chamadasCalendar, calendarAntesFalha + 1);

  // Falha de escrita PostgreSQL DEPOIS de atualizar o Firestore: o worker
  // retoma a transação sem reenviar REAGENDAR nem criar nova cobrança.
  const quinto = await criarAgendamento(pool, db, {
    id: "pago05", dataOrigem: "2027-03-23", horarioOrigem: "10:00",
  });
  const op5 = randomUUID();
  await iniciar(pool, db, "pago05", quinto.documento, op5, "2027-03-25", "14:00");
  await pool.query(`CREATE OR REPLACE FUNCTION impedir_commit_pix_teste()
    RETURNS trigger AS $func$ BEGIN
      IF OLD.cobranca_id IS NOT NULL AND NEW.data_servico = DATE '2027-03-25'
         AND OLD.data_servico <> NEW.data_servico THEN
        RAISE EXCEPTION 'simulated pg move failure';
      END IF;
      RETURN NEW;
    END $func$ LANGUAGE plpgsql`);
  await pool.query("CREATE TRIGGER teste_falha_pix BEFORE UPDATE ON public.pix_reservas FOR EACH ROW EXECUTE FUNCTION impedir_commit_pix_teste()");
  const antesFalhaPg = chamadasCalendar;
  const falhaPg = await processarProximoReagendamentoPixPago(pool, deps);
  assert.equal(falhaPg.estado, "pendente");
  assert.equal(chamadasCalendar, antesFalhaPg + 1);
  assert.equal(db.documentos.get("agendamentos/pago05").data, "2027-03-25");
  assert.equal((await pool.query("SELECT TO_CHAR(data_servico,'YYYY-MM-DD') AS data_iso FROM public.pix_reservas WHERE id=$1", [quinto.reserva])).rows[0].data_iso, "2027-03-23");
  assert.equal((await pool.query("SELECT * FROM public.pix_reservas WHERE agendamento_id=$1", ["pix_reag_hold_" + op5])).rowCount, 1);
  await pool.query("DROP TRIGGER teste_falha_pix ON public.pix_reservas");
  await pool.query("DROP FUNCTION impedir_commit_pix_teste()");
  await pool.query("UPDATE public.pix_reagendamentos_pagos SET proxima_tentativa_em=NOW(), bloqueado_ate=NULL WHERE operation_id=$1", [op5]);
  const retomadaPg = await processarProximoReagendamentoPixPago(pool, deps);
  assert.equal(retomadaPg.estado, "concluida");
  assert.equal(chamadasCalendar, antesFalhaPg + 1, "não duplica chamadas após atualização Calendar confirmada");
  assert.equal((await pool.query("SELECT TO_CHAR(data_servico,'YYYY-MM-DD') AS data_iso FROM public.pix_reservas WHERE id=$1", [quinto.reserva])).rows[0].data_iso, "2027-03-25");

  const cobrancas = await pool.query("SELECT COUNT(*)::int AS n FROM public.pix_cobrancas");
  assert.equal(cobrancas.rows[0].n, 5, "nenhuma nova cobrança foi criada pelo reagendamento");
});
