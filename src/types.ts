import type { Dispatcher } from "undici";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type Profile = { [key: string]: JsonValue };

export interface BrowserProfile {
  user_agent?: string;
  platform?: string;
  language?: string;
  languages?: string[];
  screen?: {
    width?: number;
    height?: number;
    availWidth?: number;
    availHeight?: number;
    colorDepth?: number;
    pixelDepth?: number;
  };
  window?: {
    innerWidth?: number;
    innerHeight?: number;
    outerWidth?: number;
    outerHeight?: number;
    screenX?: number;
    screenY?: number;
    screenLeft?: number;
    screenTop?: number;
    pageXOffset?: number;
    pageYOffset?: number;
    devicePixelRatio?: number;
  };
  webgl?: { renderer?: string; vendor?: string };
  canvas?: { data_url?: string };
  navigator?: {
    userAgent?: string;
    platform?: string;
    vendor?: string;
    appVersion?: string;
    appCodeName?: string;
    appName?: string;
    product?: string;
    language?: string;
    languages?: string[];
    hardwareConcurrency?: number;
    maxTouchPoints?: number;
    webdriver?: boolean;
    cookieEnabled?: boolean;
    doNotTrack?: string | null;
  };
}

export interface ScriptMaterial {
  url: string;
  source: string;
}

export interface TargetRequest {
  url: string;
  method: string;
  content_type: string | null;
  body: string | null;
}

export type MaterialInput =
  | { scripts: ScriptMaterial[]; material_ref?: never }
  | { scripts?: never; material_ref: string };

export type ShapeRequest = {
  source_url: string;
  profile: BrowserProfile;
  request: TargetRequest;
  document_cookie?: string;
} & MaterialInput;

export interface ShapeResult {
  headers: Record<string, string>;
  request_id: string;
  generation_ms: number;
  profile_used: BrowserProfile;
  material_ref: string;
  material_expires_at: string;
}

export interface ClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  /** Optional injected dispatcher; owned by caller. */ dispatcher?: Dispatcher;
}

export interface GenerateOptions extends ClientOptions {
  signal?: AbortSignal;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface UsageResult {
  request_id?: string;
  daily_used?: number;
  monthly_used?: number;
  [key: string]: JsonValue | undefined;
}

export type RayonErrorKind =
  | "validation"
  | "auth"
  | "rate_limit"
  | "http"
  | "migration"
  | "invalid_response"
  | "network"
  | "timeout"
  | "aborted";

export interface ErrorMetadata {
  statusCode?: number;
  requestId?: string;
  retryAfter?: string;
  code?: string;
}
