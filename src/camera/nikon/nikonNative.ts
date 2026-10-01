import koffi from "koffi";
import path from "node:path";
import { NikonApi, NikonHandlers } from "./nikonApi";
import {
  decodeDevices,
  DEVICE_INFO,
  encodeCallbacks,
  encodeShooting,
  ENUM_DEVICES,
  EVENTS_WITH_OWNED_POINTER,
  LIVEVIEW,
  NIKON_LIBRARY,
  NK,
  UI_REQUEST,
} from "./nikonLayout";

/** Pointers are BigInts in koffi 3; NULL can come back as null or 0n. */
type Ptr = bigint | null;
const isNull = (p: unknown): boolean => p === null || p === undefined || p === 0n || p === 0;
const toBig = (v: unknown): bigint => (typeof v === "bigint" ? v : BigInt((v as number | null) ?? 0));

/** Native memory koffi owns and never moves, for anything the SDK might read after the call returns. */
function nativeBytes(content: Buffer): { ptr: Ptr; free: () => void } {
  const ptr = koffi.alloc("uint8", content.length) as Ptr;
  new Uint8Array(koffi.view(ptr, content.length)).set(content);
  return { ptr, free: () => koffi.free(ptr) };
}

const readBytes = (ptr: Ptr, length: number): Buffer => Buffer.from(new Uint8Array(koffi.view(ptr, length)));

export interface NikonNativeOptions {
  /** The SDK library to load; defaults to ControlServiceLayer.dll in sdkDir. Tests load a mock. */
  libraryPath?: string;
}

/**
 * The real NikonApi: Nikon's Remote SDK v2 (ControlServiceLayer.dll) through
 * koffi. Only the Nikon worker process loads this.
 *
 * Three things the SDK needs that the Canon binding didn't:
 *  - It allocates the memory it hands back (device lists, capability values,
 *    live-view frames, some event parameters) with an allocator the client
 *    passes to InitializeSDK, and the client frees it. We pass the C
 *    runtime's own malloc/free, so JS can free it with the same free.
 *  - It calls back from its own threads. koffi queues those calls onto the JS
 *    main thread, so every SDK call below goes through `.async` (a koffi
 *    worker thread): a synchronous call would block the main thread while the
 *    SDK waits for a callback to finish there - a deadlock.
 *  - Its structures are pack(2); see nikonLayout.
 */
export function loadNikon(sdkDir: string, options: NikonNativeOptions = {}): NikonApi {
  // The SDK runs on koffi's call stack, and the async default (128 KiB) is
  // far below the 1 MiB a Windows thread normally gets.
  koffi.config({ ...koffi.config(), async_stack_size: 2 * 1024 * 1024 });

  let mallocAddr: Ptr;
  let freeAddr: Ptr;
  if (process.platform === "win32") {
    const kernel32 = koffi.load("kernel32.dll");
    // ControlServiceLayer.dll loads NkdPTP.dll, NkRoyalmile.dll and dnssd.dll
    // from its own folder at run time, which isn't on the default search path.
    kernel32.func("int __stdcall SetDllDirectoryW(str16 path)")(sdkDir);
    const ucrt = kernel32.func("void * __stdcall LoadLibraryW(str16 name)")("ucrtbase.dll") as Ptr;
    const getProc = kernel32.func("void * __stdcall GetProcAddress(void *module, str name)");
    mallocAddr = getProc(ucrt, "malloc") as Ptr;
    freeAddr = getProc(ucrt, "free") as Ptr;
  } else {
    // Only the mock SDK used by the tests runs here.
    const dlsym = koffi.load("libc.so.6").func("void *dlsym(void *handle, str name)");
    mallocAddr = dlsym(null, "malloc") as Ptr;
    freeAddr = dlsym(null, "free") as Ptr;
  }
  if (isNull(mallocAddr) || isNull(freeAddr)) throw new Error("Could not find the C runtime's malloc/free");
  const crtFree = koffi.decode(freeAddr, koffi.proto("void", ["void *"])) as (p: Ptr) => void;
  const freeSdk = (p: unknown) => {
    if (!isNull(p)) crtFree(p as Ptr);
  };

  const lib = koffi.load(options.libraryPath ?? path.join(sdkDir, NIKON_LIBRARY));
  const f = {
    setLoggingLevel: lib.func("int32 SetLoggingLevel(int32 level)"),
    initialize: lib.func("int32 InitializeSDK(void *alloc, void *free, void *callbacks, void *ppDevices, void *ppCaps)"),
    freeSdk: lib.func("int32 FreeSDK()"),
    setSavePath: lib.func("int32 SetImageVideoSavePath(str16 imagePath, str16 videoPath)"),
    enumDevices: lib.func("int32 EnumDevices(void *ppDevices, void *proc, void *ref)"),
    connect: lib.func("int32 ConnectDevice(uint32 deviceId, void *ppCaps)"),
    disconnect: lib.func("int32 DisconnectDevice()"),
    getCapability: lib.func("int32 GetCapability(uint32 capability, int32 request, void *ppData, void *pDataType)"),
    setCapability: lib.func("int32 SetCapability(uint32 capability, void *data, int32 dataType)"),
    startShooting: lib.func("int32 StartShooting(void *shooting, void *proc, void *ref)"),
    startLiveView: lib.func("int32 StartLiveView(void *proc, void *ref)"),
    stopLiveView: lib.func("int32 StopLiveView(void *proc, void *ref)"),
  };

  const run = (fn: { async: (...args: unknown[]) => void }, ...args: unknown[]): Promise<number> =>
    new Promise((resolve, reject) => {
      fn.async(...args, (err: unknown, result: number) => (err ? reject(err) : resolve(result)));
    });

  /** Calls `fn` with a zeroed out-parameter block of `size` bytes and returns the bytes it left there. */
  const withOut = async (size: number, call: (out: Ptr) => Promise<number>): Promise<{ err: number; out: Buffer }> => {
    const out = nativeBytes(Buffer.alloc(size));
    try {
      const err = await call(out.ptr);
      return { err, out: readBytes(out.ptr, size) };
    } finally {
      out.free();
    }
  };

  type Registered = bigint;
  let registered: Registered[] = [];
  let callbackBlock: { ptr: Ptr; free: () => void } | null = null;

  const EventProc = koffi.proto("void", ["void *", "uint32", "uint64"]);
  const UIRequestProc = koffi.proto("uint32", ["void *", "void *"]);
  const ProgressProc = koffi.proto("void", ["uint32", "uint32", "void *", "uint32", "uint32"]);
  const DataProc = koffi.proto("int32", ["void *", "void *", "void *"]);
  const LiveViewProc = koffi.proto("void", ["void *", "void *"]);

  function register(handlers: NikonHandlers) {
    const event = koffi.register((_ref: unknown, ev: number, data: unknown) => {
      const param = toBig(data);
      try {
        if (ev === NK.EVENT_IMAGE_SAVED && param !== 0n) handlers.onImageSaved(koffi.decode.string16(param));
      } catch {
        // A path we can't decode is only a log line short; the capture finds the file itself.
      } finally {
        if (EVENTS_WITH_OWNED_POINTER.has(ev)) freeSdk(param);
      }
      try {
        handlers.onEvent(ev, param);
      } catch {
        // Never let a JS exception unwind into the SDK's thread.
      }
    }, koffi.pointer(EventProc));
    const uiRequest = koffi.register((_ref: unknown, request: unknown) => {
      // Nobody is at the PC to answer a dialog: take the SDK's own default answer.
      if (isNull(request)) return 0;
      return readBytes(request as Ptr, UI_REQUEST.readBytes).readUInt32LE(UI_REQUEST.defaultResult);
    }, koffi.pointer(UIRequestProc));
    const progress = koffi.register(() => undefined, koffi.pointer(ProgressProc));
    const data = koffi.register(() => NK.OK, koffi.pointer(DataProc));
    const liveView = koffi.register((_ref: unknown, frame: unknown) => {
      if (isNull(frame)) return;
      let image: Ptr = null;
      try {
        const head = readBytes(frame as Ptr, LIVEVIEW.size);
        const size = head.readUInt32LE(LIVEVIEW.imageSize);
        image = head.readBigUInt64LE(LIVEVIEW.imageData);
        if (!isNull(image) && size > 0) handlers.onLiveViewFrame(readBytes(image, size));
      } catch {
        // A frame we couldn't read is just a dropped frame.
      } finally {
        freeSdk(image);
        freeSdk(frame);
      }
    }, koffi.pointer(LiveViewProc));
    registered = [event, uiRequest, progress, data, liveView];
    // The SDK may keep the address of this block, so it lives until terminate().
    callbackBlock = nativeBytes(encodeCallbacks({ uiRequest, event, progress, data, liveView }));
  }

  function unregisterAll() {
    for (const cb of registered) koffi.unregister(cb);
    registered = [];
    callbackBlock?.free();
    callbackBlock = null;
  }

  return {
    async initialize(handlers, defaultSaveDir) {
      await run(f.setLoggingLevel, NK.LOG_ERROR);
      register(handlers);
      const err = await run(f.initialize, mallocAddr, freeAddr, callbackBlock!.ptr, null, null);
      if (err !== NK.OK) {
        unregisterAll();
        return err;
      }
      // Each shot names its own folder; this is only where the SDK puts anything that doesn't.
      return run(f.setSavePath, defaultSaveDir, defaultSaveDir);
    },

    async devices() {
      const { err, out } = await withOut(8, (holder) => run(f.enumDevices, holder, null, null));
      const list = out.readBigUInt64LE(0);
      if (err !== NK.OK || list === 0n) {
        freeSdk(list);
        return { err, devices: [] };
      }
      try {
        const head = readBytes(list, ENUM_DEVICES.size);
        const count = head.readUInt32LE(ENUM_DEVICES.elements);
        const data = head.readBigUInt64LE(ENUM_DEVICES.data);
        try {
          const devices = count > 0 && data !== 0n ? decodeDevices(readBytes(data, count * DEVICE_INFO.size), count) : [];
          return { err, devices };
        } finally {
          freeSdk(data);
        }
      } finally {
        freeSdk(list);
      }
    },

    async connect(deviceId) {
      const { err, out } = await withOut(8, (holder) => run(f.connect, deviceId, holder));
      // NkMAIDEnumCapInfo { NkMAIDCapInfo *pCapArray; ULONG count; ULONG size } - unused, but ours to free.
      const caps = out.readBigUInt64LE(0);
      if (caps !== 0n) {
        freeSdk(readBytes(caps, 8).readBigUInt64LE(0));
        freeSdk(caps);
      }
      return err;
    },

    async disconnect() {
      await run(f.disconnect);
    },

    async setUnsigned(capability, value) {
      const raw = Buffer.alloc(4);
      raw.writeUInt32LE(value >>> 0, 0);
      const mem = nativeBytes(raw);
      try {
        return await run(f.setCapability, capability, mem.ptr, NK.DATA_UNSIGNED_PTR);
      } finally {
        mem.free();
      }
    },

    async getInteger(capability) {
      const type = nativeBytes(Buffer.alloc(4));
      try {
        const { err, out } = await withOut(8, (holder) => run(f.getCapability, capability, NK.GET_VALUE, holder, type.ptr));
        const value = out.readBigUInt64LE(0);
        if (value === 0n) return { err: err === NK.OK ? -117 : err, value: 0 };
        try {
          if (err !== NK.OK) return { err, value: 0 };
          const dataType = readBytes(type.ptr, 4).readInt32LE(0);
          const bytes = readBytes(value, 4);
          return { err, value: dataType === NK.DATA_UNSIGNED_PTR ? bytes.readUInt32LE(0) : bytes.readInt32LE(0) };
        } finally {
          freeSdk(value);
        }
      } finally {
        type.free();
      }
    },

    async shoot(saveDir, autoFocus) {
      // A null completion proc makes StartShooting synchronous on the koffi thread.
      const mem = nativeBytes(encodeShooting(saveDir, autoFocus));
      try {
        return await run(f.startShooting, mem.ptr, null, null);
      } finally {
        mem.free();
      }
    },

    startLiveView: () => run(f.startLiveView, null, null),
    stopLiveView: () => run(f.stopLiveView, null, null),

    async terminate() {
      try {
        await run(f.freeSdk);
      } finally {
        unregisterAll();
      }
    },
  };
}
