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
#   القاعدة تعمل بنمط WAL: أي كتلة مُثبَّتة (committed) قد تبقى في ملف `-wal`
#   الجانبي حتى يجري checkpoint. لذلك نسخ ملف القاعدة وحده قد يفقد ما لم
#   يُدمَج بعد.
#
#   The database runs in WAL mode: a COMMITTED transaction lives in the `-wal`
#   sidecar until a checkpoint folds it back into the main file. Copying the
#   database file alone therefore risks losing committed data not yet merged.
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
#   --verify   إضافة foreign_key_check؛ integrity_check إلزامي دائماً.
#
# ملاحظات / Notes:
#   * القراءة من القاعدة الحيّة بوضع `mode=ro` — لا كتابة في المصدر إطلاقاً.
#   * NASSAJ_BACKUP_RETENTION يحدد عدد النسخ المحتفظ بها (افتراضياً 5).
#   * دليل النسخ 0700 والملف 0600 منذ الإنشاء؛ كلاهما مملوك للمستخدم الحالي.
#   * exit 0 نجاح، 1 خطأ استعمال/بيئة، 2 فشل النسخ، 3 فشل التحقّق.
# ============================================================================

set -Eeuo pipefail
umask 077

DATA_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}"
DATA_DIR="${NASSAJ_DATA_DIR:-${DATA_HOME}/nassaj-dev}"
DEFAULT_DB="${DATA_DIR}/db.sqlite"

DB_PATH=""
OUT_DIR=""
LABEL=""
VERIFY=0
QUIET=0
RETENTION="${NASSAJ_BACKUP_RETENTION:-5}"

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

if [[ ! "${RETENTION}" =~ ^[1-9][0-9]*$ ]]; then
  err "NASSAJ_BACKUP_RETENTION must be a positive integer"
  exit 1
fi

if [[ -n "${LABEL}" && ! "${LABEL}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; then
  err "label must be 1..64 canonical characters: A-Z a-z 0-9 . _ -"
  exit 1
fi

if [[ -z "${DB_PATH}" ]]; then
  DB_PATH="${DATABASE_PATH:-${DEFAULT_DB}}"
fi

if [[ ! -f "${DB_PATH}" ]]; then
  err "database not found: ${DB_PATH}"
  exit 1
fi

DB_DIR="$(cd "$(dirname "${DB_PATH}")" && pwd -P)"
DB_FILE="$(basename "${DB_PATH}")"
DB_PATH="${DB_DIR}/${DB_FILE}"

if [[ -z "${OUT_DIR}" ]]; then
  OUT_DIR="${DB_DIR}/backups"
fi
OUT_LEXICAL="$(realpath -s -m -- "${OUT_DIR}")"
mkdir -p -- "${OUT_LEXICAL}"
OUT_RESOLVED="$(realpath -e -- "${OUT_LEXICAL}")"
if [[ "${OUT_RESOLVED}" != "${OUT_LEXICAL}" || -L "${OUT_LEXICAL}" || ! -d "${OUT_LEXICAL}" ]]; then
  err "output directory must be a real directory without symlink components"
  exit 2
fi
OUT_DIR="${OUT_RESOLVED}"

CURRENT_UID="$(id -u)"
OUT_UID="$(stat -c '%u' -- "${OUT_DIR}")"
if [[ "${OUT_UID}" != "${CURRENT_UID}" ]]; then
  err "output directory must be owned by the current user"
  exit 2
fi
chmod 700 -- "${OUT_DIR}"
if [[ "$(stat -c '%a' -- "${OUT_DIR}")" != "700" ]]; then
  err "output directory mode must be 0700"
  exit 2
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SUFFIX=""
[[ -n "${LABEL}" ]] && SUFFIX="-${LABEL}"
TARGET="${OUT_DIR}/${DB_FILE%.sqlite}-${STAMP}${SUFFIX}.sqlite"

if [[ -e "${TARGET}" || -L "${TARGET}" ]]; then
  err "refusing to overwrite an existing backup: ${TARGET}"
  exit 2
fi

# القراءة بـ mode=ro: SQLite ترفض أي كتابة في المصدر، وVACUUM INTO يكتب في
# الوجهة فقط. (Read-only source; VACUUM INTO writes only to the destination.)
SOURCE_URI="file:${DB_PATH}?mode=ro"
SQL_TARGET="${TARGET//\'/\'\'}"

log "==> source : ${DB_PATH}"
log "==> target : ${TARGET}"

WAL_BYTES=0
[[ -f "${DB_PATH}-wal" ]] && WAL_BYTES="$(wc -c < "${DB_PATH}-wal" | tr -d ' ')"
log "==> wal    : ${WAL_BYTES} bytes pending merge (lost by a plain cp)"

if ! sqlite3 "${SOURCE_URI}" "VACUUM INTO '${SQL_TARGET}';" 2>/dev/null; then
  log "    VACUUM INTO unavailable, falling back to .backup"
  if ! sqlite3 "${SOURCE_URI}" ".backup '${SQL_TARGET}'"; then
    err "backup FAILED for ${DB_PATH}"
    rm -f "${TARGET}"
    exit 2
  fi
fi

if [[ ! -s "${TARGET}" || -L "${TARGET}" || ! -f "${TARGET}" ]]; then
  err "backup produced an empty or invalid file: ${TARGET}"
  rm -f -- "${TARGET}"
  exit 2
fi

TARGET_UID="$(stat -c '%u' -- "${TARGET}")"
TARGET_MODE="$(stat -c '%a' -- "${TARGET}")"
TARGET_LINKS="$(stat -c '%h' -- "${TARGET}")"
if [[ "${TARGET_UID}" != "${CURRENT_UID}" || "${TARGET_MODE}" != "600" || "${TARGET_LINKS}" != "1" ]]; then
  err "backup file must be owner-only, regular, and singly linked from creation"
  rm -f -- "${TARGET}"
  exit 2
fi

SRC_BYTES="$(wc -c < "${DB_PATH}" | tr -d ' ')"
DST_BYTES="$(wc -c < "${TARGET}" | tr -d ' ')"
log "==> done   : ${DST_BYTES} bytes (source ${SRC_BYTES} bytes + ${WAL_BYTES} WAL)"

if ! INTEGRITY_OUTPUT="$(sqlite3 "${TARGET}" 'PRAGMA integrity_check;')"; then
  err "integrity_check could not read the backup"
  rm -f -- "${TARGET}"
  exit 3
fi
INTEGRITY="$(printf '%s\n' "${INTEGRITY_OUTPUT}" | head -1)"
if [[ "${INTEGRITY}" != "ok" ]]; then
  err "integrity_check FAILED on the backup: ${INTEGRITY}"
  rm -f -- "${TARGET}"
  exit 3
fi
log "==> verify : integrity ok"

if [[ "${VERIFY}" -eq 1 ]]; then
  FK_VIOLATIONS="$(sqlite3 "${TARGET}" 'PRAGMA foreign_key_check;' | wc -l | tr -d ' ')"
  log "==> verify : foreign_key_check violations = ${FK_VIOLATIONS}"
  # انتهاكات الـ FK حالة قائمة في القاعدة نفسها، لا فشل في النسخ — تُبلَّغ ولا
  # تُفشِل السكربت. (Pre-existing FK violations are reported, not fatal.)
fi

# Persist the verified file and directory entry before retention can delete an
# older backup. Fsync the directory again after rotation.
node --input-type=module - "${TARGET}" "${OUT_DIR}" <<'NODE'
import fs from 'node:fs';
const [file, dir] = process.argv.slice(2);
for (const [target, flags] of [
  [file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW],
  [dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW],
]) {
  const fd = fs.openSync(target, flags);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
NODE

TARGET="${TARGET}" OUT_DIR="${OUT_DIR}" DB_PREFIX="${DB_FILE%.sqlite}-" \
RETENTION="${RETENTION}" CURRENT_UID="${CURRENT_UID}" node --input-type=module <<'NODE'
import fs from 'node:fs';
import path from 'node:path';

const dir = process.env.OUT_DIR;
const target = process.env.TARGET;
const prefix = process.env.DB_PREFIX;
const retention = Number(process.env.RETENTION);
const uid = Number(process.env.CURRENT_UID);
const candidates = [];

for (const name of fs.readdirSync(dir)) {
  if (!name.startsWith(prefix) || !name.endsWith('.sqlite')) continue;
  const file = path.join(dir, name);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || stat.nlink !== 1) continue;
  candidates.push({ file, mtime: stat.mtimeMs });
}

const ordered = [
  ...candidates.filter((entry) => entry.file === target),
  ...candidates.filter((entry) => entry.file !== target)
    .sort((a, b) => b.mtime - a.mtime || b.file.localeCompare(a.file)),
];
if (ordered[0]?.file !== target) throw new Error('verified backup missing before retention');
for (const entry of ordered.slice(retention)) fs.unlinkSync(entry.file);

const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
NODE

KEPT="$(find "${OUT_DIR}" -maxdepth 1 -name "${DB_FILE%.sqlite}-*.sqlite" -type f | wc -l | tr -d ' ')"
log "==> kept   : ${KEPT} backup(s) in ${OUT_DIR} (retention ${RETENTION})"

printf '%s\n' "${TARGET}"
