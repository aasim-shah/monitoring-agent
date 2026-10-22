/**
 * Named, reviewed aggregate templates (BR-07-02): the only queries the platform runs
 * against customer databases. There is no free-form query path; a template that could
 * write is rejected when it is defined, and sessions are read-only besides.
 */
export type TemplateEngine = 'postgres' | 'mysql' | 'mongodb';

declare const readOnly: unique symbol;

interface TemplateBase {
  name: string;
  description: string;
  readonly [readOnly]: true;
}

export type ReadOnlyTemplate =
  | (TemplateBase & {
      engine: 'postgres' | 'mysql';
      /** One SELECT/WITH statement; `$1`/`$2` (PostgreSQL) or `?` (MySQL) are from/to; `{{name}}` are identifiers from config. */
      query: string;
    })
  | (TemplateBase & { engine: 'mongodb'; pipeline: unknown[] });

export type TemplateDefinition =
  | { name: string; description: string; engine: 'postgres' | 'mysql'; query: string }
  | { name: string; description: string; engine: 'mongodb'; pipeline: unknown[] };

const WRITE_KEYWORDS =
  /\b(insert|update|delete|merge|upsert|replace|create|alter|drop|truncate|rename|grant|revoke|copy|call|do|exec|execute|vacuum|analyze|lock|set|reset|refresh|cluster|reindex|comment|security|into|load|handler|prepare|deallocate|listen|notify|import|attach|detach)\b/i;

const WRITE_FUNCTIONS =
  /\b(pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_promote|pg_create_\w+|pg_drop_\w+|pg_switch_wal|pg_advisory\w*|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_write\w*|lo_\w+|set_config|nextval|setval|dblink\w*|sleep|pg_sleep\w*|benchmark|load_file|get_lock|release_lock)\s*\(/i;

/** Removes comments and string/identifier literals so keywords inside them do not count. */
function stripLiterals(query: string): string {
  return query
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/`(?:[^`]|``)*`/g, '``');
}

const notReadOnly = (name: string, why: string) => new Error(`template ${name} is not read-only: ${why}`);

function assertReadOnlySql(name: string, query: string): void {
  const code = stripLiterals(query).trim().replace(/;\s*$/, '');
  if (!/^(select|with)\b/i.test(code)) throw notReadOnly(name, 'must start with SELECT or WITH');
  if (code.includes(';')) throw notReadOnly(name, 'only one statement is allowed');
  const keyword = WRITE_KEYWORDS.exec(code);
  if (keyword) throw notReadOnly(name, `contains ${keyword[1]!.toUpperCase()}`);
  const fn = WRITE_FUNCTIONS.exec(code);
  if (fn) throw notReadOnly(name, `calls ${fn[1]}`);
  if (/\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/i.test(code))
    throw notReadOnly(name, 'takes row locks');
}

const MONGO_FORBIDDEN = new Set(['$out', '$merge', '$function', '$where', '$accumulator']);

function assertReadOnlyPipeline(name: string, value: unknown): void {
  if (Array.isArray(value)) return value.forEach((v) => assertReadOnlyPipeline(name, v));
  if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) {
      if (MONGO_FORBIDDEN.has(k)) throw notReadOnly(name, `uses ${k}`);
      assertReadOnlyPipeline(name, v);
    }
}

export function defineTemplate(def: TemplateDefinition): ReadOnlyTemplate {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(def.name)) throw new Error(`invalid template name ${def.name}`);
  if (def.engine === 'mongodb') assertReadOnlyPipeline(def.name, def.pipeline);
  else assertReadOnlySql(def.name, def.query);
  return Object.freeze({ ...def }) as ReadOnlyTemplate;
}
