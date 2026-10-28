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

export type ExplicitMaterialInput =
  | { scripts: ScriptMaterial[]; material_ref?: never }
  | { scripts?: never; material_ref: string };

export interface FormMetadata {
  id?: string;
  name?: string;
}

type ShapeRequestBase = {
  source_url: string;
  profile: BrowserProfile;
  request: TargetRequest;
  document_cookie?: string;
};

export type MaterialInput = ExplicitMaterialInput | { scripts?: never; material_ref?: never };

export type HeaderShapeRequest = ShapeRequestBase & MaterialInput & { mode?: "header"; form?: never };
export type FormShapeRequest = ShapeRequestBase & ExplicitMaterialInput & { mode: "form"; form?: FormMetadata };
export type ShapeRequest<Mode extends "header" | "form" = "header"> =
  Mode extends "form" ? FormShapeRequest : HeaderShapeRequest;

/** Optional operation metadata returned by the API. Use fallback_reason to detect fallback. */
export interface OperationMetadata {
  path?: "native" | "isolated";
  material_reuse?: boolean;
  discovery_duration_ms?: number | null;
  discovery_state?: string | null;
  fallback_reason?: string | null;
  fallback_message?: string;
}

interface HeaderResult extends OperationMetadata {
  headers: Record<string, string>;
  request_id: string;
  generation_ms: number;
  profile_used: BrowserProfile;
  material_ref: string;
  material_expires_at: string;
}

export interface FormShapeResult extends OperationMetadata {
  form_fields: Record<string, string>;
  /** Telemetry only, already encoded once in observed insertion order. */
  form_body: string;
  request_id: string;
  generation_ms: number;
  profile_used: BrowserProfile;
  material_ref: string;
  material_expires_at: string;
}

/** Result transport follows the requested mode; existing users default to headers. */
export type ShapeResult<Mode extends "header" | "form" = "header"> =
  Mode extends "form" ? FormShapeResult : HeaderResult;

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
  | "preparation_failed"
  | "preparation_expired"
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
  preparationId?: string;
  reason?: string;
  action?: string;
  domain?: string;
  field?: string;
  billingStatus?: "not_charged" | "pending" | "unknown";
  retryable?: boolean;
  statusCode?: number;
  requestId?: string;
  retryAfter?: string;
  code?: string;
}

export type PreparationState = 'queued' | 'learning' | 'validating' | 'publishing' | 'ready' | 'failed' | 'expired';
export interface PreparationError {
  code: string;
  reason?: string;
  retryable?: boolean;
}
/** Server readiness metadata. Contains no collected source, cookies or generated telemetry. */
export interface MaterialPreparation {
  preparation_id: string;
  state: PreparationState;
  status_url: string;
  retry_after_ms: number;
  preparation_expires_at: string;
  material_ref: string;
  material_expires_at: string;
  ready_until: string | null;
  execution_backend: 'rust' | null;
  error: PreparationError | null;
}
export interface ReadyMaterial extends MaterialPreparation {
  state: 'ready';
  ready_until: string;
  execution_backend: 'rust';
  error: null;
}
export interface PreparationOptions extends RequestOptions {}
export interface GetPreparationOptions extends RequestOptions { wait?: number }
export interface WaitUntilReadyOptions extends RequestOptions { waitTimeoutMs?: number }
