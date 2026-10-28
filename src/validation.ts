import type { ShapeRequest, BrowserProfile } from "./types.js";
import { RayonError } from "./errors.js";
import { copyJson, isRecord } from "./json.js";
import { validate_profile } from "./profile.js";

export function validUrl(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    Array.from(value).length > 8192 ||
    /[\u0000-\u0020\u007f\\#]/.test(value)
  )
    return false;
  const authority = /^https?:\/\/([^/?#]*)/i.exec(value);
  if (!authority || !authority[1] || authority[1].includes("@")) return false;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      !parsed.username &&
      !parsed.password &&
      parsed.port !== "0"
    );
  } catch {
    return false;
  }
}

const FORM_NAME = /^([!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128})([abcdfz])$/;

export function formPairs(body: unknown): [string, string][] {
  if (
    typeof body !== "string" ||
    Buffer.byteLength(body) > 256 * 1024 ||
    Buffer.from(body).toString("utf8") !== body ||
    /%(?![0-9A-Fa-f]{2})/.test(body)
  ) throw new Error();
  const pairs: [string, string][] = [];
  for (const part of body.split("&")) {
    if (!part) continue;
    const index = part.indexOf("=");
    const rawKey = index < 0 ? part : part.slice(0, index);
    const rawValue = index < 0 ? "" : part.slice(index + 1);
    const key = decodeURIComponent(rawKey.replace(/\+/g, " "));
    const value = decodeURIComponent(rawValue.replace(/\+/g, " "));
    if (
      key.includes("\0") || value.includes("\0") || Buffer.byteLength(key) > 256
    ) throw new Error();
    pairs.push([key, value]);
    if (pairs.length > 1024) throw new Error();
  }
  return pairs;
}

function validateFormRequest(
  v: Record<string, unknown>, r: Record<string, unknown>,
) {
  const mode = Object.hasOwn(v, "mode") ? v.mode : "header";
  if (mode !== "header" && mode !== "form") throw new Error();
  if (mode === "header") {
    if (Object.hasOwn(v, "form")) throw new Error();
    return;
  }
  if (
    r.method !== "POST" ||
    typeof r.content_type !== "string" ||
    !/^application\/x-www-form-urlencoded(?:\s*;\s*charset\s*=\s*(?:"(?:utf-8|utf8)"|utf-8|utf8))?\s*$/i.test(r.content_type)
  ) throw new Error();
  if (Object.hasOwn(v, "form")) {
    if (
      !isRecord(v.form) ||
      Object.keys(v.form).some(k => !["id", "name"].includes(k))
    ) throw new Error();
    for (const value of Object.values(v.form)) {
      if (
        typeof value !== "string" ||
        Array.from(value).length > 256 ||
        Buffer.from(value).toString("utf8") !== value ||
        /[\u0000-\u001f\u007f]/.test(value)
      ) throw new Error();
    }
  }
  const families = new Map<string, Set<string>>();
  for (const [name] of formPairs(r.body)) {
    const match = FORM_NAME.exec(name);
    if (match) {
      const slots = families.get(match[1]) ?? new Set<string>();
      slots.add(match[2]);
      families.set(match[1], slots);
    }
  }
  if ([...families.values()].some(slots => slots.size === 6)) throw new Error();
}

export function safeFormFields(
  fields: unknown, body: unknown,
): Record<string, string> {
  if (!isRecord(fields) || Object.keys(fields).length !== 6) throw new Error();
  const copied: Record<string, string> = Object.create(null);
  const families = new Set<string>();
  const slots = new Set<string>();
  for (const [name, value] of Object.entries(fields)) {
    const match = FORM_NAME.exec(name);
    if (
      !match || typeof value !== "string" || Buffer.byteLength(value) > 16384 ||
      /[\u0000-\u001f\u007f]/.test(value) || (match[2] !== "d" && !value)
    ) throw new Error();
    // URLSearchParams would silently replace invalid Unicode surrogates.
    if (Buffer.from(value).toString("utf8") !== value) throw new Error();
    families.add(match[1]);
    slots.add(match[2]);
    copied[name] = value;
  }
  if (
    families.size !== 1 || slots.size !== 6 || typeof body !== "string" ||
    Buffer.byteLength(body) > 256 * 1024 ||
    new URLSearchParams(Object.entries(copied)).toString() !== body
  ) throw new Error();
  return copied;
}

export function validateShape(
  value: ShapeRequest<"header" | "form">,
  requireMaterial = false,
): ShapeRequest<"header" | "form"> {
  try {
    const v = copyJson(value) as Record<string, unknown>;
    if (
      !isRecord(v) ||
      !["source_url", "profile", "request"].every((k) => Object.hasOwn(v, k)) ||
      Object.keys(v).some(
        (k) =>
          ![
            "source_url",
            "scripts",
            "material_ref",
            "profile",
            "request",
            "document_cookie",
            "mode",
            "form",
          ].includes(k),
      ) ||
      !validUrl(v.source_url) ||
      (Object.hasOwn(v, "scripts") && Object.hasOwn(v, "material_ref")) ||
      ((requireMaterial || v.mode === "form") && !Object.hasOwn(v, "scripts") && !Object.hasOwn(v, "material_ref"))
    )
      throw new Error();
    if (Object.hasOwn(v, "scripts")) {
      if (
        !Array.isArray(v.scripts) ||
        v.scripts.length < 1 ||
        v.scripts.length > 16
      )
        throw new Error();
      for (const script of v.scripts)
        if (
          !isRecord(script) ||
          Object.keys(script).length !== 2 ||
          !validUrl(script.url) ||
          typeof script.source !== "string" ||
          !script.source ||
          Buffer.byteLength(script.source) > 2 * 1024 * 1024
        )
          throw new Error();
      if (
        v.scripts.reduce(
          (n: number, s: any) => n + Buffer.byteLength(s.source),
          0,
        ) >
        3 * 1024 * 1024
      )
        throw new Error();
    } else if (Object.hasOwn(v, "material_ref") && (
      typeof v.material_ref !== "string" ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(v.material_ref)
    ))
      throw new Error();
    v.profile = validate_profile(v.profile as BrowserProfile);
    const r = v.request;
    if (
      !isRecord(r) ||
      Object.keys(r).length !== 4 ||
      !["url", "method", "content_type", "body"].every((k) =>
        Object.hasOwn(r, k),
      ) ||
      !validUrl(r.url) ||
      typeof r.method !== "string" ||
      !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(
        r.method,
      )
    )
      throw new Error();
    if (
      r.content_type !== null &&
      (typeof r.content_type !== "string" ||
        r.content_type.length > 256 ||
        !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(?:\s*;[^\r\n]*)?$/.test(
          r.content_type,
        ) ||
        /[\u0000-\u001f\u007f]/.test(r.content_type))
    )
      throw new Error();
    if (
      r.body !== null &&
      (typeof r.body !== "string" || Buffer.byteLength(r.body) > 256 * 1024)
    )
      throw new Error();
    if (
      r.body !== null &&
      (r.method === "GET" ||
        r.method === "HEAD" ||
        !r.content_type ||
        [
          "application/octet-stream",
          "application/pdf",
          "application/zip",
        ].includes((r.content_type as string).split(";")[0].toLowerCase()) ||
        /^(image|audio|video|multipart)\//i.test(r.content_type as string))
    )
      throw new Error();
    validateFormRequest(v, r);
    if (
      Object.hasOwn(v, "document_cookie") &&
      (typeof v.document_cookie !== "string" ||
        Buffer.byteLength(v.document_cookie) > 16 * 1024 ||
        /[\u0000-\u001f\u007f]/.test(v.document_cookie))
    )
      throw new Error();
    if (Buffer.byteLength(JSON.stringify(v)) > 4 * 1024 * 1024)
      throw new Error();
    return v as unknown as ShapeRequest<"header" | "form">;
  } catch {
    throw new RayonError("validation");
  }
}
