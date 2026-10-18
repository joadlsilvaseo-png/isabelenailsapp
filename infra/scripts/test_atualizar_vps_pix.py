#!/usr/bin/env python3
"""Testes locais, sem Docker, VPS, banco ou chamadas externas."""

import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "infra/scripts/atualizar-vps-pix.sh"
MIGRATION = ROOT / "infra/migrations/012_agendamento_cancelamentos.sql"
SOURCE = SCRIPT.read_text(encoding="utf-8")


def overlay_block(marker: str) -> str:
    match = re.search(
        rf"cat >\"\$[A-Z_]+\" <<EOF\n(.*?)\nEOF",
        SOURCE[SOURCE.index(marker) :],
        re.DOTALL,
    )
    if not match:
        raise AssertionError(f"Bloco YAML {marker!r} não encontrado")
    rendered = match.group(1).replace("$API_SERVICE", "api")
    return rendered


class TestAtualizacaoVpsPix(unittest.TestCase):
    def test_ambiente_production_habilitado_e_aceito_sem_docker(self):
        with tempfile.TemporaryDirectory() as temp:
            marker = Path(temp) / "docker-called"
            docker = Path(temp) / "docker"
            docker.write_text(f"#!/bin/sh\ntouch '{marker}'\n", encoding="utf-8")
            docker.chmod(0o755)
            env = os.environ.copy()
            env["PATH"] = temp + os.pathsep + env["PATH"]
            result = subprocess.run(
                ["bash", str(SCRIPT), "--test-pix-environment", "production"],
                text=True,
                capture_output=True,
                env=env,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(marker.exists(), "o modo de teste não pode chamar Docker")

    def test_ambiente_sandbox_e_aceito(self):
        result = subprocess.run(
            ["bash", str(SCRIPT), "--test-pix-environment", "test"],
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_ambiente_desconhecido_e_rejeitado(self):
        result = subprocess.run(
            ["bash", str(SCRIPT), "--test-pix-environment", "staging"],
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)

    def test_overlays_de_update_e_rollback_nao_substituem_variaveis(self):
        update = overlay_block("cat >\"$UPDATE_OVERRIDE\"")
        all_blocks = re.findall(r'cat >"\$[^\"]+" <<EOF\n(.*?)\nEOF', SOURCE, re.DOTALL)
        rollback_overlays = [block.replace("$API_SERVICE", "api") for block in all_blocks if "build: null" in block]
        self.assertEqual(len(rollback_overlays), 2, "rollback automático e manual")
        for overlay in (update, *rollback_overlays):
            service_keys = set(re.findall(r"(?m)^    ([a-z_]+):", overlay))
            self.assertTrue(service_keys)
            self.assertTrue(service_keys.isdisjoint({"environment", "volumes", "networks"}))

        base_prod = {
            "environment": {
                "MP_ENVIRONMENT": "production",
                "PIX_PRODUCTION_ORDERS_ENABLED": "true",
                "PIX_POLLING_WORKER_ENABLED": "true",
                "PIX_WEBHOOK_ENABLED": "false",
                "PIX_WEBHOOK_WORKER_ENABLED": "false",
                "MP_ACCESS_TOKEN_PRODUCTION": "secret-outside-git",
                "FIREBASE_CONFIG": "/run/secrets/firebase.json",
                "VAPID_PRIVATE_KEY": "private-key",
            },
            "volumes": ["firebase:/run/secrets/firebase.json:ro"],
            "networks": ["app-net"],
        }
        base_sandbox = {
            **base_prod,
            "environment": {
                **base_prod["environment"],
                "MP_ENVIRONMENT": "test",
                "PIX_PRODUCTION_ORDERS_ENABLED": "false",
            },
        }
        for base in (base_prod, base_sandbox):
            for overlay in (update, *rollback_overlays):
                # A Compose service overlay containing only image/build/labels
                # leaves these base service properties intact.
                service_keys = set(re.findall(r"(?m)^    ([a-z_]+):", overlay))
                self.assertNotIn("environment", service_keys)
                self.assertNotIn("volumes", service_keys)
                self.assertNotIn("networks", service_keys)
                self.assertEqual(base["environment"]["MP_ENVIRONMENT"], "production" if base is base_prod else "test")
                self.assertEqual(base["volumes"], ["firebase:/run/secrets/firebase.json:ro"])
                self.assertEqual(base["networks"], ["app-net"])

    def test_rollback_usa_snapshot_efetivo_e_nao_restabelece_banco(self):
        self.assertGreaterEqual(SOURCE.count('--file "$BACKUP_DIR/effective-before.yaml"'), 3)
        self.assertIn('up -d --no-deps "$API_SERVICE"', SOURCE)
        self.assertIn("nenhum dump foi restaurado", SOURCE)
        self.assertNotRegex(SOURCE, r"pg_restore\s|psql\s+.*-f\s+.*dump")

    def test_migracao_012_reconhece_estados_anterior_e_posterior_a_015(self):
        self.assertIn("agendamento_cancelamentos_check", SOURCE)
        self.assertIn("agendamento_cancelamentos_calendar_evento_check", SOURCE)
        self.assertIn("has_legacy_calendar_check", SOURCE)
        self.assertIn("has_015_calendar_check", SOURCE)
        self.assertIn("calendar_check_count", SOURCE)
        for scenario in ("before-015", "after-015"):
            with self.subTest(scenario=scenario):
                result = subprocess.run(
                    ["bash", str(SCRIPT), "--test-migration-012-state", scenario],
                    text=True,
                    capture_output=True,
                    check=False,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.strip(), "applied|")

    def test_migracao_012_pendente_continua_aplicavel(self):
        self.assertIn('if [[ "$MIGRATION_012_STATE" == pending ]]; then', SOURCE)
        result = subprocess.run(
            ["bash", str(SCRIPT), "--test-migration-012-state", "pending"],
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "pending|")

    def test_migracao_012_parcial_aborta_com_diagnostico_sem_segredos(self):
        result = subprocess.run(
            ["bash", str(SCRIPT), "--test-migration-012-state", "partial"],
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            result.stdout.strip(),
            "partial|colunas/tipos/nullability,constraint_calendar_evento_quantidade",
        )
        self.assertIn("Nenhuma migracao foi executada e a API nao sera parada", SOURCE)
        self.assertIn("verificacoes: $MIGRATION_012_DIAGNOSTICS", SOURCE)
        self.assertNotIn("POSTGRES_PASSWORD", result.stdout)
        self.assertNotIn("MP_ACCESS_TOKEN", result.stdout)

    def test_migracao_012_rejeita_duas_variantes_da_constraint_calendar(self):
        result = subprocess.run(
            ["bash", str(SCRIPT), "--test-migration-012-state", "ambiguous"],
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            result.stdout.strip(),
            "partial|constraint_calendar_evento_quantidade",
        )

    def test_migracao_012_preserva_verificacoes_estruturais_e_sql(self):
        self.assertIn("c.udt_name = esperado.tipo", SOURCE)
        self.assertIn("c.is_nullable = esperado.nullable", SOURCE)
        self.assertIn("has_charge_fk", SOURCE)
        self.assertIn("has_tipo_check", SOURCE)
        self.assertIn("has_estado_check", SOURCE)
        self.assertIn("has_calendar_estado_check", SOURCE)
        self.assertIn("has_calendar_tentativas_check", SOURCE)
        self.assertIn("has_tentativas_check", SOURCE)
        self.assertIn("regexp_replace(lower(pg_get_constraintdef(oid))", SOURCE)
        self.assertIn("checkcalendar_event_idisnullandcalendar_estado", SOURCE)
        self.assertIn("checkcalendar_event_idisnotnullorcalendar_estado", SOURCE)
        self.assertIn("pg_get_indexdef(i.indexrelid) LIKE '%(calendar_proxima_tentativa_em, criado_em)%'", SOURCE)
        sql = MIGRATION.read_text(encoding="utf-8")
        self.assertIn("BEGIN;", sql)
        self.assertIn("COMMIT;", sql)
        self.assertIn("CREATE TABLE IF NOT EXISTS public.agendamento_cancelamentos", sql)
        self.assertIn("CREATE INDEX IF NOT EXISTS idx_agendamento_cancelamentos_pendentes", sql)
        self.assertNotRegex(sql, r"(?im)^\s*(UPDATE|DELETE|DROP|TRUNCATE)\b")

    def test_script_nao_chama_pagamento_ou_reembolso(self):
        self.assertNotRegex(SOURCE, r"https?://api\.mercadopago\.com/.*/(orders|payments).*(refund|cancel)")
        self.assertNotRegex(SOURCE, r"(?im)^\s*(curl|wget)\b.*(orders|refund|reembolso)")
        self.assertIn("nao cria cobrancas nem solicita reembolsos", SOURCE)


if __name__ == "__main__":
    unittest.main(verbosity=2)
