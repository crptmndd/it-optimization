#!/usr/bin/env bash
# Бэкап базы: pg_dump в server/backups с ротацией.
#
# Разовый запуск:
#   bash server/scripts/backup.sh
#
# По расписанию (ежедневно в 4:00) — от root:
#   crontab -e
#   0 4 * * * cd /opt/it-optimization/server && bash scripts/backup.sh >> backups/backup.log 2>&1
#
# Дамп, который ни разу не восстанавливали, бэкапом не считается: раз в
# несколько месяцев проверяй восстановление (команда в конце файла).
set -euo pipefail

cd "$(dirname "$0")/.."

COMPOSE="docker compose -f docker-compose.prod.yml"
KEEP_DAYS=14
STAMP="$(date +%Y-%m-%d_%H%M)"
DIR="./backups"
FILE="$DIR/itopt_$STAMP.sql.gz"

mkdir -p "$DIR"

# Пользователь и имя базы берутся из того же .env, что и сам сервис.
# shellcheck disable=SC1091
set -a; . ./.env; set +a

echo "[$(date +%FT%T)] дамп → $FILE"
$COMPOSE exec -T db pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists \
  | gzip -9 > "$FILE"

SIZE=$(stat -c%s "$FILE")
# Пустой или обрезанный дамп — это тихая потеря данных, поэтому проверяем.
if [ "$SIZE" -lt 1024 ]; then
  echo "ОШИБКА: дамп подозрительно мал ($SIZE байт), удаляю" >&2
  rm -f "$FILE"
  exit 1
fi

echo "[$(date +%FT%T)] готово, $(numfmt --to=iec "$SIZE")"

# Картинки кейсов живут в томе, а не в базе — без них дамп неполон.
UPLOADS="$DIR/uploads_$STAMP.tar.gz"
$COMPOSE exec -T api tar -czf - -C /app/uploads . > "$UPLOADS" 2>/dev/null || {
  echo "предупреждение: не удалось забэкапить картинки" >&2
  rm -f "$UPLOADS"
}

echo "[$(date +%FT%T)] чищу дампы старше $KEEP_DAYS дней"
find "$DIR" -name 'itopt_*.sql.gz' -mtime +$KEEP_DAYS -delete
find "$DIR" -name 'uploads_*.tar.gz' -mtime +$KEEP_DAYS -delete

ls -lh "$DIR" | tail -5

# Восстановление (осознанно, вручную). Только в чистую схему и при остановленном API.
# Поверх базы с более новой схемой дамп ляжет частично: новые таблицы держат внешние
# ключи на users и projects, DROP из дампа падает, а psql без ON_ERROR_STOP всё равно
# вернёт 0. Дальше API не стартует ни на какой версии (P3009 в migrate deploy).
#
#   docker compose -f docker-compose.prod.yml stop api
#   docker compose -f docker-compose.prod.yml exec -T db \
#     psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
#   gunzip -c backups/itopt_ГГГГ-ММ-ДД_ЧЧММ.sql.gz \
#     | docker compose -f docker-compose.prod.yml exec -T db \
#       psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"
#   docker compose -f docker-compose.prod.yml up -d api
