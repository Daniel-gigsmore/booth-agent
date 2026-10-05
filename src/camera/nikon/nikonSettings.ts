import { NikonApi, NikonEnumValue, NikonRange } from "./nikonApi";
import { DISCONNECT_RESULTS, exposureModeLabel, NK, nkError } from "./nikonLayout";
import { CameraSettings, SettingChanges, SettingKey, SettingOption } from "../edsdk/protocol";

/**
 * The operator-panel settings for the Nikon, in the Canon's vocabulary
 * (CameraSettings: a list of {code, label} per key) so the Camera tab and the
 * saved-settings file work unchanged.
 *
 * The difference is what a "code" is. EDSDK codes are fixed numbers; the
 * Nikon's options are strings the camera lists itself ("ISO 800", "f/5.6"),
 * and the list changes with the lens and exposure mode. So for the Nikon a
 * code is the option's *index in the list the camera reports right now*. The
 * label is what the operator reads, and a saved index is only as stable as the
 * camera's list - see README "Nikon control".
 */

type EnumSetting = { kind: "enum"; cap: number };
type RangeSetting = { kind: "range"; cap: number };

/** Order matters when applying: quality and white balance first, then the exposure triangle. */
export const NIKON_SETTINGS: ReadonlyArray<readonly [SettingKey, EnumSetting | RangeSetting]> = [
  ["quality", { kind: "enum", cap: NK.CAP_COMPRESSION_LEVEL }],
  ["wb", { kind: "enum", cap: NK.CAP_WB_MODE }],
  ["iso", { kind: "enum", cap: NK.CAP_SENSITIVITY }],
  ["tv", { kind: "enum", cap: NK.CAP_SHUTTER_SPEED }],
  ["av", { kind: "enum", cap: NK.CAP_APERTURE }],
  ["ev", { kind: "range", cap: NK.CAP_EXPOSURE_COMP }],
];

type Entry = { value: SettingOption | null; options: SettingOption[] };

/** "+0.3" / "-1.0" / "0": the Canon's EV labels are fractions, the SDK gives decimals - round to a tenth. */
function evLabel(ev: number): string {
  const rounded = Math.round(ev * 10) / 10;
  if (rounded === 0) return "0";
  return `${rounded > 0 ? "+" : "-"}${Math.abs(rounded).toFixed(1)}`;
}

function enumEntry(e: NikonEnumValue): Entry {
  // Only a packed-string list is something an operator can pick from; anything else shows as plain numbers.
  const options = e.options.map((o, index) => ({ code: index, label: String(o) }));
  return { value: options[e.value] ?? null, options };
}

/** A stepped range: option i is lower + i * (upper - lower) / (steps - 1). A continuous one can't be listed. */
function rangeOptions(r: NikonRange): SettingOption[] {
  if (r.steps < 2) return [];
  return Array.from({ length: r.steps }, (_, i) => ({ code: i, label: evLabel(r.lower + (i * (r.upper - r.lower)) / (r.steps - 1)) }));
}

function rangeEntry(r: NikonRange): Entry {
  const options = rangeOptions(r);
  return { value: options[r.valueIndex] ?? null, options };
}

const empty = (): Entry => ({ value: null, options: [] });

/** Reads the camera's exposure mode, or null when it won't say. */
async function readMode(api: NikonApi): Promise<string | null> {
  const { err, enum: e } = await api.getEnum(NK.CAP_EXPOSURE_MODE);
  if (err !== NK.OK || !e) return null;
  const raw = e.options[e.value];
  return typeof raw === "number" ? exposureModeLabel(raw) : null;
}

/**
 * Throws only for "the camera has gone"; a setting this body or mode doesn't
 * offer is just an empty entry (the panel shows it as unavailable).
 */
export async function readNikonSettings(api: NikonApi, rejected: SettingKey[] = []): Promise<CameraSettings> {
  const settings = {} as Record<SettingKey, Entry>;
  for (const [key, def] of NIKON_SETTINGS) {
    if (def.kind === "enum") {
      const { err, enum: e } = await api.getEnum(def.cap);
      if (DISCONNECT_RESULTS.has(err)) throw new Error(`Nikon disconnected (${nkError(err)})`);
      settings[key] = err === NK.OK && e ? enumEntry(e) : empty();
    } else {
      const { err, range } = await api.getRange(def.cap);
      if (DISCONNECT_RESULTS.has(err)) throw new Error(`Nikon disconnected (${nkError(err)})`);
      settings[key] = err === NK.OK && range ? rangeEntry(range) : empty();
    }
  }
  return { mode: await readMode(api), settings, rejected };
}

/**
 * Applies `changes` one key at a time and answers with the camera's settings
 * as they are afterwards. A key is rejected - not an error - when the camera
 * doesn't offer it in this mode, the index is outside its list, or the set
 * fails; the rest still apply. Each key is looked up fresh because setting one
 * (shutter speed in Manual, say) can change another's list.
 */
export async function applyNikonSettings(api: NikonApi, changes: SettingChanges): Promise<CameraSettings> {
  const rejected: SettingKey[] = [];
  for (const [key, def] of NIKON_SETTINGS) {
    const index = changes[key];
    if (index === undefined) continue;
    let err: number;
    if (def.kind === "enum") {
      const got = await api.getEnum(def.cap);
      if (DISCONNECT_RESULTS.has(got.err)) throw new Error(`Nikon disconnected (${nkError(got.err)})`);
      if (got.err !== NK.OK || !got.enum || index < 0 || index >= got.enum.options.length) {
        rejected.push(key);
        continue;
      }
      err = await api.setEnum(def.cap, got.enum, index);
    } else {
      const got = await api.getRange(def.cap);
      if (DISCONNECT_RESULTS.has(got.err)) throw new Error(`Nikon disconnected (${nkError(got.err)})`);
      if (got.err !== NK.OK || !got.range || got.range.steps < 2 || index < 0 || index >= got.range.steps) {
        rejected.push(key);
        continue;
      }
      err = await api.setRange(def.cap, { ...got.range, valueIndex: index });
    }
    if (DISCONNECT_RESULTS.has(err)) throw new Error(`Nikon disconnected (${nkError(err)})`);
    if (err !== NK.OK) rejected.push(key);
  }
  return readNikonSettings(api, rejected);
}
