import type { BrowserProfile, Profile, JsonValue } from "./types.js";
import { RayonError } from "./errors.js";
import { isRecord, copyJson } from "./json.js";

const profileFields = {
  user_agent: "string",
  platform: "string",
  language: "string",
  languages: "strings",
  screen: "object",
  window: "object",
  webgl: "object",
  canvas: "object",
  navigator: "object",
};

const intFields = (names: string[]) =>
  Object.fromEntries(names.map((k) => [k, "integer"]));

const nestedFields: Record<string, Record<string, string>> = {
  screen: intFields([
    "width",
    "height",
    "availWidth",
    "availHeight",
    "colorDepth",
    "pixelDepth",
  ]),
  window: {
    ...intFields([
      "innerWidth",
      "innerHeight",
      "outerWidth",
      "outerHeight",
      "screenX",
      "screenY",
      "screenLeft",
      "screenTop",
      "pageXOffset",
      "pageYOffset",
    ]),
    devicePixelRatio: "number",
  },
  webgl: { renderer: "string", vendor: "string" },
  canvas: { data_url: "string" },
  navigator: {
    ...Object.fromEntries(
      [
        "userAgent",
        "platform",
        "vendor",
        "appVersion",
        "appCodeName",
        "appName",
        "product",
        "language",
      ].map((k) => [k, "string"]),
    ),
    languages: "strings",
    hardwareConcurrency: "integer",
    maxTouchPoints: "integer",
    webdriver: "boolean",
    cookieEnabled: "boolean",
    doNotTrack: "nullableString",
  },
};

export function checkFields(
  value: unknown,
  fields: Record<string, string>,
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([key, item]) => {
    if (!Object.hasOwn(fields, key)) return false;
    switch (fields[key]) {
      case "strings":
        return Array.isArray(item) && item.every((x) => typeof x === "string");
      case "integer":
        return Number.isSafeInteger(item);
      case "number":
        return typeof item === "number" && Number.isFinite(item);
      case "object":
        return isRecord(item);
      case "nullableString":
        return item === null || typeof item === "string";
      default:
        return typeof item === fields[key];
    }
  });
}

const DEFAULT_PROFILE = {
  user_agent: "Mozilla/5.0",
  platform: "MacIntel",
  language: "en-US",
  languages: ["en-US", "en"],
  screen: {
    width: 1920,
    height: 1080,
    availWidth: 1920,
    availHeight: 1040,
    colorDepth: 24,
    pixelDepth: 24,
  },
  window: {
    innerWidth: 1920,
    innerHeight: 1040,
    outerWidth: 1920,
    outerHeight: 1080,
    devicePixelRatio: 1.0,
    screenX: 0,
    screenY: 0,
    screenLeft: 0,
    screenTop: 0,
    pageXOffset: 0,
    pageYOffset: 0,
  },
  webgl: { renderer: "Sandbox Renderer", vendor: "Google Inc." },
  canvas: {
    data_url:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=",
  },
  navigator: {
    userAgent: "Mozilla/5.0",
    platform: "MacIntel",
    vendor: "Google Inc.",
    appVersion: "5.0",
    appCodeName: "Mozilla",
    appName: "Netscape",
    product: "Gecko",
    language: "en-US",
    languages: ["en-US", "en"],
    hardwareConcurrency: 8,
    maxTouchPoints: 0,
    webdriver: false,
    cookieEnabled: true,
    doNotTrack: null,
  },
};

export function effectiveProfileSize(profile: BrowserProfile): number {
  const effective = copyJson(DEFAULT_PROFILE) as Record<string, any>;
  for (const [key, value] of Object.entries(profile)) {
    if (isRecord(value)) Object.assign(effective[key], value);
    else effective[key] = value;
  }
  const suppliedNavigator = profile.navigator ?? {};
  for (const [top, alias] of [
    ["user_agent", "userAgent"],
    ["platform", "platform"],
    ["language", "language"],
    ["languages", "languages"],
  ]) {
    const value = Object.hasOwn(suppliedNavigator, alias)
      ? (suppliedNavigator as Record<string, unknown>)[alias]
      : effective[top];
    effective[top] = value;
    effective.navigator[alias] = value;
  }
  if (!Object.hasOwn(suppliedNavigator, "appVersion"))
    effective.navigator.appVersion = effective.user_agent.replace(
      /^Mozilla\//,
      "",
    );
  // Match Python's canonical JSON separators and floating-point DPR serialization.
  function canonical(value: any, key?: string): string {
    if (Array.isArray(value))
      return "[" + value.map((v) => canonical(v)).join(", ") + "]";
    if (isRecord(value))
      return (
        "{" +
        Object.entries(value)
          .map(([k, v]) => JSON.stringify(k) + ": " + canonical(v, k))
          .join(", ") +
        "}"
      );
    if (key === "devicePixelRatio" && Number.isInteger(value))
      return value + ".0";
    return JSON.stringify(value);
  }
  return Buffer.byteLength(canonical(effective));
}

export function validProfile(value: unknown): value is BrowserProfile {
  if (!checkFields(value, profileFields)) return false;
  if (
    Object.entries(nestedFields).some(
      ([k, fields]) =>
        Object.hasOwn(value, k) && !checkFields(value[k], fields),
    )
  )
    return false;
  const nav = value.navigator as Record<string, unknown> | undefined;
  if (
    nav &&
    [
      ["user_agent", "userAgent"],
      ["platform", "platform"],
      ["language", "language"],
      ["languages", "languages"],
    ].some(
      ([k, a]) =>
        Object.hasOwn(value, k) &&
        Object.hasOwn(nav, a) &&
        JSON.stringify(value[k]) !== JSON.stringify(nav[a]),
    )
  )
    return false;
  const canvas = value.canvas as Record<string, string> | undefined;
  if (
    canvas &&
    Object.hasOwn(canvas, "data_url") &&
    !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(canvas.data_url)
  )
    return false;
  for (const obj of [value, nav, value.webgl]) {
    if (isRecord(obj)) {
      if (
        Object.values(obj).some(
          (v) => typeof v === "string" && Array.from(v).length > 8192,
        )
      )
        return false;
      if (
        Object.hasOwn(obj, "languages") &&
        ((obj.languages as string[]).length < 1 ||
          (obj.languages as string[]).length > 32 ||
          (obj.languages as string[]).some((v) => Array.from(v).length > 8192))
      )
        return false;
    }
  }
  const ranges: Record<string, Record<string, [number, number]>> = {
    screen: {
      width: [1, 32768],
      height: [1, 32768],
      availWidth: [0, 32768],
      availHeight: [0, 32768],
      colorDepth: [1, 64],
      pixelDepth: [1, 64],
    },
    window: {
      innerWidth: [1, 32768],
      innerHeight: [1, 32768],
      outerWidth: [1, 32768],
      outerHeight: [1, 32768],
      devicePixelRatio: [0.1, 16],
      ...Object.fromEntries(
        [
          "screenX",
          "screenY",
          "screenLeft",
          "screenTop",
          "pageXOffset",
          "pageYOffset",
        ].map((k) => [k, [-2147483648, 2147483647] as [number, number]]),
      ),
    },
    navigator: { hardwareConcurrency: [1, 1024], maxTouchPoints: [0, 100] },
  };
  for (const [section, fields] of Object.entries(ranges)) {
    const obj = value[section];
    if (
      isRecord(obj) &&
      Object.entries(fields).some(
        ([k, [lo, hi]]) =>
          Object.hasOwn(obj, k) &&
          ((obj[k] as number) < lo || (obj[k] as number) > hi),
      )
    )
      return false;
  }
  return true;
}

/** Validate browser identity offline; return a deep copy of supplied fields. */
export function validate_profile(profile: BrowserProfile): BrowserProfile {
  try {
    const checked = copyJson(profile);
    if (!validProfile(checked) || effectiveProfileSize(checked) > 64 * 1024)
      throw new Error();
    return checked;
  } catch {
    throw new RayonError("validation");
  }
}
