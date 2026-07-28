#!/usr/bin/env bash
# ============================================================================
# backup-db.sh
# ----------------------------------------------------------------------------
# الغرض / Purpose:
#   أخذ نسخة احتياطية **سليمة** من قاعدة nassaj-dev عبر `VACUUM INTO` (أو
#   `.backup` كبديل)، لا عبر `cp`.
#
#   Take a CONSISTENT backup of the nassaj-dev database using `VACUUM INTO`
#   (falling back to `.backup`), never `cp`.
#
# سبب الوجود / Context:
#   القاعدة تعمل بنمط WAL: أي كتلة مُثبَّتة (committed) تبقى في ملف `-wal`
#   الجانبي حتى يجري checkpoint. لذلك نسخ ملف القاعدة وحده يفقد كل ما لم
#   يُدمَج بعد. على هذا التنصيب بلغ حجم الـ WAL الحيّ 4.18MB مقابل 1.34MB
#   للقاعدة نفسها، وستّ نسخ `.bak` على القرص بلا ملف `-wal` مقارن — أي أن
#   استعادة أيٍّ منها تفقد كتابات مُثبَّتة فعلاً.
#
#   The database runs in WAL mode: a COMMITTED transaction lives in the `-wal`
#   sidecar until a checkpoint folds it back into the main file. Copying the
#   database file alone therefore loses everything not yet merged. On this
#   install the live WAL has been 4.18MB against a 1.34MB database, and six
#   `.bak` files sit on disk with no matching `-wal` — restoring any of them
#   silently loses committed writes.
#
#   `VACUUM INTO` goes through SQLite, sees the fully merged state, and writes a
#   single self-contained file with no sidecars to keep together.
#
# الاستعمال / Usage:
#   scripts/backup-db.sh [--db <path>] [--out-dir <dir>] [--label <text>]
#                        [--verify] [--quiet]
#
#   --db       مسار القاعدة (افتراضياً $DATABASE_PATH ثم المسار المعتاد).
#   --out-dir  مجلّد الوجهة (افتراضياً <dir-of-db>/backups).
#   --label    لصيقة تُضاف لاسم الملف (مثل pre-migration).
#   --verify   تشغيل PRAGMA integrity_check + foreign_key_check على النسخة.
#
# ملاحظات / Notes:
#   * القراءة من القاعدة الحيّة بوضع `mode=ro` — لا كتابة في المصدر إطلاقاً.
#   * لا يحذف السكربت أي نسخة قديمة. لا سياسة تدوير — الإبقاء على الكل مقصود.
#   * النسخة الناتجة chmod 0600: تحوي جدول users كاملاً (هاشات كلمات المرور).
#   * exit 0 نجاح، 1 خطأ استعمال/بيئة، 2 فشل النسخ، 3 فشل التحقّق.
# ============================================================================

set -Eeuo pipefail

DEFAULT_DB="${HOME}/.local/share/nassaj-dev/db.sqlite"

DB_PATH=""
OUT_DIR=""
LABEL=""
VERIFY=0
QUIET=0

log() { [[ "${QUIET}" -eq 1 ]] || printf '%s\n' "$*"; }
err() { printf '%s\n' "$*" >&2; }

usage() {
  sed -n '30,44p' "$0"
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --db)      DB_PATH="${2:-}"; shift 2 ;;
    --out-dir) OUT_DIR="${2:-}"; shift 2 ;;
    --label)   LABEL="${2:-}"; shift 2 ;;
    --verify)  VERIFY=1; shift ;;
    --quiet)   QUIET=1; shift ;;
    -h|--help) usage ;;
    *) err "unknown argument: $1"; usage ;;
  esac
done

if ! command -v sqlite3 >/dev/null 2>&1; then
  err "sqlite3 not found in PATH"
  exit 1
fi

if [[ -z "${DB_PATH}" ]]; then
  DB_PATH="${DATABASE_PATH:-${DEFAULT_DB}}"
fi

if [[ ! -f "${DB_PATH}" ]]; then
  err "database not found: ${DB_PATH}"
  exit 1
fi

DB_DIR="$(cd "$(dirname "${DB_PATH}")" && pwd)"
DB_FILE="$(basename "${DB_PATH}")"
DB_PATH="${DB_DIR}/${DB_FILE}"

if [[ -z "${OUT_DIR}" ]]; then
  OUT_DIR="${DB_DIR}/backups"
fi
mkdir -p "${OUT_DIR}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SUFFIX=""
[[ -n "${LABEL}" ]] && SUFFIX="-$(printf '%s' "${LABEL}" | tr -c '[:alnum:]._-' '-')"
TARGET="${OUT_DIR}/${DB_FILE%.sqlite}-${STAMP}${SUFFIX}.sqlite"

if [[ -e "${TARGET}" ]]; then
  err "refusing to overwrite an existing backup: ${TARGET}"
  exit 2
fi

# القراءة بـ mode=ro: SQLite ترفض أي كتابة في المصدر، وVACUUM INTO يكتب في
# الوجهة فقط. (Read-only source; VACUUM INTO writes only to the destination.)
SOURCE_URI="file:${DB_PATH}?mode=ro"

log "==> source : ${DB_PATH}"
log "==> target : ${TARGET}"

WAL_BYTES=0
[[ -f "${DB_PATH}-wal" ]] && WAL_BYTES="$(wc -c < "${DB_PATH}-wal" | tr -d ' ')"
log "==> wal    : ${WAL_BYTES} bytes pending merge (lost by a plain cp)"

if ! sqlite3 "${SOURCE_URI}" "VACUUM INTO '${TARGET}';" 2>/dev/null; then
  log "    VACUUM INTO unavailable, falling back to .backup"
  if ! sqlite3 "${SOURCE_URI}" ".backup '${TARGET}'"; then
    err "backup FAILED for ${DB_PATH}"
    rm -f "${TARGET}"
    exit 2
  fi
fi

if [[ ! -s "${TARGET}" ]]; then
  err "backup produced an empty file: ${TARGET}"
  exit 2
fi

# النسخة تحوي جدول users كاملاً — نفس تقييد صلاحيات القاعدة الأصلية.
chmod 600 "${TARGET}"

SRC_BYTES="$(wc -c < "${DB_PATH}" | tr -d ' ')"
DST_BYTES="$(wc -c < "${TARGET}" | tr -d ' ')"
log "==> done   : ${DST_BYTES} bytes (source ${SRC_BYTES} bytes + ${WAL_BYTES} WAL)"

if [[ "${VERIFY}" -eq 1 ]]; then
  INTEGRITY="$(sqlite3 "${TARGET}" 'PRAGMA integrity_check;' | head -1)"
  if [[ "${INTEGRITY}" != "ok" ]]; then
    err "integrity_check FAILED on the backup: ${INTEGRITY}"
    exit 3
  fi
  FK_VIOLATIONS="$(sqlite3 "${TARGET}" 'PRAGMA foreign_key_check;' | wc -l | tr -d ' ')"
  log "==> verify : integrity ok, foreign_key_check violations = ${FK_VIOLATIONS}"
  # انتهاكات الـ FK حالة قائمة في القاعدة نفسها، لا فشل في النسخ — تُبلَّغ ولا
  # تُفشِل السكربت. (Pre-existing FK violations are reported, not fatal.)
fi

# لا تدوير ولا حذف: كل النسخ تبقى. (No rotation: every backup is kept.)
KEPT="$(find "${OUT_DIR}" -maxdepth 1 -name '*.sqlite' -type f | wc -l | tr -d ' ')"
log "==> kept   : ${KEPT} backup(s) in ${OUT_DIR} (nothing is ever deleted)"

printf '%s\n' "${TARGET}"
