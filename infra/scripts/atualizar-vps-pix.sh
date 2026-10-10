#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Atualizacao incremental PIX: preserva a configuracao efetiva do Compose.
# O script nao acessa contas externas, nao cria cobrancas e nao habilita producao.

BRANCH="${BRANCH:-codex/correcao-pix-20261010}"
APP_DIR="${APP_DIR:-/opt/isabele-nails}"
BACKUP_ROOT="${BACKUP_ROOT:-/opt/isabele-nails-backups}"
RELEASE_ROOT="${RELEASE_ROOT:-/opt/isabele-nails-releases}"
LOG_DIR="${LOG_DIR:-/var/log/isabele-nails-deploy}"
MODE="${1:-apply}"
SCRIPT_PATH="$(readlink -f "$0")"

timestamp() { date -u +%Y%m%dT%H%M%SZ; }
die() { echo "ERRO: $*" >&2; exit 1; }

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
  ROLLBACK_OVERRIDE="$BACKUP_DIR/rollback-compose.yaml"
  cat >"$ROLLBACK_OVERRIDE" <<EOF
services:
  $API_SERVICE:
    image: "$OLD_IMAGE_ID"
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
mapfile -t ALL_API_CONTAINERS < <(docker ps -q --filter "label=com.docker.compose.service=api")
API_CONTAINERS=()
for candidate in "${ALL_API_CONTAINERS[@]}"; do
  candidate_files="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}' "$candidate")"
  candidate_workdir="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$candidate")"
  IFS=',' read -r -a candidate_file_list <<<"$candidate_files"
  for candidate_file in "${candidate_file_list[@]}"; do
    candidate_real="$(realpath "$candidate_file" 2>/dev/null || realpath "$candidate_workdir/$candidate_file" 2>/dev/null || realpath "$APP_REAL/$candidate_file" 2>/dev/null || true)"
    if [[ "$candidate_real" == "$APP_REAL/infra/compose.yaml" ]]; then
      API_CONTAINERS+=("$candidate")
      break
    fi
  done
done
[[ "${#API_CONTAINERS[@]}" -eq 1 ]] || die "Esperava um container api ativo usando $APP_REAL/infra/compose.yaml; encontrados ${#API_CONTAINERS[@]}. Nenhuma alteracao foi feita."
API_CONTAINER="${API_CONTAINERS[0]}"
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

# Estes caminhos sao conhecidos nesta instalacao. Se estiverem presentes, devem
# constar nas labels do container; assim um override nao passa despercebido.
for expected in \
  "$APP_DIR/infra/compose.yaml" \
  "$APP_DIR/infra/compose.override.yaml" \
  "/root/isabele-codex-pix-teste-20261010-125718.compose.yaml"; do
  if [[ -f "$expected" ]]; then
    found=false
    for file in "${ORIGINAL_COMPOSE_FILES[@]}"; do
      [[ "$(realpath "$file")" == "$(realpath "$expected")" ]] && found=true
    done
    [[ "$found" == true ]] || die "O arquivo Compose existente nao aparece na configuracao ativa: $expected"
  fi
done

mapfile -t PROJECT_CONTAINERS < <(docker ps -q --filter "label=com.docker.compose.project=$PROJECT_NAME")
[[ "${#PROJECT_CONTAINERS[@]}" -gt 0 ]] || die "Nenhum container ativo no projeto $PROJECT_NAME."
mapfile -t DB_CONTAINERS < <(docker ps -q --filter "label=com.docker.compose.project=$PROJECT_NAME" --filter "label=com.docker.compose.service=postgres")
[[ "${#DB_CONTAINERS[@]}" -eq 1 ]] || die "Esperava um PostgreSQL ativo no projeto; encontrados ${#DB_CONTAINERS[@]}. Nenhuma alteracao foi feita."
DB_CONTAINER="${DB_CONTAINERS[0]}"
DB_SERVICE="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.service" }}' "$DB_CONTAINER")"

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
for file in "${ORIGINAL_COMPOSE_FILES[@]}"; do
  index=$((index + 1))
  copy_name="$(printf '%02d' "$index")-$(basename "$file")"
  cp -- "$file" "$BACKUP_DIR/compose-sources/$copy_name"
  chmod 600 "$BACKUP_DIR/compose-sources/$copy_name"
  printf '%s\t%s\n' "$file" "$copy_name" >>"$BACKUP_DIR/compose-source-manifest.txt"
done

docker inspect "$API_CONTAINER" >"$BACKUP_DIR/api-container-before.json"
docker inspect "${PROJECT_CONTAINERS[@]}" >"$BACKUP_DIR/project-containers-before.json"
chmod 600 "$BACKUP_DIR/compose-source-manifest.txt" "$BACKUP_DIR/api-container-before.json" "$BACKUP_DIR/project-containers-before.json"

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
python3 - "$BACKUP_DIR/effective-before.json" "$BACKUP_DIR/api-container-before.json" <<'PY'
import json, os, sys
config_path, inspect_path = sys.argv[1:]
with open(config_path, encoding="utf-8") as f: config = json.load(f)
with open(inspect_path, encoding="utf-8") as f: container = json.load(f)[0]
service = config.get("services", {}).get("api")
if not service:
    raise SystemExit("Configuracao renderizada nao contem o servico api.")
raw = service.get("environment") or {}
if isinstance(raw, list):
    env_cfg = dict(item.split("=", 1) if "=" in item else (item, None) for item in raw)
else:
    env_cfg = raw
live_env = {}
for item in container.get("Config", {}).get("Env", []) or []:
    key, sep, value = item.partition("=")
    if sep: live_env[key] = value
mismatches = [key for key, value in env_cfg.items() if value is not None and live_env.get(key) != str(value)]
critical = (
    "PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD",
    "MP_ENVIRONMENT", "PIX_TEST_ORDERS_ENABLED", "PIX_PRODUCTION_ORDERS_ENABLED",
    "MP_ACCESS_TOKEN_TEST", "MP_ACCESS_TOKEN_PRODUCTION",
    "MP_WEBHOOK_SECRET_TEST", "MP_WEBHOOK_SECRET_PRODUCTION",
    "PIX_WEBHOOK_ENABLED", "PIX_WEBHOOK_WORKER_ENABLED", "PIX_CALENDAR_WORKER_ENABLED",
    "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "GOOGLE_APPLICATION_CREDENTIALS",
    "FIREBASE_WATCH_ENABLED", "PUSH_WORKER_ENABLED",
)
for key in critical:
    if key not in env_cfg or env_cfg.get(key) is None or live_env.get(key) != str(env_cfg.get(key)):
        mismatches.append(key)
if mismatches:
    names = ", ".join(sorted(set(mismatches)))
    raise SystemExit("Configuracao Compose nao corresponde ao container ativo (variaveis: " + names + "). Abortando sem alteracoes.")
if str(env_cfg["MP_ENVIRONMENT"]).lower() != "test":
    raise SystemExit("O backend ativo nao esta em ambiente test; abortando sem alteracoes.")
if str(env_cfg["PIX_PRODUCTION_ORDERS_ENABLED"]).lower() not in ("false", "0", ""):
    raise SystemExit("PIX de producao esta ativo na configuracao efetiva; abortando sem alteracoes.")

# Confere mounts bind (Firebase/segredos e demais arquivos) e os destinos/tipos
# de todos os volumes com o container atual.
configured = []
for item in service.get("volumes", []) or []:
    if isinstance(item, str):
        source, target, *mode = item.split(":")
        typ = "bind" if source.startswith("/") or source.startswith(".") else "volume"
        ro = any("ro" in m.split(",") for m in mode)
    else:
        typ = item.get("type", "volume")
        source = item.get("source", "")
        target = item.get("target", "")
        ro = bool(item.get("read_only", False))
    if typ == "bind": source = os.path.realpath(source)
    configured.append((target, typ, source if typ == "bind" else "", ro))
live = []
for item in container.get("Mounts", []) or []:
    typ = item.get("Type", "")
    source = os.path.realpath(item.get("Source", "")) if typ == "bind" else ""
    live.append((item.get("Destination", ""), typ, source, not bool(item.get("RW", True))))
if sorted(configured) != sorted(live):
    raise SystemExit("Volumes do Compose renderizado diferem dos mounts ativos. Abortando sem alteracoes.")
print("Configuracao efetiva conferida: ambiente PIX de teste, producao desativada, credenciais/env e mounts iguais ao container ativo.")
PY

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

RELEASE_DIR="$RELEASE_ROOT/$TARGET_COMMIT"
[[ ! -e "$RELEASE_DIR" ]] || die "Release ja existe: $RELEASE_DIR"
mkdir -p "$RELEASE_ROOT"
git -C "$APP_DIR" worktree add --detach "$RELEASE_DIR" "$TARGET_COMMIT"
MIGRATION="$RELEASE_DIR/infra/migrations/010_pix_webhook_ambientes.sql"
[[ -f "$MIGRATION" ]] || die "Migracao 010 nao encontrada no commit alvo."

UPDATE_OVERRIDE="$BACKUP_DIR/update-compose.yaml"
cat >"$UPDATE_OVERRIDE" <<EOF
services:
  $API_SERVICE:
    build:
      context: "$RELEASE_DIR/infra/backend"
      dockerfile: Dockerfile
EOF
chmod 600 "$UPDATE_OVERRIDE"

compose_snapshot() {
  docker compose --project-directory "$PROJECT_WORKDIR" --project-name "$PROJECT_NAME" \
    --file "$BACKUP_DIR/effective-before.yaml" --file "$UPDATE_OVERRIDE" "$@"
}

printf '%s\n' "$DB_CONTAINER" >"$BACKUP_DIR/db-container-id"
compose_snapshot exec -T "$DB_SERVICE" sh -lc 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' >"$BACKUP_DIR/postgres-before.dump"
[[ -s "$BACKUP_DIR/postgres-before.dump" ]] || die "Backup PostgreSQL vazio; atualizacao cancelada."
chmod 600 "$BACKUP_DIR/postgres-before.dump"
echo "Backup PostgreSQL concluido ($(du -h "$BACKUP_DIR/postgres-before.dump" | awk '{print $1}'))."
echo "Backup protegido: $BACKUP_DIR"
echo "Commit alvo: $TARGET_COMMIT"
echo "Configuracao de teste e volumes efetivos foram preservados; PIX real segue desativado."

compose_snapshot build "$API_SERVICE"
API_STOPPED=false
MIGRATION_APPLIED=false
NEW_API_STARTED=false
restore_old_api_on_error() {
  local rc=$?
  trap - EXIT
  if [[ "$rc" -ne 0 ]]; then
    echo "Falha (codigo $rc); iniciando recuperacao segura."
    if [[ "$NEW_API_STARTED" == true ]]; then
      local rollback="$BACKUP_DIR/rollback-compose.yaml"
      local old_image="$(<"$BACKUP_DIR/old-api-image-id")"
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
    [[ "$MIGRATION_APPLIED" != true ]] || echo "Migracao 010 aplicada e preservada; nenhum dado foi removido."
    echo "Backup e configuracao efetiva anterior: $BACKUP_DIR"
  fi
  exit "$rc"
}
trap restore_old_api_on_error EXIT

compose_snapshot stop "$API_SERVICE"
API_STOPPED=true
compose_snapshot exec -T "$DB_SERVICE" sh -lc 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <"$MIGRATION"
MIGRATION_APPLIED=true
NEW_API_STARTED=true
compose_snapshot up -d --no-deps "$API_SERVICE"
API_STOPPED=false

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
echo "Producao permanece desativada; nenhuma cobranca ou chamada externa foi criada pelo script."
echo "Fim: $(date -Is)"
trap - EXIT
