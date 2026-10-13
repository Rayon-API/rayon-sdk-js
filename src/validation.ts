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

export function validateShape(value: ShapeRequest): ShapeRequest {
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
          ].includes(k),
      ) ||
      !validUrl(v.source_url) ||
      Object.hasOwn(v, "scripts") === Object.hasOwn(v, "material_ref")
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
    } else if (
      typeof v.material_ref !== "string" ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(v.material_ref)
    )
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
    if (
      Object.hasOwn(v, "document_cookie") &&
      (typeof v.document_cookie !== "string" ||
        Buffer.byteLength(v.document_cookie) > 16 * 1024 ||
        /[\u0000-\u001f\u007f]/.test(v.document_cookie))
    )
      throw new Error();
    if (Buffer.byteLength(JSON.stringify(v)) > 4 * 1024 * 1024)
      throw new Error();
    return v as unknown as ShapeRequest;
  } catch {
    throw new RayonError("validation");
  }
}
