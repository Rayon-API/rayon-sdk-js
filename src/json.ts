import type { JsonValue, Profile } from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

export function copyJson(value: unknown, ancestors = new Set<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || ancestors.has(value))
    throw new Error("Invalid JSON value");
  ancestors.add(value);
  try {
    if (Array.isArray(value))
      return Array.from(value, (item) => copyJson(item, ancestors));
    if (!isRecord(value)) throw new Error("Invalid JSON object");
    const copied: Profile = Object.create(null);
    for (const [key, item] of Object.entries(value)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype")
        throw new Error("Unsafe JSON key");
      copied[key] = copyJson(item, ancestors);
    }
    return copied;
  } finally {
    ancestors.delete(value);
  }
}
