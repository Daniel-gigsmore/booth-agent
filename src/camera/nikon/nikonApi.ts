import type { NikonDevice, NikonEnumHeader, NikonEnumValue, NikonRange } from "./nikonLayout";
export type { NikonDevice, NikonEnumHeader, NikonEnumValue, NikonRange };

/** What the SDK reports on its own threads; nikonNative relays it on the worker's main thread. */
export interface NikonHandlers {
  /** A MAID event (eNkMAIDEvent) with its parameter; pointer parameters are already freed. */
  onEvent(event: number, param: bigint): void;
  /** A copied live-view JPEG. */
  onLiveViewFrame(jpeg: Buffer): void;
  /** kNkMAIDEvent_ImageSaved: the full path of the file the SDK just wrote. */
  onImageSaved(filePath: string): void;
}

/**
 * The Nikon Remote SDK's "simplified API" as the camera worker uses it.
 * Every call is asynchronous: the real binding runs each SDK call on a koffi
 * worker thread, so the worker's own event loop stays free to receive the
 * callbacks the SDK makes from its threads while the call is in progress.
 * Results are NKERROR codes (0 = ok), see nikonLayout's NK.
 */
export interface NikonApi {
  /** Loads the SDK, registers the callbacks and sets the folder photos go to when a shot doesn't name one. */
  initialize(handlers: NikonHandlers, defaultSaveDir: string): Promise<number>;
  devices(): Promise<{ err: number; devices: NikonDevice[] }>;
  connect(deviceId: number): Promise<number>;
  disconnect(): Promise<void>;
  setUnsigned(capability: number, value: number): Promise<number>;
  getInteger(capability: number): Promise<{ err: number; value: number }>;
  /**
   * An enum capability: its option list (the SDK's "supported values") and the
   * index of the current value. `enum` is null when the camera doesn't offer it right now.
   */
  getEnum(capability: number): Promise<{ err: number; enum: NikonEnumValue | null }>;
  /** Sets an enum capability to option `index`; `header` is what getEnum returned for it. */
  setEnum(capability: number, header: NikonEnumHeader, index: number): Promise<number>;
  getRange(capability: number): Promise<{ err: number; range: NikonRange | null }>;
  setRange(capability: number, range: NikonRange): Promise<number>;
  /** One single-frame shot, saved by the SDK into saveDir. Resolves once the SDK returns. */
  shoot(saveDir: string, autoFocus: boolean): Promise<number>;
  startLiveView(): Promise<number>;
  stopLiveView(): Promise<number>;
  terminate(): Promise<void>;
}
