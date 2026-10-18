#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Atualizacao incremental PIX: preserva a configuracao efetiva do Compose.
# O script preserva o ambiente PIX ativo; nao cria cobrancas nem solicita reembolsos.

BRANCH="${BRANCH:-codex/correcao-pix-20261010}"
APP_DIR="${APP_DIR:-/opt/isabele-nails}"
BACKUP_ROOT="${BACKUP_ROOT:-/opt/isabele-nails-backups}"
RELEASE_ROOT="${RELEASE_ROOT:-/opt/isabele-nails-releases}"
LOG_DIR="${LOG_DIR:-/var/log/isabele-nails-deploy}"
MODE="${1:-apply}"
SCRIPT_PATH="$(readlink -f "$0")"

timestamp() { date -u +%Y%m%dT%H%M%SZ; }
die() { echo "ERRO: $*" >&2; exit 1; }

classificar_estado_migracao_012() {
  local has_charge_table="$1" has_table="$2" has_columns="$3"
  local has_primary_key="$4" has_defaults="$5" has_charge_fk="$6"
  local has_tipo_check="$7" has_estado_check="$8" has_calendar_estado_check="$9"
  local has_calendar_tentativas_check="${10}" has_tentativas_check="${11}"
  local has_legacy_calendar_check="${12}" has_015_calendar_check="${13}"
  local calendar_check_count="${14}" has_pending_index="${15}" has_calendar_index="${16}"
  local -a falhas=()

  if [[ "$has_charge_table" != t ]]; then
    printf 'missing_charge_table|pix_cobrancas\n'
    return
  fi
  if [[ "$has_table" != t ]]; then
    printf 'pending|\n'
    return
  fi

  [[ "$has_columns" == t ]] || falhas+=("colunas/tipos/nullability")
  [[ "$has_primary_key" == t ]] || falhas+=("chave_primaria")
  [[ "$has_defaults" == t ]] || falhas+=("valores_default")
  [[ "$has_charge_fk" == t ]] || falhas+=("foreign_key_pix_cobrancas")
  [[ "$has_tipo_check" == t ]] || falhas+=("constraint_tipo")
  [[ "$has_estado_check" == t ]] || falhas+=("constraint_estado")
  [[ "$has_calendar_estado_check" == t ]] || falhas+=("constraint_calendar_estado")
  [[ "$has_calendar_tentativas_check" == t ]] || falhas+=("constraint_calendar_tentativas")
  [[ "$has_tentativas_check" == t ]] || falhas+=("constraint_tentativas")

  if [[ "$calendar_check_count" != 1 ]]; then
    falhas+=("constraint_calendar_evento_quantidade")
  elif [[ "$has_legacy_calendar_check" == t && "$has_015_calendar_check" != t ]]; then
    : # Estrutura original da migração 012.
  elif [[ "$has_legacy_calendar_check" != t && "$has_015_calendar_check" == t ]]; then
    : # Estrutura legítima após a migração 015.
  elif [[ "$has_legacy_calendar_check" == t && "$has_015_calendar_check" == t ]]; then
    falhas+=("constraint_calendar_evento_ambigua")
  else
    falhas+=("constraint_calendar_evento_formato")
  fi

  [[ "$has_pending_index" == t ]] || falhas+=("indice_cancelamentos_pendentes")
  [[ "$has_calendar_index" == t ]] || falhas+=("indice_calendar_pendente")

  if ((${#falhas[@]} == 0)); then
    printf 'applied|\n'
  else
    local IFS=,
    printf 'partial|%s\n' "${falhas[*]}"
  fi
}

validate_pix_environment() {
  case "${1,,}" in
    test|production) return 0 ;;
    *) echo "Ambiente PIX desconhecido; use test ou production." >&2; return 1 ;;
  esac
}

# Modo local usado pela suíte automatizada. Sai antes de qualquer acesso a
# Docker, arquivos de produção, rede ou banco de dados.
if [[ "$MODE" == "--test-pix-environment" ]]; then
  [[ $# -eq 2 ]] || die "Uso: $SCRIPT_PATH --test-pix-environment test|production"
  validate_pix_environment "$2"
  exit $?
fi

# Modo local para testar o mesmo classificador usado no preflight do PostgreSQL.
if [[ "$MODE" == "--test-migration-012-state" ]]; then
  [[ $# -eq 2 ]] || die "Uso: $SCRIPT_PATH --test-migration-012-state pending|before-015|after-015|partial|ambiguous"
  case "$2" in
    pending) flags=(t f f f f f f f f f f f f 0 f f) ;;
    before-015) flags=(t t t t t t t t t t t t f 1 t t) ;;
    after-015) flags=(t t t t t t t t t t t f t 1 t t) ;;
    partial) flags=(t t f t t t t t t t t f f 0 t t) ;;
    ambiguous) flags=(t t t t t t t t t t t t t 2 t t) ;;
    *) die "Estado de teste desconhecido." ;;
  esac
  classificar_estado_migracao_012 "${flags[@]}"
  exit 0
fi

if [[ "$MODE" == "start" || "$MODE" == "--background" ]]; then
  mkdir -p "$LOG_DIR"
  chmod 750 "$LOG_DIR"
  LOG_FILE="${LOG_FILE:-$LOG_DIR/pix-update-$(timestamp).log}"
  export LOG_FILE APP_DIR BACKUP_ROOT RELEASE_ROOT LOG_DIR BRANCH
  nohup bash "$SCRIPT_PATH" apply >>"$LOG_FILE" 2>&1 </dev/null &
  echo "Atualizacao iniciada em segundo plano. PID=$!"
  echo "Log persistente: $LOG_FILE"
  exit 0
fi

mkdir -p "$LOG_DIR" "$BACKUP_ROOT"
chmod 750 "$LOG_DIR" "$BACKUP_ROOT"
LOG_FILE="${LOG_FILE:-$LOG_DIR/pix-update-$(timestamp).log}"
export LOG_FILE APP_DIR BACKUP_ROOT RELEASE_ROOT LOG_DIR BRANCH
exec >>"$LOG_FILE" 2>&1

LOCK_FILE="$LOG_DIR/pix-update.lock"
exec 9>"$LOCK_FILE"
flock -n 9 || die "Ja existe uma atualizacao PIX em andamento. Consulte $LOG_DIR."

[[ "$EUID" -eq 0 ]] || die "Execute como root para ler a configuracao ativa e preservar os arquivos/segredos."
command -v docker >/dev/null || die "Docker nao encontrado."
command -v python3 >/dev/null || die "Python 3 nao encontrado."
command -v flock >/dev/null || die "flock nao encontrado."
command -v git >/dev/null || die "Git nao encontrado."
command -v curl >/dev/null || die "curl nao encontrado para o healthcheck."
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 nao encontrado."

if [[ "$MODE" == "rollback" ]]; then
  [[ $# -ge 2 ]] || die "Uso: $SCRIPT_PATH rollback /caminho/do/backup"
  BACKUP_DIR="$2"
  [[ -d "$BACKUP_DIR" && -s "$BACKUP_DIR/effective-before.yaml" && -s "$BACKUP_DIR/old-api-image-id" ]] || die "Backup incompleto: $BACKUP_DIR"
  PROJECT_NAME="$(<"$BACKUP_DIR/compose-project")"
  API_SERVICE="$(<"$BACKUP_DIR/api-service")"
  PROJECT_WORKDIR="$(<"$BACKUP_DIR/compose-working-dir")"
  OLD_IMAGE_ID="$(<"$BACKUP_DIR/old-api-image-id")"
  [[ "$OLD_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || die "Imagem anterior invalida."
  OLD_IMAGE_REF_FILE="$BACKUP_DIR/old-api-image-tag"
  if [[ -s "$OLD_IMAGE_REF_FILE" ]]; then
    OLD_IMAGE_REF="$(<"$OLD_IMAGE_REF_FILE")"
    if ! docker image inspect "$OLD_IMAGE_REF" >/dev/null 2>&1; then
      docker image inspect "$OLD_IMAGE_ID" >/dev/null 2>&1 || die "Tag e imagem antiga ausentes; rollback indisponivel com este backup."
      docker image tag "$OLD_IMAGE_ID" "$OLD_IMAGE_REF"
    fi
  else
    # Compatibility for backups made before persistent rollback tags existed.
    docker image inspect "$OLD_IMAGE_ID" >/dev/null 2>&1 || die "Imagem antiga nao esta mais no cache local e este backup nao possui tag persistente."
    OLD_IMAGE_REF="isabele-nails-api:rollback-recovered-$(timestamp)"
    docker image tag "$OLD_IMAGE_ID" "$OLD_IMAGE_REF"
    printf '%s\n' "$OLD_IMAGE_REF" >"$OLD_IMAGE_REF_FILE"
    chmod 600 "$OLD_IMAGE_REF_FILE"
  fi
  docker image inspect "$OLD_IMAGE_REF" >/dev/null 2>&1 || die "Referencia persistente da imagem antiga nao encontrada: $OLD_IMAGE_REF"
  ROLLBACK_OVERRIDE="$BACKUP_DIR/rollback-compose.yaml"
  cat >"$ROLLBACK_OVERRIDE" <<EOF
services:
  $API_SERVICE:
    image: "$OLD_IMAGE_REF"
    build: null
EOF
  chmod 600 "$ROLLBACK_OVERRIDE"
  docker compose --project-directory "$PROJECT_WORKDIR" --project-name "$PROJECT_NAME" \
    --file "$BACKUP_DIR/effective-before.yaml" --file "$ROLLBACK_OVERRIDE" \
    up -d --no-deps "$API_SERVICE"
  echo "Rollback do backend e da configuracao efetiva Compose concluido."
  echo "A migracao 010 e os dados foram preservados; nenhum dump foi restaurado."
  exit 0
fi

# Localiza o projeto/container em execucao sem assumir arquivos Compose. As labels
# do container registram o projeto, diretorio de trabalho e todos os -f usados.
[[ -d "$APP_DIR" ]] || die "APP_DIR nao existe: $APP_DIR"
APP_REAL="$(realpath "$APP_DIR")"
BACKUP_ROOT_REAL="$(realpath "$BACKUP_ROOT")"
mapfile -t ALL_API_CONTAINERS < <(docker ps -q --filter "label=com.docker.compose.service=api")
API_CONTAINERS=()
API_CONFIG_KINDS=()
API_RECOVERY_DIRS=()
for candidate in "${ALL_API_CONTAINERS[@]}"; do
  candidate_project="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$candidate")"
  candidate_service="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.service" }}' "$candidate")"
  [[ "$candidate_service" == "api" ]] || continue
  candidate_files="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}' "$candidate")"
  candidate_workdir="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$candidate")"
  IFS=',' read -r -a candidate_file_list <<<"$candidate_files"
  uses_original_compose=false
  recovery_dir=""
  for candidate_file in "${candidate_file_list[@]}"; do
    candidate_real="$(realpath "$candidate_file" 2>/dev/null || realpath "$candidate_workdir/$candidate_file" 2>/dev/null || realpath "$APP_REAL/$candidate_file" 2>/dev/null || true)"
    [[ -n "$candidate_real" && -f "$candidate_real" ]] || continue
    [[ "$candidate_real" == "$APP_REAL/infra/compose.yaml" ]] && uses_original_compose=true
    if [[ "$(basename "$candidate_real")" == "effective-before.yaml" ]]; then
      possible_dir="$(dirname "$candidate_real")"
      case "$candidate_real" in
        "$BACKUP_ROOT_REAL"/pix-update-*/effective-before.yaml) recovery_dir="$possible_dir" ;;
      esac
    fi
  done
  recovery_overlay=false
  if [[ -n "$recovery_dir" ]]; then
    for candidate_file in "${candidate_file_list[@]}"; do
      candidate_real="$(realpath "$candidate_file" 2>/dev/null || realpath "$candidate_workdir/$candidate_file" 2>/dev/null || realpath "$APP_REAL/$candidate_file" 2>/dev/null || true)"
      [[ "$(dirname "$candidate_real")" == "$recovery_dir" ]] || continue
      case "$(basename "$candidate_real")" in
        restore-api.yaml|rollback-compose.yaml|update-compose.yaml) recovery_overlay=true ;;
      esac
    done
  fi
  config_kind=""
  if [[ "$uses_original_compose" == true ]]; then
    config_kind="original"
  elif [[ -n "$recovery_dir" && "$recovery_overlay" == true && \
      -s "$recovery_dir/compose-project" && -s "$recovery_dir/api-service" && \
      -s "$recovery_dir/compose-working-dir" && \
      "$(<"$recovery_dir/compose-project")" == "$candidate_project" && \
      "$(<"$recovery_dir/api-service")" == "$candidate_service" && \
      "$(realpath "$(<"$recovery_dir/compose-working-dir")" 2>/dev/null || true)" == \
      "$(realpath "$candidate_workdir" 2>/dev/null || true)" ]]; then
    config_kind="recovery"
  fi
  if [[ -n "$config_kind" ]]; then
    API_CONTAINERS+=("$candidate")
    API_CONFIG_KINDS+=("$config_kind")
    API_RECOVERY_DIRS+=("$recovery_dir")
  fi
done
[[ "${#API_CONTAINERS[@]}" -eq 1 ]] || die "Esperava um container api do projeto original ou de um snapshot de recuperacao validado; encontrados ${#API_CONTAINERS[@]}. Nenhuma alteracao foi feita."
API_CONTAINER="${API_CONTAINERS[0]}"
ACTIVE_CONFIG_KIND="${API_CONFIG_KINDS[0]}"
API_RECOVERY_DIR="${API_RECOVERY_DIRS[0]}"
PROJECT_NAME="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$API_CONTAINER")"
API_SERVICE="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.service" }}' "$API_CONTAINER")"
PROJECT_WORKDIR="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$API_CONTAINER")"
CONFIG_FILES_LABEL="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}' "$API_CONTAINER")"
[[ -n "$PROJECT_NAME" && "$PROJECT_NAME" != "<no value>" ]] || die "Container sem label de projeto Compose."
[[ "$API_SERVICE" == "api" ]] || die "Servico ativo inesperado: $API_SERVICE"
[[ -n "$PROJECT_WORKDIR" && "$PROJECT_WORKDIR" != "<no value>" ]] || die "Container sem diretorio Compose registrado."
[[ -n "$CONFIG_FILES_LABEL" && "$CONFIG_FILES_LABEL" != "<no value>" ]] || die "Docker nao informou os arquivos Compose originais; cancelando para nao substituir configuracao."

IFS=',' read -r -a ORIGINAL_COMPOSE_FILES <<<"$CONFIG_FILES_LABEL"
[[ "${#ORIGINAL_COMPOSE_FILES[@]}" -ge 1 ]] || die "Nao foi possivel ler a lista de arquivos Compose ativos."
for file in "${ORIGINAL_COMPOSE_FILES[@]}"; do
  [[ -f "$file" ]] || die "Arquivo Compose ativo ausente: $file"
done

# Os Compose de origem são obrigatórios nas labels quando elas ainda apontam
# para os arquivos originais. Após rollback, os labels podem apontar para o
# snapshot/override do backup; nesse caso metadados + preflight integral validam
# a identidade e a configuração em execução.
KNOWN_COMPOSE_FILES=(
  "$APP_DIR/infra/compose.yaml" \
  "$APP_DIR/infra/compose.override.yaml" \
  "/root/isabele-codex-pix-teste-20261010-125718.compose.yaml"
)
PRESERVE_COMPOSE_FILES=("${ORIGINAL_COMPOSE_FILES[@]}")
for expected in "${KNOWN_COMPOSE_FILES[@]}"; do
  if [[ -f "$expected" ]]; then
    found=false
    for file in "${ORIGINAL_COMPOSE_FILES[@]}"; do
      file_real="$(realpath "$file" 2>/dev/null || realpath "$PROJECT_WORKDIR/$file" 2>/dev/null || realpath "$APP_REAL/$file" 2>/dev/null || true)"
      [[ "$file_real" == "$(realpath "$expected")" ]] && found=true
    done
    if [[ "$ACTIVE_CONFIG_KIND" == "original" && "$found" != true ]]; then
      die "O arquivo Compose existente nao aparece na configuracao ativa: $expected"
    fi
    if [[ "$found" != true ]]; then PRESERVE_COMPOSE_FILES+=("$expected"); fi
  fi
done

mapfile -t PROJECT_CONTAINERS < <(docker ps -q --filter "label=com.docker.compose.project=$PROJECT_NAME")
[[ "${#PROJECT_CONTAINERS[@]}" -gt 0 ]] || die "Nenhum container ativo no projeto $PROJECT_NAME."
mapfile -t DB_CONTAINERS < <(docker ps -q --filter "label=com.docker.compose.project=$PROJECT_NAME" --filter "label=com.docker.compose.service=postgres")
[[ "${#DB_CONTAINERS[@]}" -eq 1 ]] || die "Esperava um PostgreSQL ativo no projeto; encontrados ${#DB_CONTAINERS[@]}. Nenhuma alteracao foi feita."
DB_CONTAINER="${DB_CONTAINERS[0]}"
DB_SERVICE="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.service" }}' "$DB_CONTAINER")"
DB_PROJECT_NAME="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$DB_CONTAINER")"
DB_PROJECT_WORKDIR="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$DB_CONTAINER")"
[[ "$DB_SERVICE" == "postgres" && "$DB_PROJECT_NAME" == "$PROJECT_NAME" && \
   "$(realpath "$DB_PROJECT_WORKDIR" 2>/dev/null || true)" == "$(realpath "$PROJECT_WORKDIR" 2>/dev/null || true)" ]] || \
  die "O container PostgreSQL nao corresponde ao mesmo projeto/diretorio Compose da API."

[[ "$MODE" == "apply" ]] || die "Modo invalido. Use start, apply ou rollback."

git -C "$APP_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "APP_DIR nao e o checkout Git do projeto."
REMOTE_URL="$(git -C "$APP_DIR" remote get-url origin)"
case "${REMOTE_URL,,}" in
  *joadlsilvaseo-png/isabelenailsapp.git|*joadlsilvaseo-png/isabelenailsapp) ;;
  *) die "O origin de APP_DIR nao e joadlsilvaseo-png/isabelenailsapp." ;;
esac

cd "$APP_DIR"
echo "Inicio: $(date -Is)"
echo "Branch alvo: $BRANCH"
echo "Projeto Compose ativo: $PROJECT_NAME"
echo "Origem dos labels Compose validada: $ACTIVE_CONFIG_KIND${API_RECOVERY_DIR:+ ($API_RECOVERY_DIR)}"
echo "Arquivos Compose ativos: ${ORIGINAL_COMPOSE_FILES[*]}"
echo "Servico ativo: $API_SERVICE; checkout local sera preservado."
echo "Log persistente: $LOG_FILE"

# A configuracao efetiva resolvida e armazenada protegida: pode conter tokens,
# senhas, VAPID e caminhos/credenciais Firebase. Nunca e impressa no log.
BACKUP_DIR="$BACKUP_ROOT/pix-update-$(timestamp)-$$"
mkdir -m 700 "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
printf '%s\n' "$PROJECT_NAME" >"$BACKUP_DIR/compose-project"
printf '%s\n' "$API_SERVICE" >"$BACKUP_DIR/api-service"
printf '%s\n' "$PROJECT_WORKDIR" >"$BACKUP_DIR/compose-working-dir"
printf '%s\n' "$CONFIG_FILES_LABEL" >"$BACKUP_DIR/compose-files-label"
mkdir -m 700 "$BACKUP_DIR/compose-sources"
: >"$BACKUP_DIR/compose-source-manifest.txt"
index=0
for file in "${PRESERVE_COMPOSE_FILES[@]}"; do
  index=$((index + 1))
  copy_name="$(printf '%02d' "$index")-$(basename "$file")"
  cp -- "$file" "$BACKUP_DIR/compose-sources/$copy_name"
  chmod 600 "$BACKUP_DIR/compose-sources/$copy_name"
  printf '%s\t%s\n' "$file" "$copy_name" >>"$BACKUP_DIR/compose-source-manifest.txt"
done

docker inspect "$API_CONTAINER" >"$BACKUP_DIR/api-container-before.json"
docker inspect "$DB_CONTAINER" >"$BACKUP_DIR/db-container-before.json"
docker inspect "${PROJECT_CONTAINERS[@]}" >"$BACKUP_DIR/project-containers-before.json"
chmod 600 "$BACKUP_DIR/compose-source-manifest.txt" "$BACKUP_DIR/api-container-before.json" "$BACKUP_DIR/db-container-before.json" "$BACKUP_DIR/project-containers-before.json"

render_effective_compose() {
  local format="$1"
  python3 - "$BACKUP_DIR/project-containers-before.json" "$API_CONTAINER" "$PROJECT_WORKDIR" "$PROJECT_NAME" "$format" "${ORIGINAL_COMPOSE_FILES[@]}" <<'PY'
import json, os, subprocess, sys
inspect_path, api_id, workdir, project, fmt, *files = sys.argv[1:]
with open(inspect_path, encoding="utf-8") as f: containers = json.load(f)
env = os.environ.copy()
api_env = {}
for container in containers:
    values = {}
    for item in container.get("Config", {}).get("Env", []) or []:
        key, sep, value = item.partition("=")
        if sep: values[key] = value
    if container.get("Id", "").startswith(api_id): api_env = values
    else:
        for key, value in values.items(): env.setdefault(key, value)
env.update(api_env)
cmd = ["docker", "compose", "--project-directory", workdir, "--project-name", project]
for path in files: cmd.extend(["--file", path])
cmd.append("config")
if fmt == "json": cmd.extend(["--format", "json"])
result = subprocess.run(cmd, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
if result.returncode:
    sys.stderr.write(result.stderr)
    raise SystemExit(result.returncode)
sys.stdout.write(result.stdout)
PY
}

render_effective_compose yaml >"$BACKUP_DIR/effective-before.yaml"
render_effective_compose json >"$BACKUP_DIR/effective-before.json"
[[ -s "$BACKUP_DIR/effective-before.yaml" && -s "$BACKUP_DIR/effective-before.json" ]] || die "Snapshot da configuracao Compose vazio."
chmod 600 "$BACKUP_DIR"/effective-before.*

# A renderizacao precisa refletir exatamente o processo ativo. O script aborta
# antes de parar servicos se qualquer env, credencial ou volume nao corresponder.
python3 - "$BACKUP_DIR/effective-before.json" "$BACKUP_DIR/api-container-before.json" "$BACKUP_DIR/db-container-before.json" "$PROJECT_NAME" "$DB_SERVICE" <<'PY'
import json, os, sys
config_path, api_inspect_path, db_inspect_path, project, db_service_name = sys.argv[1:]
with open(config_path, encoding="utf-8") as f: config = json.load(f)
with open(api_inspect_path, encoding="utf-8") as f: api_container = json.load(f)[0]
with open(db_inspect_path, encoding="utf-8") as f: db_container = json.load(f)[0]
services = config.get("services", {})

def env_map(raw):
    raw = raw or {}
    if isinstance(raw, list):
        return dict(item.split("=", 1) if "=" in item else (item, None) for item in raw)
    return raw

def live_env_map(container):
    result = {}
    for item in container.get("Config", {}).get("Env", []) or []:
        key, sep, value = item.partition("=")
        if sep: result[key] = value
    return result

def check_env(service_name, container):
    if service_name not in services:
        raise SystemExit("Configuracao renderizada nao contem o servico " + service_name + ".")
    expected = env_map(services[service_name].get("environment"))
    actual = live_env_map(container)
    mismatches = []
    for key, value in expected.items():
        # Cada variável declarada no Compose efetivo precisa corresponder
        # exatamente ao container. Pass-through sem valor só passa se ausente.
        if value is None:
            if key in actual: mismatches.append(key)
        elif key not in actual or actual[key] != str(value):
            mismatches.append(key)
    if mismatches:
        names = ", ".join(sorted(set(mismatches)))
        raise SystemExit("Configuracao Compose diverge do container " + service_name + " (variaveis: " + names + "). Abortando sem alteracoes.")
    return actual

api_env = check_env("api", api_container)
check_env(db_service_name, db_container)

def normalized_mounts(service, container):
    configured = []
    for item in service.get("volumes", []) or []:
        if isinstance(item, str):
            parts = item.rsplit(":", 2)
            if len(parts) == 1:
                source, target, mode = "", parts[0], ""
            elif len(parts) == 2:
                source, target, mode = parts[0], parts[1], ""
            else:
                source, target, mode = parts
            typ = "bind" if source.startswith("/") or source.startswith(".") else "volume"
            ro = any("ro" in m.split(",") for m in mode)
        else:
            typ = item.get("type", "volume")
            source = item.get("source", "")
            target = item.get("target", "")
            ro = bool(item.get("read_only", False))
        if typ == "bind":
            source = os.path.realpath(source)
        elif typ == "volume" and source:
            volume = (config.get("volumes", {}) or {}).get(source, {}) or {}
            source = volume.get("name") or (source if volume.get("external") else f"{project}_{source}")
        configured.append((target, typ, source, ro))
    live = []
    for item in container.get("Mounts", []) or []:
        typ = item.get("Type", "")
        source = os.path.realpath(item.get("Source", "")) if typ == "bind" else item.get("Name", "") if typ == "volume" else ""
        live.append((item.get("Destination", ""), typ, source, not bool(item.get("RW", True))))
    return sorted(configured), sorted(live)

for service_name, container in (("api", api_container), (db_service_name, db_container)):
    configured_mounts, live_mounts = normalized_mounts(services[service_name], container)
    if configured_mounts != live_mounts:
        raise SystemExit("Volumes do Compose renderizado divergem dos mounts do container " + service_name + ". Abortando sem alteracoes.")

configured_db_image = services[db_service_name].get("image")
live_db_image = db_container.get("Config", {}).get("Image")
if configured_db_image and configured_db_image != live_db_image:
    raise SystemExit("A imagem do PostgreSQL no Compose difere do container ativo. Abortando sem alteracoes.")

print("Configuracao efetiva conferida para API e PostgreSQL: variaveis declaradas, identidade da imagem e volumes iguais aos containers ativos.")
PY

# Aceita sandbox ou produção ativa. A validação não escreve flags: o snapshot
# efetivo é a única fonte de configuração e os overlays abaixo só alteram imagem/build.
MP_ENVIRONMENT_EFFECTIVE="$(python3 - "$BACKUP_DIR/effective-before.json" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as f:
    config = json.load(f)
env = (config.get("services", {}).get("api", {}) or {}).get("environment", {}) or {}
if isinstance(env, list):
    env = dict(item.split("=", 1) if "=" in item else (item, None) for item in env)
value = env.get("MP_ENVIRONMENT")
print("test" if value in (None, "") else str(value))
PY
)"
validate_pix_environment "$MP_ENVIRONMENT_EFFECTIVE" || die "Configuracao MP_ENVIRONMENT nao suportada; abortando sem alteracoes."
echo "Ambiente PIX efetivo preservado: $MP_ENVIRONMENT_EFFECTIVE; flags financeiros permanecem inalterados."

# Salva status/diff e arquivos nao rastreados; nada e limpo nem sobrescrito.
git -C "$APP_DIR" fetch --no-tags origin "$BRANCH"
TARGET_COMMIT="$(git -C "$APP_DIR" rev-parse FETCH_HEAD)"
[[ "$TARGET_COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "Nao foi possivel resolver o commit remoto."
printf '%s\n' "$TARGET_COMMIT" >"$BACKUP_DIR/target-commit"
printf '%s\n' "$(git -C "$APP_DIR" rev-parse HEAD)" >"$BACKUP_DIR/checkout-head"
git -C "$APP_DIR" status --porcelain=v1 >"$BACKUP_DIR/git-status.txt"
git -C "$APP_DIR" diff --binary HEAD >"$BACKUP_DIR/working-tree.patch"
git -C "$APP_DIR" ls-files --others --exclude-standard -z >"$BACKUP_DIR/untracked-files.list"
if [[ -s "$BACKUP_DIR/untracked-files.list" ]]; then
  tar -C "$APP_DIR" --null -T "$BACKUP_DIR/untracked-files.list" -czf "$BACKUP_DIR/untracked-files.tar.gz"
fi
find "$BACKUP_DIR" -maxdepth 1 -type f -exec chmod 600 {} +

API_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$API_CONTAINER")"
[[ "$API_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || die "Imagem ativa da API nao identificada."
printf '%s\n' "$API_IMAGE_ID" >"$BACKUP_DIR/old-api-image-id"
OLD_API_IMAGE_TAG="isabele-nails-api:rollback-$(timestamp)-$$"
docker image tag "$API_IMAGE_ID" "$OLD_API_IMAGE_TAG"
[[ "$(docker image inspect --format '{{.Id}}' "$OLD_API_IMAGE_TAG")" == "$API_IMAGE_ID" ]] || die "Nao foi possivel criar referencia persistente para a imagem anterior."
printf '%s\n' "$OLD_API_IMAGE_TAG" >"$BACKUP_DIR/old-api-image-tag"
chmod 600 "$BACKUP_DIR/old-api-image-id" "$BACKUP_DIR/old-api-image-tag"

RELEASE_DIR="$RELEASE_ROOT/$TARGET_COMMIT"
[[ ! -e "$RELEASE_DIR" ]] || die "Release ja existe: $RELEASE_DIR"
mkdir -p "$RELEASE_ROOT"
git -C "$APP_DIR" worktree add --detach "$RELEASE_DIR" "$TARGET_COMMIT"
MIGRATION="$RELEASE_DIR/infra/migrations/010_pix_webhook_ambientes.sql"
[[ -f "$MIGRATION" ]] || die "Migracao 010 nao encontrada no commit alvo."
MIGRATION_011="$RELEASE_DIR/infra/migrations/011_pix_polling_worker.sql"
[[ -f "$MIGRATION_011" ]] || die "Migracao 011 nao encontrada no commit alvo."
MIGRATION_012="$RELEASE_DIR/infra/migrations/012_agendamento_cancelamentos.sql"
[[ -f "$MIGRATION_012" ]] || die "Migracao 012 nao encontrada no commit alvo."
MIGRATION_014="$RELEASE_DIR/infra/migrations/014_calendar_criacoes_dispensadas.sql"
[[ -f "$MIGRATION_014" ]] || die "Migracao 014 nao encontrada no commit alvo."
MIGRATION_015="$RELEASE_DIR/infra/migrations/015_calendar_cancelamentos_dispensados.sql"
[[ -f "$MIGRATION_015" ]] || die "Migracao 015 nao encontrada no commit alvo."

UPDATE_OVERRIDE="$BACKUP_DIR/update-compose.yaml"
TARGET_IMAGE_TAG="isabele-nails-api:release-${TARGET_COMMIT}"
printf '%s\n' "$TARGET_IMAGE_TAG" >"$BACKUP_DIR/target-api-image-tag"
cat >"$UPDATE_OVERRIDE" <<EOF
services:
  $API_SERVICE:
    image: "$TARGET_IMAGE_TAG"
    build:
      context: "$RELEASE_DIR/infra/backend"
      dockerfile: Dockerfile
      args:
        APP_REVISION: "$TARGET_COMMIT"
    labels:
      org.opencontainers.image.revision: "$TARGET_COMMIT"
EOF
chmod 600 "$UPDATE_OVERRIDE"

compose_snapshot() {
  docker compose --project-directory "$PROJECT_WORKDIR" --project-name "$PROJECT_NAME" \
    --file "$BACKUP_DIR/effective-before.yaml" --file "$UPDATE_OVERRIDE" "$@"
}

# A migration 010 pode já ter sido aplicada por uma tentativa anterior. Detecta
# a estrutura final no catálogo PostgreSQL e só aplica se a estrutura ainda for
# a versão pré-010. Estado parcial é ambíguo e interrompe a atualização.
MIGRATION_STATE_SQL="$BACKUP_DIR/migration-010-state.sql"
cat >"$MIGRATION_STATE_SQL" <<'SQL'
WITH state AS (
  SELECT
    to_regclass('public.pix_webhook_inbox') IS NOT NULL AS has_table,
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'pix_webhook_inbox'
        AND column_name = 'mp_environment'
    ) AS has_environment_column,
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'pix_webhook_inbox'
        AND column_name = 'mp_environment' AND is_nullable = 'NO'
    ) AS environment_column_not_null,
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'pix_webhook_inbox'
        AND column_name = 'mp_environment' AND column_default = '''test''::text'
    ) AS environment_default_test,
    EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass('public.pix_webhook_inbox')
        AND conname = 'pix_webhook_inbox_environment_check' AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%test%'
        AND pg_get_constraintdef(oid) LIKE '%production%'
    ) AS has_environment_check,
    EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass('public.pix_webhook_inbox')
        AND conname = 'pix_webhook_inbox_pkey' AND contype = 'p'
        AND pg_get_constraintdef(oid) = 'PRIMARY KEY (mp_environment, mp_order_id)'
    ) AS has_environment_primary_key,
    EXISTS (
      SELECT 1 FROM pg_index i
      WHERE i.indexrelid = to_regclass('public.idx_pix_webhook_pendentes')
        AND i.indisvalid
        AND pg_get_indexdef(i.indexrelid) LIKE '%(mp_environment, proxima_tentativa_em)%'
        AND pg_get_expr(i.indpred, i.indrelid) = '(processado_em IS NULL)'
    ) AS has_environment_pending_index
)
SELECT CASE
  WHEN NOT has_table THEN 'missing_table'
  WHEN has_environment_column AND environment_column_not_null AND environment_default_test AND has_environment_check
    AND has_environment_primary_key AND has_environment_pending_index THEN 'applied'
  WHEN NOT has_environment_column AND NOT has_environment_check THEN 'pending'
  ELSE 'partial'
END
FROM state;
SQL
chmod 600 "$MIGRATION_STATE_SQL"
MIGRATION_STATE="$(compose_snapshot exec -T "$DB_SERVICE" sh -lc 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At' <"$MIGRATION_STATE_SQL" | tr -d '\r\n')"
case "$MIGRATION_STATE" in
  applied) echo "Migracao 010 ja aplicada; sera preservada sem nova execucao." ;;
  pending) echo "Migracao 010 ainda pendente; sera aplicada uma vez nesta atualizacao." ;;
  partial) die "Estado parcial da migracao 010; nenhuma migracao foi executada e a API nao sera parada." ;;
  missing_table) die "Tabela da migracao 008 ausente; nao e seguro aplicar a migracao 010." ;;
  *) die "Nao foi possivel determinar o estado da migracao 010 (resultado: $MIGRATION_STATE)." ;;
esac

# A migracao 012 cria o registro duravel de cancelamento e a fila de Calendar.
# O preflight aceita somente a estrutura completa (antes ou depois da 015) ou
# a ausencia total da tabela. Cada resultado estrutural e identificado abaixo.
MIGRATION_012_STATE_SQL="$BACKUP_DIR/migration-012-state.sql"
cat >"$MIGRATION_012_STATE_SQL" <<'SQL'
WITH flags AS (
  SELECT
    to_regclass('public.pix_cobrancas') IS NOT NULL AS has_charge_table,
    to_regclass('public.agendamento_cancelamentos') IS NOT NULL AS has_table,
    NOT EXISTS (
      SELECT 1 FROM (VALUES
        ('agendamento_id', 'text', 'NO'), ('cobranca_id', 'uuid', 'YES'),
        ('cliente_uid', 'text', 'NO'), ('solicitante_uid', 'text', 'NO'),
        ('tipo', 'text', 'NO'), ('estado', 'text', 'NO'),
        ('calendar_event_id', 'text', 'YES'), ('calendar_estado', 'text', 'NO'),
        ('calendar_tentativas', 'int4', 'NO'), ('calendar_proxima_tentativa_em', 'timestamptz', 'NO'),
        ('calendar_bloqueado_ate', 'timestamptz', 'YES'), ('calendar_ultimo_erro', 'text', 'YES'),
        ('calendar_enviado_em', 'timestamptz', 'YES'), ('tentativas', 'int4', 'NO'),
        ('proxima_tentativa_em', 'timestamptz', 'NO'), ('bloqueado_ate', 'timestamptz', 'YES'),
        ('ultimo_erro', 'text', 'YES'), ('criado_em', 'timestamptz', 'NO'),
        ('atualizado_em', 'timestamptz', 'NO'), ('concluido_em', 'timestamptz', 'YES')
      ) AS esperado(nome, tipo, nullable)
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'agendamento_cancelamentos'
          AND c.column_name = esperado.nome
          AND c.udt_name = esperado.tipo
          AND c.is_nullable = esperado.nullable
      )
    ) AS has_columns,
    EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass('public.agendamento_cancelamentos')
        AND conname = 'agendamento_cancelamentos_pkey' AND contype = 'p'
        AND pg_get_constraintdef(oid) = 'PRIMARY KEY (agendamento_id)'
    ) AS has_primary_key,
    NOT EXISTS (
      SELECT 1 FROM (VALUES
        ('estado', '''solicitada''::text'),
        ('calendar_estado', '''dispensado''::text'),
        ('calendar_tentativas', '0'), ('tentativas', '0'),
        ('calendar_proxima_tentativa_em', 'now()'),
        ('proxima_tentativa_em', 'now()'), ('criado_em', 'now()'),
        ('atualizado_em', 'now()')
      ) AS esperado(nome, padrao)
      WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'agendamento_cancelamentos'
          AND c.column_name = esperado.nome
          AND c.column_default = esperado.padrao
      )
    ) AS has_defaults,
    EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass('public.agendamento_cancelamentos')
        AND conname = 'agendamento_cancelamentos_cobranca_id_fkey' AND contype = 'f'
        AND confrelid = to_regclass('public.pix_cobrancas')
        AND pg_get_constraintdef(oid) LIKE '%REFERENCES pix_cobrancas(id)%'
    ) AS has_charge_fk,
    EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass('public.agendamento_cancelamentos')
        AND conname = 'agendamento_cancelamentos_tipo_check' AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%cliente%'
        AND pg_get_constraintdef(oid) LIKE '%profissional%'
    ) AS has_tipo_check,
    EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass('public.agendamento_cancelamentos')
        AND conname = 'agendamento_cancelamentos_estado_check' AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%solicitada%'
        AND pg_get_constraintdef(oid) LIKE '%concluida%'
        AND pg_get_constraintdef(oid) LIKE '%falha_permanente%'
    ) AS has_estado_check,
    EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass('public.agendamento_cancelamentos')
        AND conname = 'agendamento_cancelamentos_calendar_estado_check' AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%dispensado%'
        AND pg_get_constraintdef(oid) LIKE '%pendente%'
        AND pg_get_constraintdef(oid) LIKE '%enviando%'
        AND pg_get_constraintdef(oid) LIKE '%enviado%'
    ) AS has_calendar_estado_check,
    EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass('public.agendamento_cancelamentos')
        AND conname = 'agendamento_cancelamentos_calendar_tentativas_check' AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%calendar_tentativas%'
        AND pg_get_constraintdef(oid) LIKE '%>= 0%'
    ) AS has_calendar_tentativas_check,
    EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass('public.agendamento_cancelamentos')
        AND conname = 'agendamento_cancelamentos_tentativas_check' AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%tentativas%'
        AND pg_get_constraintdef(oid) LIKE '%>= 0%'
    ) AS has_tentativas_check,
    EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass('public.agendamento_cancelamentos')
        AND conname = 'agendamento_cancelamentos_check' AND contype = 'c'
        AND regexp_replace(lower(pg_get_constraintdef(oid)), '[[:space:]()]', '', 'g') =
          'checkcalendar_event_idisnullandcalendar_estado=''dispensado''::textorcalendar_event_idisnotnullandcalendar_estado<>''dispensado''::text'
    ) AS has_legacy_calendar_check,
    EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass('public.agendamento_cancelamentos')
        AND conname = 'agendamento_cancelamentos_calendar_evento_check' AND contype = 'c'
        AND regexp_replace(lower(pg_get_constraintdef(oid)), '[[:space:]()]', '', 'g') =
          'checkcalendar_event_idisnotnullorcalendar_estado=''dispensado''::text'
    ) AS has_015_calendar_check,
    (
      SELECT count(*)
      FROM pg_constraint
      WHERE conrelid = to_regclass('public.agendamento_cancelamentos')
        AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%calendar_event_id%'
        AND pg_get_constraintdef(oid) LIKE '%calendar_estado%'
    ) AS calendar_check_count,
    EXISTS (
      SELECT 1 FROM pg_index i
      WHERE i.indexrelid = to_regclass('public.idx_agendamento_cancelamentos_pendentes')
        AND i.indisvalid
        AND pg_get_indexdef(i.indexrelid) LIKE '%(proxima_tentativa_em, criado_em)%'
        AND pg_get_expr(i.indpred, i.indrelid) = '(estado = ''solicitada''::text)'
    ) AS has_pending_index,
    EXISTS (
      SELECT 1 FROM pg_index i
      WHERE i.indexrelid = to_regclass('public.idx_agendamento_cancelamentos_calendar_pendente')
        AND i.indisvalid
        AND pg_get_indexdef(i.indexrelid) LIKE '%(calendar_proxima_tentativa_em, criado_em)%'
        AND pg_get_expr(i.indpred, i.indrelid) LIKE '%pendente%'
        AND pg_get_expr(i.indpred, i.indrelid) LIKE '%enviando%'
    ) AS has_calendar_index
)
SELECT has_charge_table, has_table, has_columns, has_primary_key, has_defaults,
       has_charge_fk, has_tipo_check, has_estado_check, has_calendar_estado_check,
       has_calendar_tentativas_check, has_tentativas_check,
       has_legacy_calendar_check, has_015_calendar_check, calendar_check_count,
       has_pending_index, has_calendar_index
FROM flags;
SQL
chmod 600 "$MIGRATION_012_STATE_SQL"
MIGRATION_012_STATE_ROW="$(compose_snapshot exec -T "$DB_SERVICE" sh -lc 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F "|"' <"$MIGRATION_012_STATE_SQL" | tr -d '\r\n')"
IFS='|' read -r \
  HAS_012_CHARGE_TABLE HAS_012_TABLE HAS_012_COLUMNS HAS_012_PRIMARY_KEY HAS_012_DEFAULTS \
  HAS_012_CHARGE_FK HAS_012_TIPO_CHECK HAS_012_ESTADO_CHECK HAS_012_CALENDAR_ESTADO_CHECK \
  HAS_012_CALENDAR_TENTATIVAS_CHECK HAS_012_TENTATIVAS_CHECK \
  HAS_012_LEGACY_CALENDAR_CHECK HAS_012_015_CALENDAR_CHECK HAS_012_CALENDAR_CHECK_COUNT \
  HAS_012_PENDING_INDEX HAS_012_CALENDAR_INDEX <<<"$MIGRATION_012_STATE_ROW"
MIGRATION_012_RESULT="$(classificar_estado_migracao_012 \
  "$HAS_012_CHARGE_TABLE" "$HAS_012_TABLE" "$HAS_012_COLUMNS" "$HAS_012_PRIMARY_KEY" \
  "$HAS_012_DEFAULTS" "$HAS_012_CHARGE_FK" "$HAS_012_TIPO_CHECK" "$HAS_012_ESTADO_CHECK" \
  "$HAS_012_CALENDAR_ESTADO_CHECK" "$HAS_012_CALENDAR_TENTATIVAS_CHECK" \
  "$HAS_012_TENTATIVAS_CHECK" "$HAS_012_LEGACY_CALENDAR_CHECK" \
  "$HAS_012_015_CALENDAR_CHECK" "$HAS_012_CALENDAR_CHECK_COUNT" \
  "$HAS_012_PENDING_INDEX" "$HAS_012_CALENDAR_INDEX")"
IFS='|' read -r MIGRATION_012_STATE MIGRATION_012_DIAGNOSTICS <<<"$MIGRATION_012_RESULT"
case "$MIGRATION_012_STATE" in
  applied) echo "Migracao 012 ja aplicada; estrutura de cancelamentos validada e preservada." ;;
  pending) echo "Migracao 012 pendente; sera aplicada uma vez nesta atualizacao." ;;
  partial) die "Estado parcial/inconsistente da migracao 012; verificacoes: $MIGRATION_012_DIAGNOSTICS. Nenhuma migracao foi executada e a API nao sera parada." ;;
  missing_charge_table) die "Tabela pix_cobrancas ausente; nao e seguro aplicar a migracao 012. Verificacao: $MIGRATION_012_DIAGNOSTICS." ;;
  *) die "Nao foi possivel determinar o estado da migracao 012; nenhuma migracao foi executada e a API nao sera parada." ;;
esac

# A migracao 011 adiciona a agenda persistente do polling. Detecta estado
# completo, pre-migracao ou parcial antes de parar a API.
MIGRATION_011_STATE_SQL="$BACKUP_DIR/migration-011-state.sql"
cat >"$MIGRATION_011_STATE_SQL" <<'SQL'
WITH state AS (
  SELECT
    to_regclass('public.pix_cobrancas') IS NOT NULL AS has_table,
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'pix_cobrancas'
        AND column_name = 'pix_polling_next_at'
        AND is_nullable = 'YES'
    ) AS has_next_at,
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'pix_cobrancas'
        AND column_name = 'pix_polling_attempts'
        AND is_nullable = 'NO' AND column_default = '0'
    ) AS has_attempts,
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'pix_cobrancas'
        AND column_name = 'pix_polling_lease_until' AND is_nullable = 'YES'
    ) AS has_lease,
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'pix_cobrancas'
        AND column_name = 'pix_polling_last_error'
    ) AS has_last_error,
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'pix_polling_request_budget'
        AND column_name = 'window_started_at'
    ) AS has_budget_window,
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'pix_polling_request_budget'
        AND column_name = 'request_count'
    ) AS has_budget_count,
    EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass('public.pix_cobrancas')
        AND conname = 'pix_cobrancas_polling_attempts_check'
        AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%pix_polling_attempts%'
        AND pg_get_constraintdef(oid) LIKE '%>= 0%'
    ) AS has_attempts_check,
    EXISTS (
      SELECT 1 FROM pg_index i
      WHERE i.indexrelid = to_regclass('public.idx_pix_cobrancas_polling_due')
        AND i.indisvalid
        AND pg_get_indexdef(i.indexrelid) LIKE '%(mp_environment, pix_polling_next_at, criado_em)%'
        AND pg_get_expr(i.indpred, i.indrelid) LIKE '%mp_order_id%'
        AND pg_get_expr(i.indpred, i.indrelid) LIKE '%estado%'
    ) AS has_due_index,
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'pix_cobrancas'
        AND column_name IN ('pix_polling_next_at', 'pix_polling_attempts', 'pix_polling_lease_until', 'pix_polling_last_error')
    ) AS has_any_column,
    EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass('public.pix_cobrancas')
        AND conname = 'pix_cobrancas_polling_attempts_check'
    ) AS has_any_check,
    to_regclass('public.pix_polling_request_budget') IS NOT NULL AS has_any_budget_table,
    to_regclass('public.idx_pix_cobrancas_polling_due') IS NOT NULL AS has_any_index
)
SELECT CASE
  WHEN NOT has_table THEN 'missing_table'
  WHEN has_next_at AND has_attempts AND has_lease AND has_last_error AND has_budget_window AND has_budget_count AND has_attempts_check AND has_due_index THEN 'applied'
  WHEN NOT has_any_column AND NOT has_any_check AND NOT has_any_budget_table AND NOT has_any_index THEN 'pending'
  ELSE 'partial'
END
FROM state;
SQL
chmod 600 "$MIGRATION_011_STATE_SQL"
MIGRATION_011_STATE="$(compose_snapshot exec -T "$DB_SERVICE" sh -lc 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At' <"$MIGRATION_011_STATE_SQL" | tr -d '\r\n')"
case "$MIGRATION_011_STATE" in
  applied) echo "Migracao 011 ja aplicada; sera preservada sem nova execucao." ;;
  pending) echo "Migracao 011 pendente; sera aplicada uma vez nesta atualizacao." ;;
  partial) die "Estado parcial da migracao 011; nenhuma migracao foi executada e a API nao sera parada." ;;
  missing_table) die "Tabela pix_cobrancas ausente; nao e seguro aplicar a migracao 011." ;;
  *) die "Nao foi possivel determinar o estado da migracao 011 (resultado: $MIGRATION_011_STATE)." ;;
esac

# 014 apenas amplia o CHECK da fila Calendar, sem tocar agendamentos.
MIGRATION_014_STATE_SQL="$BACKUP_DIR/migration-014-state.sql"
cat >"$MIGRATION_014_STATE_SQL" <<'SQL'
SELECT CASE
  WHEN to_regclass('public.pix_calendar_outbox') IS NULL THEN 'missing'
  WHEN NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.pix_calendar_outbox'::regclass
      AND conname = 'pix_calendar_outbox_status_check'
      AND contype = 'c'
  ) THEN 'partial'
  WHEN EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.pix_calendar_outbox'::regclass
      AND conname = 'pix_calendar_outbox_status_check'
      AND pg_get_constraintdef(oid) LIKE '%dispensado%'
  ) THEN 'applied'
  WHEN EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.pix_calendar_outbox'::regclass
      AND conname = 'pix_calendar_outbox_status_check'
      AND pg_get_constraintdef(oid) LIKE '%pendente%'
      AND pg_get_constraintdef(oid) LIKE '%enviando%'
      AND pg_get_constraintdef(oid) LIKE '%enviado%'
  ) THEN 'pending'
  ELSE 'partial'
END;
SQL
chmod 600 "$MIGRATION_014_STATE_SQL"
MIGRATION_014_STATE="$(compose_snapshot exec -T "$DB_SERVICE" sh -lc 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At' <"$MIGRATION_014_STATE_SQL" | tr -d '\r\n')"
case "$MIGRATION_014_STATE" in
  applied|pending) echo "Estado da migracao 014: $MIGRATION_014_STATE" ;;
  *) die "Migracao 014 com estrutura inesperada: $MIGRATION_014_STATE" ;;
esac

MIGRATION_015_STATE_SQL="$BACKUP_DIR/migration-015-state.sql"
cat >"$MIGRATION_015_STATE_SQL" <<'SQL'
SELECT CASE
 WHEN EXISTS (
   SELECT 1 FROM pg_constraint
   WHERE conrelid = 'public.agendamento_cancelamentos'::regclass
     AND conname = 'agendamento_cancelamentos_calendar_evento_check'
 ) THEN 'applied'
 WHEN (
   SELECT COUNT(*) FROM pg_constraint
   WHERE conrelid = 'public.agendamento_cancelamentos'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%calendar_event_id%'
     AND pg_get_constraintdef(oid) LIKE '%calendar_estado%'
 ) = 1 THEN 'pending'
 ELSE 'partial'
END;
SQL
chmod 600 "$MIGRATION_015_STATE_SQL"
MIGRATION_015_STATE="$(compose_snapshot exec -T "$DB_SERVICE" sh -lc 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At' <"$MIGRATION_015_STATE_SQL" | tr -d '\r\n')"
case "$MIGRATION_015_STATE" in
  applied|pending) echo "Estado da migracao 015: $MIGRATION_015_STATE" ;;
  *) die "Migracao 015 com estrutura inesperada: $MIGRATION_015_STATE" ;;
esac

printf '%s\n' "$DB_CONTAINER" >"$BACKUP_DIR/db-container-id"
compose_snapshot exec -T "$DB_SERVICE" sh -lc 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' >"$BACKUP_DIR/postgres-before.dump"
[[ -s "$BACKUP_DIR/postgres-before.dump" ]] || die "Backup PostgreSQL vazio; atualizacao cancelada."
chmod 600 "$BACKUP_DIR/postgres-before.dump"
echo "Backup PostgreSQL concluido ($(du -h "$BACKUP_DIR/postgres-before.dump" | awk '{print $1}'))."
echo "Backup protegido: $BACKUP_DIR"
echo "Commit alvo: $TARGET_COMMIT"
echo "Imagem alvo: $TARGET_IMAGE_TAG"
echo "Configuracao efetiva e volumes preservados; nenhuma flag financeira foi alterada."

compose_snapshot build "$API_SERVICE"
[[ "$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$TARGET_IMAGE_TAG" 2>/dev/null || true)" == "$TARGET_COMMIT" ]] || die "A imagem versionada nao foi construida com o commit alvo."
API_STOPPED=false
MIGRATION_APPLIED=false
MIGRATION_011_APPLIED=false
MIGRATION_012_APPLIED=false
MIGRATION_014_APPLIED=false
NEW_API_STARTED=false
restore_old_api_on_error() {
  local rc=$?
  trap - EXIT
  if [[ "$rc" -ne 0 ]]; then
    echo "Falha (codigo $rc); iniciando recuperacao segura."
    if [[ "$NEW_API_STARTED" == true ]]; then
      local rollback="$BACKUP_DIR/rollback-compose.yaml"
      local old_image="$(<"$BACKUP_DIR/old-api-image-tag")"
      cat >"$rollback" <<EOF
services:
  $API_SERVICE:
    image: "$old_image"
    build: null
EOF
      chmod 600 "$rollback"
      docker compose --project-directory "$PROJECT_WORKDIR" --project-name "$PROJECT_NAME" \
        --file "$BACKUP_DIR/effective-before.yaml" --file "$rollback" \
        up -d --no-deps "$API_SERVICE" || true
    elif [[ "$API_STOPPED" == true ]]; then
      docker start "$API_CONTAINER" >/dev/null || true
    fi
    if [[ "$MIGRATION_APPLIED" == true || "$MIGRATION_STATE" == applied || "$MIGRATION_011_APPLIED" == true || "$MIGRATION_011_STATE" == applied || "$MIGRATION_012_APPLIED" == true || "$MIGRATION_012_STATE" == applied ]]; then
      echo "Migracoes 010/011/012 aplicadas e preservadas; nenhum dado foi removido."
    fi
    echo "Backup e configuracao efetiva anterior: $BACKUP_DIR"
  fi
  exit "$rc"
}
trap restore_old_api_on_error EXIT

compose_snapshot stop "$API_SERVICE"
API_STOPPED=true
if [[ "$MIGRATION_STATE" == pending ]]; then
  compose_snapshot exec -T "$DB_SERVICE" sh -lc 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <"$MIGRATION"
  MIGRATION_APPLIED=true
else
  echo "Pulando migracao 010 ja aplicada; banco e dados serao mantidos."
fi
if [[ "$MIGRATION_011_STATE" == pending ]]; then
  compose_snapshot exec -T "$DB_SERVICE" sh -lc 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <"$MIGRATION_011"
  MIGRATION_011_APPLIED=true
else
  echo "Pulando migracao 011 ja aplicada; banco e dados serao mantidos."
fi
if [[ "$MIGRATION_012_STATE" == pending ]]; then
  compose_snapshot exec -T "$DB_SERVICE" sh -lc 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <"$MIGRATION_012"
  MIGRATION_012_APPLIED=true
else
  echo "Pulando migracao 012 ja aplicada; banco e dados serao mantidos."
fi
if [[ "$MIGRATION_014_STATE" == pending ]]; then
  compose_snapshot exec -T "$DB_SERVICE" sh -lc 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <"$MIGRATION_014"
  MIGRATION_014_APPLIED=true
else
  echo "Pulando migracao 014 ja aplicada."
fi
if [[ "$MIGRATION_015_STATE" == pending ]]; then
  compose_snapshot exec -T "$DB_SERVICE" sh -lc 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <"$MIGRATION_015"
else
  echo "Pulando migracao 015 ja aplicada."
fi
NEW_API_STARTED=true
compose_snapshot up -d --no-deps "$API_SERVICE"
API_STOPPED=false

# O healthcheck, sozinho, não prova que a nova imagem está em execução. Exigir
# novo container e conferir o commit alvo nos labels do container e da imagem.
NEW_API_CONTAINER="$(compose_snapshot ps -q "$API_SERVICE" | head -n 1)"
[[ -n "$NEW_API_CONTAINER" ]] || die "Compose nao encontrou o container api atualizado."
[[ "$NEW_API_CONTAINER" != "$API_CONTAINER" ]] || die "O container api nao foi recriado; recusando validar somente o healthcheck."
SERVICE_REVISION="$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$NEW_API_CONTAINER")"
RUNNING_IMAGE_REF="$(docker inspect --format '{{.Config.Image}}' "$NEW_API_CONTAINER")"
NEW_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$NEW_API_CONTAINER")"
IMAGE_REVISION="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$NEW_IMAGE_ID")"
TARGET_TAG_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$TARGET_IMAGE_TAG")"
[[ "$SERVICE_REVISION" == "$TARGET_COMMIT" && "$IMAGE_REVISION" == "$TARGET_COMMIT" && "$RUNNING_IMAGE_REF" == "$TARGET_IMAGE_TAG" && "$NEW_IMAGE_ID" == "$TARGET_TAG_IMAGE_ID" ]] || die "A API ativa nao comprova o commit e a referencia de imagem alvo ($TARGET_COMMIT); rollback automatico sera iniciado."
echo "Commit da API e referencia persistente conferidos: $TARGET_COMMIT ($TARGET_IMAGE_TAG)"

HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3001/health}"
HEALTH_OK=false
for attempt in $(seq 1 30); do
  if curl --fail --silent --max-time 5 "$HEALTH_URL" 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get("status")=="online" and d.get("banco")=="PostgreSQL conectado" else 1)' 2>/dev/null; then
    HEALTH_OK=true
    break
  fi
  sleep 2
done
[[ "$HEALTH_OK" == true ]] || die "Healthcheck nao confirmou API e PostgreSQL apos 60 segundos."
compose_snapshot exec -T "$DB_SERVICE" sh -lc 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT mp_environment, count(*) AS eventos FROM public.pix_webhook_inbox GROUP BY mp_environment ORDER BY mp_environment;"' || true
echo "Atualizacao concluida."
echo "API: $HEALTH_URL"
echo "Commit: $TARGET_COMMIT"
echo "Backup/rollback: $BACKUP_DIR"
echo "Ambiente PIX preservado ($MP_ENVIRONMENT_EFFECTIVE); o script nao cria cobrancas nem solicita reembolsos."
echo "Fim: $(date -Is)"
trap - EXIT
