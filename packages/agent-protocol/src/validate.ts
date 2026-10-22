import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import type { ValidateFunction } from 'ajv';

export const MESSAGE_KINDS = [
  'enroll-request',
  'enroll-response',
  'heartbeat',
  'agent-task',
  'stream-chunk',
  'inventory',
] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

// ajv-formats is CommonJS; its default export arrives as the module object under NodeNext.
const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

const validators = new Map<MessageKind, ValidateFunction>(
  MESSAGE_KINDS.map((kind) => {
    const schema = JSON.parse(
      readFileSync(new URL(`../schemas/${kind}.schema.json`, import.meta.url), 'utf8'),
    );
    return [kind, ajv.compile(schema)];
  }),
);

export function validateMessage(kind: MessageKind, data: unknown): ValidationResult {
  const validate = validators.get(kind);
  if (!validate) throw new Error(`unknown message kind: ${kind}`);
  if (validate(data)) return { ok: true };
  return {
    ok: false,
    errors: (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`),
  };
}
