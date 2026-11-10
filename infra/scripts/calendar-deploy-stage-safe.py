#!/usr/bin/env python3
"""Deploy controlado de imagem já construída, mantendo quatro Compose e rollback.

Não lê nem imprime valores de segredos; compara valores em memória.
Só recria serviço API, com --no-deps --no-build, flags diretas explicitamente off.
Não toca no banco, Firebase ou eventos de calendário.
"""
import copy
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request

API = "isabele-infra-api-1"
OLD_TAG = "isabele-nails-api:oauth-stage-529a91d3"
STAGE_SHA = "ac45382d37175e9dbfca597c6d1e63a34b4f247e"
STAGE_TAG = "isabele-nails-api:calendar-stage-ac45382d3717"
ROOT = "/opt/isabele-nails-backups/pix-update-20261107T205713Z-2709330"
COMPOSE_FILES = [
    ROOT + "/effective-before.yaml",
    ROOT + "/update-compose.yaml",
    "/opt/isabele-oauth-stage-KKTWRW/compose.oauth.yaml",
    "/root/.config/isabele-google-oauth/compose.enable.yaml",
]
OVERRIDE = Path("/root/.config/isabele-google-oauth/calendar-stage-deploy-ac45382d3717.yaml")
SAFE_FLAGS = [
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
BASE = ["docker", "compose", "-p", "isabele-infra", "--project-directory", ROOT]
for name in COMPOSE_FILES:
    BASE.extend(["-f", name])
PROTECTED = BASE + ["-f", str(OVERRIDE)]


class Blocked(Exception):
    pass


def run(args, *, check=True):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if check and result.returncode:
        # Nunca imprimir stderr do docker compose config, pois pode conter
        # expansões da configuração privada.
        raise Blocked("Comando falhou (status %s): %s" % (result.returncode, args[0]))
    return result


def get_json(args):
    try:
        return json.loads(run(args).stdout)
    except (ValueError, KeyError) as exc:
        raise Blocked("Retorno Docker inesperado (JSON inválido).") from exc


def cfg(args):
    return get_json(args + ["config", "--format", "json"])


def inspect():
    data = get_json(["docker", "inspect", API])
    if not isinstance(data, list) or len(data) != 1:
        raise Blocked("Não foi possível confirmar o container.")
    return data[0]


def image(tag):
    data = get_json(["docker", "image", "inspect", tag])
    if not isinstance(data, list) or len(data) != 1:
        raise Blocked("Imagem não encontrada.")
    return data[0]


def environ(container):
    return dict(x.split("=", 1) for x in container["Config"]["Env"] if "=" in x)


def health():
    try:
        with urllib.request.urlopen("http://127.0.0.1:3001/health", timeout=3) as response:
            if response.status != 200:
                return False
            body = json.load(response)
            return body.get("status") == "online"
    except Exception:
        return False


def assert_base_equal_effective(old, existing):
    api = old["services"]["api"]
    env = api["environment"]
    current = environ(existing)
    mismatches = [key for key, value in env.items()
                  if current.get(key) != ("" if value is None else str(value))]
    if mismatches:
        raise Blocked("Ambiente Compose difere da API ativa; NÃO implantar. "
                      "Chaves divergentes: " + ", ".join(sorted(mismatches)))
    if old.get("name") != "isabele-infra":
        raise Blocked("Nome de projeto Compose inesperado.")
    if set(old["services"]) != {"postgres", "api"}:
        raise Blocked("Serviços Compose inesperados.")
    return current


def verify_new_config(original, target):
    expected = copy.deepcopy(original)
    expected["services"]["api"]["image"] = STAGE_TAG
    e = expected["services"]["api"]["environment"]
    for flag in SAFE_FLAGS:
        e[flag] = "false"
    if expected != target:
        raise Blocked("O override modificou algo além da imagem e flags de escrita.")
    newenv = target["services"]["api"]["environment"]
    if any(newenv.get(x) != "false" for x in SAFE_FLAGS):
        raise Blocked("Flag direta potencialmente ativa.")
    if newenv.get("GOOGLE_CALENDAR_OAUTH_ENABLED") != "true":
        raise Blocked("OAuth da profissional seria desativado.")
    if newenv.get("PIX_CALENDAR_WORKER_ENABLED") != "true":
        raise Blocked("Worker antigo seria alterado.")


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def backup_audit(old_container):
    name = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    directory = Path("/opt/isabele-nails-backups/calendar-deploy-" + name)
    directory.mkdir(mode=0o700, parents=True, exist_ok=False)
    record = {
        "executadoEmUTC": name,
        "tagAnterior": OLD_TAG,
        "imagemAnteriorSha": old_container["Image"],
        "tagStaging": STAGE_TAG,
        "commitStaging": STAGE_SHA,
        "composeFiles": [{"path": str(name), "sha256": sha256(name)}
                         for name in COMPOSE_FILES],
        "overrideFile": str(OVERRIDE),
        "overrideSha256": sha256(OVERRIDE),
        "rollback": "docker compose -p isabele-infra --project-directory ROOT "
                    "com os QUATRO arquivos originais: up -d --no-deps --no-build "
                    "--force-recreate api",
    }
    path = directory / "deploy-record.json"
    with path.open("x", encoding="utf-8") as file:
        json.dump(record, file, indent=2)
    path.chmod(0o600)
    print("REGISTRO_ROLLBACK=" + str(path))


def compose_up(args):
    result = run(args + ["up", "-d", "--no-deps", "--no-build",
                         "--force-recreate", "api"], check=False)
    return result.returncode == 0


def wait_healthy(expected_tag, tries=15):
    for _ in range(tries):
        try:
            item = inspect()
            if (item["Config"]["Image"] == expected_tag and
                    item["State"].get("Running") and health()):
                return item
        except Exception:
            pass
        time.sleep(2)
    return None


def rollback():
    print("ATENÇÃO: falha no novo container. Executando rollback da API anterior.")
    if not compose_up(BASE):
        print("ROLLBACK: falha ao recriar a API original. Intervenção manual necessária.")
        return False
    old = wait_healthy(OLD_TAG)
    if not old:
        print("ROLLBACK: API anterior não passou na verificação de saúde.")
        return False
    print("ROLLBACK_OK: API antiga restaurada e saudável.")
    return True


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ("--preflight", "--deploy"):
        raise Blocked("Modo obrigatório: --preflight ou --deploy")
    mode = sys.argv[1]
    if os.geteuid() != 0:
        raise Blocked("Executar como root na VPS.")
    for file in COMPOSE_FILES:
        if not Path(file).is_file():
            raise Blocked("Compose ausente: " + file)
    pre = inspect()
    if pre["Config"]["Image"] != OLD_TAG or not pre["State"].get("Running"):
        raise Blocked("A imagem do container atual não é a OAuth stage esperada.")
    if image(OLD_TAG)["Id"] != pre["Image"]:
        raise Blocked("Tag antiga não aponta mais para a imagem atual; rollback inseguro.")
    staged = image(STAGE_TAG)
    if staged.get("Config", {}).get("Labels", {}).get(
            "org.opencontainers.image.revision") != STAGE_SHA:
        raise Blocked("Imagem staging não corresponde ao SHA validado.")
    if not health():
        raise Blocked("API original não está saudável antes do deploy.")

    original = cfg(BASE)
    assert_base_equal_effective(original, pre)

    body = "services:\n  api:\n    image: " + STAGE_TAG + "\n    environment:\n"
    for flag in SAFE_FLAGS:
        body += "      " + flag + ': "false"\n'
    OVERRIDE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if OVERRIDE.exists():
        if OVERRIDE.read_text(encoding="utf-8") != body:
            raise Blocked("Override existente diferente do previsto; não sobrescrever.")
    else:
        with OVERRIDE.open("x", encoding="utf-8") as file:
            file.write(body)
        OVERRIDE.chmod(0o600)

    target = cfg(PROTECTED)
    verify_new_config(original, target)
    print("PREFLIGHT_OK")
    print("Imagem anterior:", OLD_TAG)
    print("Imagem staging:", STAGE_TAG)
    print("Compose: 4 arquivos originais + override seguro")
    print("Flags de escrita: 10 desativadas")
    print("PostgreSQL: fora do escopo de recriação")

    if mode == "--preflight":
        print("MODO_SOMENTE_LEITURA: container não foi recriado.")
        return

    backup_audit(pre)
    print("=== RECRIAR APENAS API; poderá haver breve indisponibilidade ===")
    if not compose_up(PROTECTED):
        if not rollback():
            raise Blocked("DEPLOY E ROLLBACK FALHARAM; verificar API manualmente.")
        raise Blocked("Falha ao recriar a nova API; rollback executado.")

    deployed = wait_healthy(STAGE_TAG)
    if not deployed:
        if not rollback():
            raise Blocked("API nova sem saúde e rollback não confirmado.")
        raise Blocked("API nova sem saúde; rollback executado.")
    active_env = environ(deployed)
    if (any(active_env.get(flag) != "false" for flag in SAFE_FLAGS)
            or active_env.get("GOOGLE_CALENDAR_OAUTH_ENABLED") != "true"
            or active_env.get("PIX_CALENDAR_WORKER_ENABLED") != "true"):
        if not rollback():
            raise Blocked("Flags incorretas e rollback não confirmado.")
        raise Blocked("Flags incorretas após deploy; rollback executado.")

    # Compara que a API não perdeu nenhuma variável ORIGINAL.
    before = environ(pre)
    diff = [key for key in original["services"]["api"]["environment"]
            if before.get(key) != active_env.get(key)]
    if diff:
        if not rollback():
            raise Blocked("Env original alterado e rollback não confirmado.")
        raise Blocked("Env original divergente após deploy; rollback executado.")

    print("DEPLOY_API_OK")
    print("SAUDE_HTTP_200")
    print("GAS_PIX_WORKER_PRESERVADO")
    print("OAUTH_PRESERVADO")
    print("GOOGLE_DIRECT_WRITE_DESATIVADO")
    print("POSTGRES_NAO_RECRIADO")


if __name__ == "__main__":
    try:
        main()
    except Blocked as exc:
        print("BLOQUEADO:", str(exc), file=sys.stderr)
        sys.exit(1)
