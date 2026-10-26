import { RayonError, trustedGuidance } from "./errors.js";
import { isRecord } from "./json.js";
import type { ErrorMetadata, MaterialPreparation, PreparationState } from "./types.js";

const fields = [
  "preparation_id", "state", "status_url", "retry_after_ms", "preparation_expires_at",
  "material_ref", "material_expires_at", "ready_until", "execution_backend", "error",
];
const states = ["queued", "learning", "validating", "publishing", "ready", "failed", "expired"];

export function preparationId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value);
}

function timestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(?:Z|([+-])(\d\d):(\d\d))$/.exec(value);
  if (!match) return false;
  const [, y, m, d, h, min, sec, , oh, om] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] &&
    Number(h) <= 23 && Number(min) <= 59 && Number(sec) <= 59 &&
    (oh === undefined || (Number(oh) <= 23 && Number(om) <= 59)) &&
    Number.isFinite(Date.parse(value));
}

export function parsePreparation(
  value: unknown, metadata: ErrorMetadata, key: string, expectedId?: string,
): MaterialPreparation {
  try {
    if (!isRecord(value) || Object.keys(value).length !== fields.length ||
        Object.keys(value).some(k => !fields.includes(k)) ||
        !preparationId(value.preparation_id) || value.preparation_id.includes(key) ||
        (expectedId !== undefined && value.preparation_id !== expectedId) ||
        !states.includes(value.state as string) ||
        value.status_url !== `/v1/materials/preparations/${value.preparation_id}` ||
        !Number.isSafeInteger(value.retry_after_ms) || (value.retry_after_ms as number) < 0 ||
        (value.retry_after_ms as number) > 60000 ||
        !timestamp(value.preparation_expires_at) || !preparationId(value.material_ref) ||
        value.material_ref.includes(key) || !timestamp(value.material_expires_at)) throw new Error();

    const ready = value.state === "ready";
    const terminal = value.state === "failed" || value.state === "expired";
    if (ready
      ? (!timestamp(value.ready_until) || value.execution_backend !== "rust")
      : (value.ready_until !== null || value.execution_backend !== null)) throw new Error();

    let error: MaterialPreparation["error"] = null;
    if (terminal) {
      if (!isRecord(value.error) ||
          Object.keys(value.error).some(k => !["code", "reason", "retryable", "action"].includes(k)) ||
          typeof value.error.code !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(value.error.code) ||
          value.error.code.includes(key) ||
          (value.error.reason !== undefined && (typeof value.error.reason !== "string" || value.error.reason.length > 128)) ||
          (value.error.action !== undefined && (typeof value.error.action !== "string" || value.error.action.length > 2048)) ||
          (value.error.retryable !== undefined && typeof value.error.retryable !== "boolean")) throw new Error();
      // Only locally trusted guidance can expose a reason. Server action text is never retained.
      const guidance = trustedGuidance(value.error.code, value.error.reason as string | undefined);
      error = {
        code: value.error.code,
        ...(guidance ? { reason: guidance.reason } : {}),
        ...(typeof value.error.retryable === "boolean" ? { retryable: value.error.retryable } : {}),
      };
    } else if (value.error !== null) throw new Error();

    return {
      preparation_id: value.preparation_id,
      state: value.state as PreparationState,
      status_url: value.status_url as string,
      retry_after_ms: value.retry_after_ms as number,
      preparation_expires_at: value.preparation_expires_at,
      material_ref: value.material_ref,
      material_expires_at: value.material_expires_at,
      ready_until: value.ready_until as string | null,
      execution_backend: ready ? "rust" : null,
      error,
    };
  } catch {
    throw new RayonError("invalid_response", metadata);
  }
}

/** JSON.parse accepts duplicate keys and overflowing numbers. Preparation frames reject both. */
export function strictJson(text: string): unknown {
  let pos = 0;
  const whitespace = () => {
    while (pos < text.length && /\s/.test(text[pos])) pos++;
  };
  const string = (): string => {
    const start = pos++;
    while (pos < text.length) {
      const char = text[pos++];
      if (char === '"') return JSON.parse(text.slice(start, pos)) as string;
      if (char === "\\") pos++;
    }
    throw new Error();
  };
  const value = (depth: number): void => {
    if (depth > 64) throw new Error();
    whitespace();
    if (text[pos] === '"') { string(); return; }
    if (text[pos] === "{") {
      pos++;
      whitespace();
      const keys = new Set<string>();
      if (text[pos] === "}") { pos++; return; }
      while (pos < text.length) {
        whitespace();
        if (text[pos] !== '"') throw new Error();
        const key = string();
        if (keys.has(key)) throw new Error();
        keys.add(key);
        whitespace();
        if (text[pos++] !== ":") throw new Error();
        value(depth + 1);
        whitespace();
        const char = text[pos++];
        if (char === "}") return;
        if (char !== ",") throw new Error();
      }
      throw new Error();
    }
    if (text[pos] === "[") {
      pos++;
      whitespace();
      if (text[pos] === "]") { pos++; return; }
      while (pos < text.length) {
        value(depth + 1);
        whitespace();
        const char = text[pos++];
        if (char === "]") return;
        if (char !== ",") throw new Error();
      }
      throw new Error();
    }
    const start = pos;
    while (pos < text.length && !/[\s,\]}]/.test(text[pos])) pos++;
    if (start === pos) throw new Error();
    const parsed: unknown = JSON.parse(text.slice(start, pos));
    if (typeof parsed === "number" && !Number.isFinite(parsed)) throw new Error();
  };
  value(0);
  whitespace();
  if (pos !== text.length) throw new Error();
  return JSON.parse(text) as unknown;
}
