#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Atualizacao incremental do backend PIX na VPS.
# Nao altera a copia de trabalho atual, nao aplica merge e nao habilita producao.

BRANCH="${BRANCH:-codex/correcao-pix-20261010}"
APP_DIR="${APP_DIR:-/opt/isabele}"
BACKUP_ROOT="${BACKUP_ROOT:-/opt/isabele-backups}"
LOG_DIR="${LOG_DIR:-/var/log/isabele-deploy}"
MODE="${1:-apply}"
SCRIPT_PATH="$(readlink -f "$0")"

timestamp() { date -u +%Y%m%dT%H%M%SZ; }
die() { echo "ERRO: $*" >&2; exit 1; }

if [[ "$MODE" == "start" || "$MODE" == "--background" ]]; then
  mkdir -p "$LOG_DIR"
  chmod 750 "$LOG_DIR"
  LOG_FILE="${LOG_FILE:-$LOG_DIR/pix-update-$(timestamp).log}"
  export LOG_FILE APP_DIR BACKUP_ROOT LOG_DIR BRANCH
  nohup bash "$SCRIPT_PATH" apply >>"$LOG_FILE" 2>&1 </dev/null &
  echo "Atualizacao iniciada em segundo plano. PID=$!"
  echo "Log persistente: $LOG_FILE"
  exit 0
fi

mkdir -p "$LOG_DIR" "$BACKUP_ROOT"
chmod 750 "$LOG_DIR" "$BACKUP_ROOT"
LOG_FILE="${LOG_FILE:-$LOG_DIR/pix-update-$(timestamp).log}"
export LOG_FILE APP_DIR BACKUP_ROOT LOG_DIR BRANCH
exec >>"$LOG_FILE" 2>&1

LOCK_FILE="$LOG_DIR/pix-update.lock"
exec 9>"$LOCK_FILE"
flock -n 9 || die "Ja existe uma atualizacao PIX em andamento. Consulte $LOG_DIR."

COMPOSE_FILE="${COMPOSE_FILE:-}"
if [[ -z "$COMPOSE_FILE" ]]; then
  for candidate in "$APP_DIR/infra/compose.yaml" "$APP_DIR/compose.yaml" "$APP_DIR/docker-compose.yml"; do
    if [[ -f "$candidate" ]]; then COMPOSE_FILE="$candidate"; break; fi
  done
fi
[[ -n "$COMPOSE_FILE" && -f "$COMPOSE_FILE" ]] || die "Defina COMPOSE_FILE para o Compose atualmente usado pela VPS."

ENV_FILE="${ENV_FILE:-}"
if [[ -z "$ENV_FILE" ]]; then
  for candidate in "$(dirname "$COMPOSE_FILE")/.env" "$APP_DIR/.env"; do
    if [[ -f "$candidate" ]]; then ENV_FILE="$candidate"; break; fi
  done
fi
[[ -z "$ENV_FILE" || -f "$ENV_FILE" ]] || die "ENV_FILE nao existe: $ENV_FILE"

compose_base() {
  local args=(--project-directory "$APP_DIR")
  [[ -z "$ENV_FILE" ]] || args+=(--env-file "$ENV_FILE")
  args+=(--file "$COMPOSE_FILE")
  docker compose "${args[@]}" "$@"
}

compose_release() {
  local args=(--project-directory "$APP_DIR")
  [[ -z "$ENV_FILE" ]] || args+=(--env-file "$ENV_FILE")
  args+=(--file "$COMPOSE_FILE" --file "$OVERRIDE_FILE" --project-name "$PROJECT_NAME")
  docker compose "${args[@]}" "$@"
}

compose_with_override() {
  local override="$1"; shift
  local args=(--project-directory "$APP_DIR")
  [[ -z "$ENV_FILE" ]] || args+=(--env-file "$ENV_FILE")
  args+=(--file "$COMPOSE_FILE" --file "$override" --project-name "$PROJECT_NAME")
  docker compose "${args[@]}" "$@"
}

write_rollback_override() {
  local backup="$1" image
  image="$(<"$backup/old-api-image-id")"
  [[ "$image" =~ ^sha256:[0-9a-f]{64}$ ]] || die "Imagem anterior ausente ou invalida em $backup."
  cat >"$backup/rollback-compose.yaml" <<EOF
services:
  api:
    image: "$image"
    build: null
    environment:
      MP_ENVIRONMENT: "test"
      PIX_PRODUCTION_ORDERS_ENABLED: "false"
      PIX_WEBHOOK_ENABLED: "false"
      PIX_WEBHOOK_WORKER_ENABLED: "false"
EOF
  chmod 600 "$backup/rollback-compose.yaml"
}

rollback_to_backup() {
  local backup="$1"
  [[ -d "$backup" && -f "$backup/old-api-image-id" ]] || die "Backup invalido: $backup"
  write_rollback_override "$backup"
  compose_with_override "$backup/rollback-compose.yaml" up -d --no-deps api
  echo "Rollback do backend concluido. A migracao 010 e os dados foram preservados."
  echo "Webhook e worker permanecem desativados no rollback; o polling existente pode continuar."
}

if [[ "$MODE" == "rollback" ]]; then
  [[ $# -ge 2 ]] || die "Uso: $0 rollback /caminho/do/backup"
  git -C "$APP_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "APP_DIR precisa apontar para o checkout Git usado pelo Compose."
  API_CONTAINER="$(compose_base ps -q api | head -n1)"
  [[ -n "$API_CONTAINER" ]] || die "Servico api nao encontrado no Compose atual."
  PROJECT_NAME="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$API_CONTAINER")"
  rollback_to_backup "$2"
  exit 0
fi

[[ "$MODE" == "apply" ]] || die "Modo invalido. Use apply, start ou rollback."
git -C "$APP_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "APP_DIR precisa apontar para o checkout Git atual da Isabele."
command -v docker >/dev/null || die "Docker nao encontrado."
command -v git >/dev/null || die "Git nao encontrado."
command -v python3 >/dev/null || die "Python 3 necessario para inspecionar configuracao sem imprimir segredos."
command -v flock >/dev/null || die "flock nao encontrado."
command -v curl >/dev/null || die "curl nao encontrado para o healthcheck."

REMOTE_URL="$(git -C "$APP_DIR" remote get-url origin)"
case "${REMOTE_URL,,}" in
  *joadlsilvaseo-png/isabelenailsapp.git|*joadlsilvaseo-png/isabelenailsapp) ;;
  *) die "O origin de APP_DIR nao e joadlsilvaseo-png/isabelenailsapp." ;;
esac

cd "$APP_DIR"
echo "Inicio da atualizacao incremental PIX: $(date -Is)"
echo "Branch alvo: $BRANCH"
echo "Compose preservado: $COMPOSE_FILE"
echo "Log: $LOG_FILE"

# Salva diff e arquivos fora do Git sem alterar nem limpar o checkout existente.
git -C "$APP_DIR" fetch --no-tags origin "$BRANCH"
TARGET_COMMIT="$(git -C "$APP_DIR" rev-parse FETCH_HEAD)"
[[ "$TARGET_COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "Nao foi possivel resolver o commit remoto."
BACKUP_DIR="$BACKUP_ROOT/pix-update-$(timestamp)-${TARGET_COMMIT:0:12}"
RELEASE_DIR="${RELEASE_ROOT:-/opt/isabele-releases}/$TARGET_COMMIT"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
printf '%s\n' "$TARGET_COMMIT" >"$BACKUP_DIR/target-commit"
printf '%s\n' "$(git -C "$APP_DIR" rev-parse HEAD)" >"$BACKUP_DIR/checkout-head"
git -C "$APP_DIR" status --porcelain=v1 >"$BACKUP_DIR/git-status.txt"
git -C "$APP_DIR" diff --binary HEAD >"$BACKUP_DIR/working-tree.patch"
git -C "$APP_DIR" ls-files --others --exclude-standard -z >"$BACKUP_DIR/untracked-files.list"
if [[ -s "$BACKUP_DIR/untracked-files.list" ]]; then
  tar -C "$APP_DIR" --null -T "$BACKUP_DIR/untracked-files.list" -czf "$BACKUP_DIR/untracked-files.tar.gz"
fi
cp -a "$COMPOSE_FILE" "$BACKUP_DIR/compose-before.yaml"
chmod 600 "$BACKUP_DIR"/*

API_CONTAINER="$(compose_base ps -q api | head -n1)"
[[ -n "$API_CONTAINER" ]] || die "Servico api nao encontrado no Compose atual."
PROJECT_NAME="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$API_CONTAINER")"
[[ -n "$PROJECT_NAME" && "$PROJECT_NAME" != "<no value>" ]] || die "Nao foi possivel identificar o projeto Compose em execucao."
OLD_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$API_CONTAINER")"
[[ "$OLD_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || die "Nao foi possivel registrar a imagem atual da API."
printf '%s\n' "$OLD_IMAGE_ID" >"$BACKUP_DIR/old-api-image-id"
printf '%s\n' "$PROJECT_NAME" >"$BACKUP_DIR/compose-project"
printf '%s\n' "$APP_DIR" >"$BACKUP_DIR/app-dir"
printf '%s\n' "$COMPOSE_FILE" >"$BACKUP_DIR/compose-file"
printf '%s\n' "$ENV_FILE" >"$BACKUP_DIR/env-file"

# O JSON de config pode conter credenciais; ele fica apenas em memoria e a saida
# do Python contem somente tres booleanos, nunca os valores.
CONFIG_JSON="$(compose_base config --format json)"
read -r HAS_TEST_TOKEN HAS_TEST_SECRET HAS_TEST_PIX <<<"$(python3 -c '
import json,sys
c=json.load(sys.stdin)
e=(c.get("services",{}).get("api",{}).get("environment",{}) or {})
def present(k):
    v=e.get(k)
    if isinstance(v,bool): return v
    return bool(str(v or "").strip())
print(" ".join("1" if present(k) else "0" for k in ("MP_ACCESS_TOKEN_TEST","MP_WEBHOOK_SECRET_TEST","PIX_TEST_ORDERS_ENABLED")))
' <<<"$CONFIG_JSON")"
unset CONFIG_JSON

WEBHOOK_ENABLED=false
WORKER_ENABLED=false
TEST_PIX_ENABLED=false
if [[ "$HAS_TEST_TOKEN" == "1" ]]; then TEST_PIX_ENABLED=true; fi
if [[ "$HAS_TEST_TOKEN" == "1" && "$HAS_TEST_SECRET" == "1" ]]; then
  WEBHOOK_ENABLED=true
  WORKER_ENABLED=true
fi

if [[ -e "$RELEASE_DIR" ]]; then die "Diretorio de release ja existe: $RELEASE_DIR"; fi
mkdir -p "$(dirname "$RELEASE_DIR")"
git -C "$APP_DIR" worktree add --detach "$RELEASE_DIR" "$TARGET_COMMIT"
[[ -f "$RELEASE_DIR/infra/migrations/010_pix_webhook_ambientes.sql" ]] || die "Migração 010 nao encontrada no commit alvo."

OVERRIDE_FILE="$BACKUP_DIR/update-compose.yaml"
cat >"$OVERRIDE_FILE" <<EOF
services:
  api:
    build:
      context: "$RELEASE_DIR/infra/backend"
      dockerfile: Dockerfile
    environment:
      MP_ENVIRONMENT: "test"
      PIX_TEST_ORDERS_ENABLED: "$TEST_PIX_ENABLED"
      PIX_PRODUCTION_ORDERS_ENABLED: "false"
      PIX_WEBHOOK_ENABLED: "$WEBHOOK_ENABLED"
      PIX_WEBHOOK_WORKER_ENABLED: "$WORKER_ENABLED"
EOF
chmod 600 "$OVERRIDE_FILE"

echo "Commit alvo: $TARGET_COMMIT"
echo "Checkout local preservado; release isolado em $RELEASE_DIR"
echo "Backup persistente: $BACKUP_DIR"
echo "PIX de teste habilitado: $TEST_PIX_ENABLED"
echo "Webhook/worker de teste habilitados: $WEBHOOK_ENABLED"
echo "PIX de producao: false"

# O dump e criado antes do build, da parada da API e da migracao.
compose_base exec -T postgres sh -lc 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' >"$BACKUP_DIR/postgres-before.dump"
[[ -s "$BACKUP_DIR/postgres-before.dump" ]] || die "Backup PostgreSQL vazio; atualizacao cancelada."
chmod 600 "$BACKUP_DIR/postgres-before.dump"
echo "Backup PostgreSQL concluido ($(du -h "$BACKUP_DIR/postgres-before.dump" | awk '{print $1}'))."

# Build antes da parada reduz o periodo sem API. A migracao e executada com a
# versao antiga parada para evitar que um webhook antigo escreva na nova chave.
compose_release build api
API_STOPPED=false
MIGRATION_APPLIED=false
NEW_API_STARTED=false
restore_old_api_on_error() {
  local rc=$?
  trap - EXIT
  if [[ "$rc" -ne 0 ]]; then
    echo "Falha (codigo $rc); iniciando recuperacao segura."
    if [[ "$NEW_API_STARTED" == "true" ]]; then
      write_rollback_override "$BACKUP_DIR"
      compose_with_override "$BACKUP_DIR/rollback-compose.yaml" up -d --no-deps api || true
    elif [[ "$API_STOPPED" == "true" ]]; then
      docker start "$API_CONTAINER" >/dev/null || true
    fi
    if [[ "$MIGRATION_APPLIED" == "true" ]]; then
      echo "A migracao 010 foi aplicada e sera mantida; nenhum dado foi removido."
    fi
    echo "Backup para analise/rollback: $BACKUP_DIR"
  fi
  exit "$rc"
}
trap restore_old_api_on_error EXIT

compose_base stop api
API_STOPPED=true
compose_base exec -T postgres sh -lc 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <"$RELEASE_DIR/infra/migrations/010_pix_webhook_ambientes.sql"
MIGRATION_APPLIED=true
NEW_API_STARTED=true
compose_release up -d --no-deps api
API_STOPPED=false

HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3001/health}"
HEALTH_OK=false
for attempt in $(seq 1 30); do
  if curl --fail --silent --show-error --max-time 5 "$HEALTH_URL" 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get("status")=="online" and d.get("banco")=="PostgreSQL conectado" else 1)' 2>/dev/null; then
    HEALTH_OK=true
    break
  fi
  sleep 2
done
[[ "$HEALTH_OK" == "true" ]] || die "Healthcheck nao confirmou API e PostgreSQL apos 60 segundos."

compose_release exec -T postgres sh -lc 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT mp_environment, count(*) AS eventos FROM public.pix_webhook_inbox GROUP BY mp_environment ORDER BY mp_environment;"' || true
echo "Atualizacao concluida com healthcheck valido."
echo "API: $HEALTH_URL"
echo "Commit: $TARGET_COMMIT"
echo "Backup/rollback: $BACKUP_DIR"
echo "Webhook/worker: $WEBHOOK_ENABLED (somente teste; requer credenciais de teste no Compose)"
echo "Producao permanece desativada. Nenhum pedido ou pagamento foi criado pelo script."
echo "Fim: $(date -Is)"
trap - EXIT
