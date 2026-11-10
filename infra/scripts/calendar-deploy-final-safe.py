#!/usr/bin/env python3
"""Upgrade final Calendar: substituir SOMENTE a imagem atual dfd5e0f2bf53 da API.

Preserva os SETE arquivos Compose atualmente efetivos. Nao modifica flags,
volumes, banco, Firebase ou PIX. Sem saude, retorna aos sete Compose.
Nao imprime segredos, tokens, URLs privadas nem ambiente Docker.
"""
import copy
from datetime import datetime, timezone
import hashlib
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import time
from urllib.request import urlopen

OLD_TAG = "isabele-nails-api:calendar-stage-dfd5e0f2bf53"
NEW_SHA = sys.argv[2] if len(sys.argv) == 3 else ""
NEW_TAG = "isabele-nails-api:calendar-stage-" + NEW_SHA[:12]
API = "isabele-infra-api-1"
PROJECT = "isabele-infra"
ROOT = "/opt/isabele-nails-backups/pix-update-20261107T205713Z-2709330"
COMPOSE_FILES = [
    ROOT + "/effective-before.yaml",
    ROOT + "/update-compose.yaml",
    "/opt/isabele-oauth-stage-KKTWRW/compose.oauth.yaml",
    "/root/.config/isabele-google-oauth/compose.enable.yaml",
    "/root/.config/isabele-google-oauth/calendar-stage-deploy-ac45382d3717.yaml",
    "/root/.config/isabele-google-oauth/calendar-stage-deploy-3b5e9b72c4eb.yaml",
    "/root/.config/isabele-google-oauth/calendar-stage-deploy-dfd5e0f2bf53.yaml",
]
NEW_OVERRIDE = Path(
    "/root/.config/isabele-google-oauth/calendar-stage-deploy-" + NEW_SHA[:12] + ".yaml"
)
FLAGS_OFF = [
    "GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED",
    "GOOGLE_CALENDAR_CUTOVER_QUEUE_ENABLED",
    "GOOGLE_CALENDAR_CUTOVER_WORKER_ENABLED",
    "GOOGLE_CALENDAR_DIRECT_CRIAR_PIX_ENABLED",
    "GOOGLE_CALENDAR_DIRECT_CANCELAR_ENABLED",
    "GOOGLE_CALENDAR_DIRECT_REAGENDAR_PAGO_ENABLED",
    "GOOGLE_CALENDAR_DIRECT_REAGENDAR_ISENTO_ENABLED",
    "GOOGLE_CALENDAR_DIRECT_ALTERAR_SERVICO_ENABLED",
    "GOOGLE_CALENDAR_LEGACY_LINKS_APPLY_ENABLED",
    "GOOGLE_CALENDAR_AUDIT_ENABLED",
]
COMPOSE = ["docker", "compose", "-p", PROJECT, "--project-directory", ROOT]
for file in COMPOSE_FILES:
    COMPOSE.extend(("-f", file))
TARGET = COMPOSE + ["-f", str(NEW_OVERRIDE)]


class Blocked(Exception):
    pass


def command(args, *, strict=True):
    process = subprocess.run(args, text=True, capture_output=True)
    if strict and process.returncode:
        # docker compose pode incluir segredos em stderr; nunca imprimir.
        raise Blocked("Falha no Docker/Compose (%s)." % process.returncode)
    return process


def load(args):
    try:
        return json.loads(command(args).stdout)
    except (ValueError, TypeError) as e:
        raise Blocked("JSON de Docker/Compose invalido.") from e


def inspect():
    data = load(["docker", "inspect", API])
    if not isinstance(data, list) or len(data) != 1:
        raise Blocked("Container da API nao localizado.")
    return data[0]


def image(tag):
    data = load(["docker", "image", "inspect", tag])
    if not isinstance(data, list) or len(data) != 1:
        raise Blocked("Imagem esperada nao localizada.")
    return data[0]


def environment(container):
    return dict(item.split("=", 1) for item in container["Config"]["Env"] if "=" in item)


def health():
    try:
        with urlopen("http://127.0.0.1:3001/health", timeout=3) as resp:
            return resp.status == 200 and json.load(resp).get("status") == "online"
    except Exception:
        return False


def compose_config(cmd):
    return load(cmd + ["config", "--format", "json"])


def expected_labels(container):
    labels = container["Config"].get("Labels") or {}
    if labels.get("com.docker.compose.project") != PROJECT:
        raise Blocked("Container nao pertence ao Compose esperado.")
    if labels.get("com.docker.compose.project.working_dir") != ROOT:
        raise Blocked("Diretorio de projeto mudou: interromper.")
    configured_files = labels.get("com.docker.compose.project.config_files", "")
    if configured_files.split(",") != COMPOSE_FILES:
        raise Blocked("Lista de Compose da API foi alterada: interromper.")


def verify_unchanged_environment(config, current):
    env = config["services"]["api"].get("environment", {})
    existing = environment(current)
    different = [key for key, value in env.items()
                 if existing.get(key) != ("" if value is None else str(value))]
    if different:
        # Apenas NOMES de flags nao-secretas, sem expor qualquer valor.
        raise Blocked("Ambiente do Compose difere do container: "
                      + ", ".join(sorted(different)))
    if any(existing.get(flag) != "false" for flag in FLAGS_OFF):
        raise Blocked("Uma flag de escrita direta esta ligada/ausente.")
    if existing.get("GOOGLE_CALENDAR_OAUTH_ENABLED") != "true":
        raise Blocked("OAuth nao esta ativo.")
    if existing.get("PIX_CALENDAR_WORKER_ENABLED") != "true":
        raise Blocked("Worker GAS/PIX nao esta ativo.")
    if existing.get("GOOGLE_CALENDAR_FRONTEND_PWA_READY") == "true":
        raise Blocked("Flag PWA de cutover nao deveria estar ativa.")


def record_backup(container):
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    directory = Path("/opt/isabele-nails-backups/calendar-upgrade-" + timestamp)
    directory.mkdir(mode=0o700, parents=True, exist_ok=False)
    record = {
        "dataUTC": timestamp,
        "imagemAnterior": OLD_TAG,
        "digestImagemAnterior": container["Image"],
        "novaImagem": NEW_TAG,
        "novaRevisao": NEW_SHA,
        "compose": [
            {"path": p, "sha256": hashlib.sha256(Path(p).read_bytes()).hexdigest()}
            for p in COMPOSE_FILES
        ],
        "override": {"path": str(NEW_OVERRIDE),
                     "sha256": hashlib.sha256(NEW_OVERRIDE.read_bytes()).hexdigest()},
        "rollback": "usar SETE Compose anteriores (sem novo override); recriar SOMENTE api",
    }
    filename = directory / "registro.json"
    with filename.open("x", encoding="utf-8") as stream:
        json.dump(record, stream, indent=2)
    filename.chmod(0o600)
    print("REGISTRO_ROLLBACK=" + str(filename))


def recreate(args):
    return command(args + ["up", "-d", "--no-deps", "--no-build",
                           "--force-recreate", "api"], strict=False).returncode == 0


def wait_ready(tag, repetitions=20):
    for _ in range(repetitions):
        try:
            current = inspect()
            if current["Config"]["Image"] == tag and current["State"]["Running"] and health():
                return current
        except Exception:
            pass
        time.sleep(2)
    return None


def rollback():
    print("NOVO_DEPLOY_FALHOU: restaurando API anterior.")
    if not recreate(COMPOSE):
        print("ROLLBACK_FALHOU: Compose anterior nao iniciou a API.")
        return False
    previous = wait_ready(OLD_TAG)
    if previous is None:
        print("ROLLBACK_INCONCLUSIVO: API anterior nao confirmou HTTP 200.")
        return False
    print("ROLLBACK_OK")
    return True


def main():
    if (len(sys.argv) != 3 or sys.argv[1] not in ("--preflight", "--deploy")
            or not re.fullmatch(r"[a-f0-9]{40}", NEW_SHA)):
        raise Blocked("Uso: script --preflight|--deploy SHA40.")
    if os.geteuid() != 0:
        raise Blocked("Executar como root.")
    mode = sys.argv[1]
    for file in COMPOSE_FILES:
        if not Path(file).is_file():
            raise Blocked("Arquivo Compose esperado ausente.")
    current = inspect()
    if current["Config"]["Image"] != OLD_TAG or not current["State"]["Running"]:
        raise Blocked("API atual nao esta na imagem esperada.")
    expected_labels(current)
    if image(OLD_TAG)["Id"] != current["Image"]:
        raise Blocked("Tag antiga nao corresponde ao digest atual; rollback inseguro.")
    new = image(NEW_TAG)
    if new["Config"].get("Labels", {}).get(
        "org.opencontainers.image.revision"
    ) != NEW_SHA:
        raise Blocked("Nova imagem nao corresponde ao SHA fixado.")
    if not health():
        raise Blocked("API atual nao esta saudavel.")

    original = compose_config(COMPOSE)
    if original.get("name") != PROJECT or set(original.get("services", {})) != {"api", "postgres"}:
        raise Blocked("Configuracao efetiva Compose inesperada.")
    if original["services"]["api"].get("image") != OLD_TAG:
        raise Blocked("Imagem do Compose antigo nao corresponde ao container.")
    verify_unchanged_environment(original, current)

    # Apenas imagem! Nao definir outras variaveis de ambiente no override.
    content = "services:\n  api:\n    image: " + NEW_TAG + "\n"
    if NEW_OVERRIDE.exists():
        if NEW_OVERRIDE.read_text(encoding="utf-8") != content:
            raise Blocked("Override de upgrade preexistente e diferente.")
    else:
        NEW_OVERRIDE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with NEW_OVERRIDE.open("x", encoding="utf-8") as stream:
            stream.write(content)
        NEW_OVERRIDE.chmod(0o600)

    target = compose_config(TARGET)
    expected = copy.deepcopy(original)
    expected["services"]["api"]["image"] = NEW_TAG
    if target != expected:
        raise Blocked("Nova configuracao difere alem da tag da API.")

    print("PREFLIGHT_OK")
    print("Imagem anterior:", OLD_TAG)
    print("Imagem nova:", NEW_TAG)
    print("Compose: 7 anteriores + 1 override somente para tag")
    print("Flags diretas: desligadas")
    print("PostgreSQL: fora do escopo")
    if mode == "--preflight":
        print("CONTAINER_PRODUCAO_INALTERADO")
        return

    record_backup(current)
    print("=== RECRIAR SOMENTE API (breve indisponibilidade possivel) ===")
    if not recreate(TARGET):
        if not rollback():
            raise Blocked("Deploy falhou e rollback nao confirmado.")
        raise Blocked("Deploy falhou; rollback confirmado.")
    updated = wait_ready(NEW_TAG)
    if updated is None:
        if not rollback():
            raise Blocked("Nova API sem saude e rollback nao confirmado.")
        raise Blocked("Nova API sem saude; rollback confirmado.")
    try:
        verify_unchanged_environment(target, updated)
        oldenv = environment(current)
        newenv = environment(updated)
        if any(newenv.get(key) != oldenv.get(key)
               for key in original["services"]["api"]["environment"]):
            raise Blocked("Ambiente de producao mudou no upgrade.")
        labels = updated["Config"].get("Labels") or {}
        files = labels.get("com.docker.compose.project.config_files", "").split(",")
        if files != COMPOSE_FILES + [str(NEW_OVERRIDE)]:
            raise Blocked("Lista Compose do container atualizado diverge.")
    except Blocked:
        if not rollback():
            raise Blocked("Validacao apos deploy falhou; rollback nao confirmado.")
        raise Blocked("Validacao apos deploy falhou; rollback confirmado.")

    print("UPGRADE_API_OK")
    print("SAUDE_HTTP_200")
    print("CONFIGURACOES_PRESERVADAS")
    print("GOOGLE_DIRECT_WRITE_DESATIVADO")
    print("POSTGRES_NAO_RECRIADO")


if __name__ == "__main__":
    try:
        main()
    except Blocked as exc:
        print("BLOQUEADO:", str(exc), file=sys.stderr)
        sys.exit(1)
