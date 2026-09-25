/**
 * The slice of Canon's EDSDK the camera worker uses, as an interface so the
 * worker's logic can be tested against a fake. The real implementation
 * (koffi + EDSDK.dll) lives in edsdkNative.ts and is only loaded inside the
 * worker process. Every method returns the raw EdsError code (0 = OK)
 * rather than throwing, because the error code IS the information
 * (8D01 vs 81 vs a disconnect all need different handling).
 */

/** Opaque EDSDK object reference: a native pointer under koffi, anything in tests. */
export type EdsRef = unknown;

export const EDS = {
  ERR_OK: 0x0,
  ERR_DEVICE_NOT_FOUND: 0x80,
  ERR_DEVICE_BUSY: 0x81,
  ERR_COMM_PORT_IS_IN_USE: 0xc0,
  ERR_COMM_DISCONNECTED: 0xc1,
  ERR_COMM_USB_BUS_ERR: 0xc4,
  ERR_SESSION_NOT_OPEN: 0x2003,
  ERR_TAKE_PICTURE_AF_NG: 0x8d01,
  ERR_OBJECT_NOTREADY: 0xa102,

  PROP_SAVE_TO: 0x0b,
  PROP_EVF_OUTPUT_DEVICE: 0x500,
  SAVE_TO_HOST: 2,
  EVF_OUTPUT_PC: 2,

  CMD_EXTEND_SHUTDOWN_TIMER: 0x01,
  CMD_PRESS_SHUTTER_BUTTON: 0x04,
  SHUTTER_OFF: 0,
  SHUTTER_COMPLETELY: 3,
  SHUTTER_COMPLETELY_NON_AF: 0x10003,

  OBJECT_EVENT_DIR_ITEM_REQUEST_TRANSFER: 0x208,
  STATE_EVENT_SHUTDOWN: 0x301,
} as const;

/** Errors that mean the camera is gone: close the session and go back to scanning. */
export const DISCONNECT_ERRORS: ReadonlySet<number> = new Set([
  EDS.ERR_DEVICE_NOT_FOUND,
  EDS.ERR_COMM_PORT_IS_IN_USE,
  EDS.ERR_COMM_DISCONNECTED,
  EDS.ERR_COMM_USB_BUS_ERR,
  EDS.ERR_SESSION_NOT_OPEN,
]);

export const hex = (code: number): string => `0x${(code >>> 0).toString(16).toUpperCase()}`;

export interface DirItem {
  size: bigint;
  fileName: string;
}

export interface EdsApi {
  initialize(): number;
  terminate(): number;
  /** The first connected camera, or null. The caller owns the returned ref and must release it. */
  firstCamera(): { ref: EdsRef; description: string } | null;
  openSession(cam: EdsRef): number;
  closeSession(cam: EdsRef): number;
  release(ref: EdsRef): void;
  getU32(cam: EdsRef, prop: number): { err: number; value: number };
  setU32(cam: EdsRef, prop: number, value: number): number;
  /** Tells the camera the host has room for the photo; required with SaveTo = Host. */
  setCapacityHost(cam: EdsRef): number;
  sendCommand(cam: EdsRef, command: number, param: number): number;
  /** Handlers run synchronously inside getEvent(). The object handler must not release the ref - the caller does. */
  setObjectHandler(cam: EdsRef, handler: (event: number, ref: EdsRef) => void): number;
  setStateHandler(cam: EdsRef, handler: (event: number) => void): number;
  /** Pumps EDSDK's event queue; handlers fire from inside this call. */
  getEvent(): void;
  downloadEvfFrame(cam: EdsRef): { err: number; jpeg: Buffer | null };
  dirItem(item: EdsRef): { err: number; item: DirItem | null };
  /** Downloads the whole item to filePath and marks the transfer complete. */
  downloadToFile(item: EdsRef, size: bigint, filePath: string): number;
  downloadCancel(item: EdsRef): number;
}
