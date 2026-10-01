/**
 * Binary layout of the Nikon Remote SDK v2 structures this agent touches, and
 * the constants it uses.
 *
 * Maid3.h wraps every structure in `#pragma pack(push,2)` on Windows, so
 * nothing is naturally aligned: a `bool` followed by a ULONG leaves only one
 * byte of padding, and a pointer after a wchar_t array sits on a 2-byte
 * boundary. koffi structs can't express pack(2), so these structures are
 * read and written as raw bytes at fixed offsets instead.
 *
 * Every size and offset below was printed by compiling the SDK's own headers
 * (Remote SDK v2.0.0, Maid3.h v3.1 r20) with a 64-bit Windows compiler, not
 * worked out by hand. Re-check them if the SDK is upgraded.
 */

/** The SDK library, shipped in the Remote SDK's Module\\Win\\BinaryFile folder. */
export const NIKON_LIBRARY = "ControlServiceLayer.dll";

export const NK = {
  // eNkMAIDResult (and the DX2 vendor results from Maid3d1.h)
  OK: 0,
  PENDING: 1,
  DEVICE_NOT_AVAILABLE: -114,
  OPEN_SESSION_FAILED: -113,
  LIVEVIEW_ALREADY_STARTED: -112,
  LIVEVIEW_ALREADY_STOPPED: -111,
  INVALID_STATE: -92,
  OUT_OF_FOCUS: 137,
  DEVICE_BUSY: 152,
  WAITING_2ND_RELEASE: 168,

  // eNkMAIDEvent
  EVENT_CAP_CHANGE: 4,
  EVENT_DEVICE_INFO_CHANGED: 7,
  EVENT_IMAGE_SAVED: 8,
  EVENT_STORAGE_FULL_IMAGE_NOT_SAVED: 10,
  EVENT_ACQUIRE_FAILED_IMAGE_NOT_SAVED: 11,
  EVENT_CAPTURE_COMPLETE: 0x108,
  EVENT_CAP_CHANGE_OPERATION_ONLY: 0x10b,

  // Capabilities
  CAP_BATTERY_LEVEL: 48, // kNkMAIDCapType_Integer, 1..100
  CAP_SAVE_MEDIA: 0x8305,

  // eNkMAIDSaveMedia: SDRAM = the photo goes to the PC, not the card
  SAVE_MEDIA_SDRAM: 1,

  // eNkMAIDDataType
  DATA_INTEGER_PTR: 5,
  DATA_UNSIGNED_PTR: 6,

  // eNkSDKGetSettingRequestType
  GET_VALUE: 0,

  // eNkMAIDShootingType
  SHOOT_SINGLE: 1,

  // eNkMAIDLoggingLevel
  LOG_ERROR: 2,
} as const;

// Values taken from the compiled headers (eNkMAIDResult and Maid3d1.h's DX2 results).
const RESULT_NAMES: Record<number, string> = {
  [-127]: "NotSupported",
  [-126]: "UnexpectedDataType",
  [-125]: "ValueOutOfBounds",
  [-124]: "BufferSize",
  [-123]: "Aborted",
  [-122]: "NoMedia",
  [-121]: "NoEventProc",
  [-120]: "NoDataProc",
  [-119]: "ZombieObject",
  [-118]: "OutOfMemory",
  [-117]: "UnexpectedError",
  [-116]: "HardwareError",
  [-115]: "MissingComponent",
  [-114]: "DeviceNotAvailable",
  [-113]: "OpenSessionFailed",
  [-112]: "LiveViewAlreadyStarted",
  [-111]: "LiveViewAlreadyStopped",
  [-110]: "InvalidDeviceID",
  [-109]: "StartLiveViewFailed",
  [-108]: "DeviceFailed",
  [-107]: "CapabilityNotSupported",
  [-106]: "OperationNotSupported",
  [-105]: "InvalidCapID",
  [-104]: "OutOfRangeValue",
  [-103]: "InvalidShootingType",
  [-102]: "ShootingCancelFailed",
  [-101]: "InvalidShootCount",
  [-100]: "InvalidShootingMode",
  [-99]: "InvalidFileSavePath",
  [-98]: "MovieStartFailed",
  [-97]: "FileSaveFailed",
  [-93]: "InvalidArguments",
  [-92]: "InvalidState",
  [-91]: "ContinousShootIntrupted",
  131: "MediaFull",
  134: "CameraNotFound",
  137: "OutOfFocus",
  141: "DataTransFailure",
  142: "SessionFailure",
  144: "BusReset",
  147: "BatteryExhausted",
  148: "CaptureFailure",
  150: "NotInitialized",
  151: "CaptureDisable",
  152: "DeviceBusy",
  159: "NotLiveView",
  168: "Waiting_2ndRelease",
  170: "High_Temperature",
};

/** "OutOfFocus (137)", for logs and error messages. */
export function nkError(code: number): string {
  const name = RESULT_NAMES[code];
  return name ? `${name} (${code})` : `error ${code}`;
}

/** Results that mean the camera itself has gone (unplugged, switched off), not just this call. */
export const DISCONNECT_RESULTS: ReadonlySet<number> = new Set([
  NK.DEVICE_NOT_AVAILABLE,
  -110, // InvalidDeviceID
  -108, // DeviceFailed
  134, // CameraNotFound
  142, // SessionFailure
  144, // BusReset
]);

/** NkMAIDCSCallback: five function pointers and a NKREF, all 8 bytes, so pack(2) changes nothing. */
export const CALLBACKS_SIZE = 48;

export interface CallbackAddresses {
  uiRequest: bigint;
  event: bigint;
  progress: bigint;
  data: bigint;
  liveView: bigint;
}

export function encodeCallbacks(cb: CallbackAddresses): Buffer {
  const buf = Buffer.alloc(CALLBACKS_SIZE);
  buf.writeBigUInt64LE(cb.uiRequest, 0);
  buf.writeBigUInt64LE(cb.event, 8);
  buf.writeBigUInt64LE(cb.progress, 16);
  buf.writeBigUInt64LE(cb.data, 24);
  buf.writeBigUInt64LE(cb.liveView, 32);
  buf.writeBigUInt64LE(0n, 40); // refProc
  return buf;
}

/** NkMAIDEnumDevices: ULONG ulElements, ULONG ulValue, NkMAIDDeviceInfo *pDeviceData. */
export const ENUM_DEVICES = { size: 16, elements: 0, data: 8 } as const;

/** NkMAIDDeviceInfo: ULONG ID, char Name[64], bool Availability, ULONG ulConnectedPID, char Version[64]. */
export const DEVICE_INFO = { size: 138, id: 0, name: 4, available: 68, connectedPid: 70, version: 74 } as const;

export interface NikonDevice {
  id: number;
  name: string;
  available: boolean;
}

function cString(buf: Buffer, start: number, length: number): string {
  const bytes = buf.subarray(start, start + length);
  const end = bytes.indexOf(0);
  return bytes.toString("latin1", 0, end === -1 ? bytes.length : end).trim();
}

/** Decodes `count` consecutive NkMAIDDeviceInfo records. */
export function decodeDevices(bytes: Buffer, count: number): NikonDevice[] {
  const devices: NikonDevice[] = [];
  for (let i = 0; i < count; i += 1) {
    const base = i * DEVICE_INFO.size;
    if (base + DEVICE_INFO.size > bytes.length) break;
    const record = bytes.subarray(base, base + DEVICE_INFO.size);
    devices.push({
      id: record.readUInt32LE(DEVICE_INFO.id),
      name: cString(record, DEVICE_INFO.name, 64),
      available: record.readUInt8(DEVICE_INFO.available) !== 0,
    });
  }
  return devices;
}

/**
 * MAIDShootingStructure on Windows: enum ShootingType, four ULONGs, bool
 * bAutoFocus at 20, wchar_t ImageSavePath[1024] at 22 (UTF-16), LPVOID
 * pOutPutRefrence at 2070.
 */
export const SHOOTING = { size: 2078, type: 0, numShots: 4, autoFocus: 20, savePath: 22, savePathChars: 1024, outRef: 2070 } as const;

export function encodeShooting(saveDir: string, autoFocus: boolean): Buffer {
  const buf = Buffer.alloc(SHOOTING.size);
  buf.writeUInt32LE(NK.SHOOT_SINGLE, SHOOTING.type);
  buf.writeUInt8(autoFocus ? 1 : 0, SHOOTING.autoFocus);
  const path16 = Buffer.from(saveDir, "utf16le");
  // Leave room for the terminating NUL the buffer is already zero-filled with.
  const maxBytes = (SHOOTING.savePathChars - 1) * 2;
  if (path16.length > maxBytes) throw new Error(`Save folder path is too long for the Nikon SDK: ${saveDir}`);
  path16.copy(buf, SHOOTING.savePath);
  return buf;
}

/**
 * NkMAIDLiveViewData: ULONG ulLvImageSize, two UWORDs, an 884-byte
 * NKMAIDLiveViewHeader, then LPVOID pImageData at 892.
 */
export const LIVEVIEW = { size: 900, imageSize: 0, imageData: 892 } as const;

/** NkMAIDUIRequestInfo: ULONG ulType, ULONG ulDefault, ... - only the default answer is read. */
export const UI_REQUEST = { readBytes: 8, defaultResult: 4 } as const;

/** NkMAIDCapInfo pointer handed to CapChange events, which the client must free. */
export const EVENTS_WITH_OWNED_POINTER: ReadonlySet<number> = new Set([
  NK.EVENT_CAP_CHANGE,
  NK.EVENT_CAP_CHANGE_OPERATION_ONLY,
  NK.EVENT_IMAGE_SAVED,
]);
