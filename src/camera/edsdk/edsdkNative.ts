import koffi from "koffi";
import { DirItem, EdsApi, EdsRef } from "./edsdkApi";

/**
 * The real EdsApi: Canon's EDSDK.dll through koffi. Only the camera worker
 * process loads this. Signatures follow EDSDK 13.x, where stream lengths,
 * download sizes and EdsDirectoryItemInfo.size are 64-bit. The DLL's
 * bitness must match Node's (64-bit Node needs the 64-bit EDSDK).
 */
export function loadEdsdk(dllPath: string): EdsApi {
  const lib = koffi.load(dllPath);

  koffi.struct("EdsDeviceInfo", {
    szPortName: koffi.array("char", 256, "String"),
    szDeviceDescription: koffi.array("char", 256, "String"),
    deviceSubType: "uint32",
    reserved: "uint32",
  });
  koffi.struct("EdsCapacity", { numberOfFreeClusters: "int32", bytesPerSector: "int32", reset: "int32" });
  koffi.struct("EdsPropertyDesc", {
    form: "int32",
    access: "int32",
    numElements: "int32",
    propDesc: koffi.array("int32", 128),
  });
  koffi.struct("EdsDirectoryItemInfo", {
    size: "uint64",
    isFolder: "int32",
    groupID: "uint32",
    option: "uint32",
    szFileName: koffi.array("char", 256, "String"),
    format: "uint32",
    dateTime: "uint32",
  });
  const ObjectHandler = koffi.proto("uint32 __stdcall EdsObjectEventHandler(uint32 event, void *ref, void *ctx)");
  const StateHandler = koffi.proto("uint32 __stdcall EdsStateEventHandler(uint32 event, uint32 param, void *ctx)");

  const f = {
    initialize: lib.func("uint32 __stdcall EdsInitializeSDK()"),
    terminate: lib.func("uint32 __stdcall EdsTerminateSDK()"),
    getCameraList: lib.func("uint32 __stdcall EdsGetCameraList(_Out_ void **list)"),
    getChildCount: lib.func("uint32 __stdcall EdsGetChildCount(void *ref, _Out_ uint32 *count)"),
    getChildAtIndex: lib.func("uint32 __stdcall EdsGetChildAtIndex(void *ref, int32 index, _Out_ void **child)"),
    getDeviceInfo: lib.func("uint32 __stdcall EdsGetDeviceInfo(void *cam, _Out_ EdsDeviceInfo *info)"),
    openSession: lib.func("uint32 __stdcall EdsOpenSession(void *cam)"),
    closeSession: lib.func("uint32 __stdcall EdsCloseSession(void *cam)"),
    release: lib.func("uint32 __stdcall EdsRelease(void *ref)"),
    getU32: lib.func("uint32 __stdcall EdsGetPropertyData(void *ref, uint32 id, int32 param, uint32 size, _Out_ uint32 *data)"),
    setU32: lib.func("uint32 __stdcall EdsSetPropertyData(void *ref, uint32 id, int32 param, uint32 size, _In_ uint32 *data)"),
    getPropertyDesc: lib.func("uint32 __stdcall EdsGetPropertyDesc(void *ref, uint32 id, _Out_ EdsPropertyDesc *desc)"),
    getPropertySize: lib.func("uint32 __stdcall EdsGetPropertySize(void *ref, uint32 id, int32 param, _Out_ int32 *type, _Out_ uint32 *size)"),
    // Same export as getU32, typed for a caller-owned byte buffer (string properties).
    getBytes: lib.func("uint32 __stdcall EdsGetPropertyData(void *ref, uint32 id, int32 param, uint32 size, void *data)"),
    setCapacity: lib.func("uint32 __stdcall EdsSetCapacity(void *cam, EdsCapacity capacity)"),
    sendCommand: lib.func("uint32 __stdcall EdsSendCommand(void *cam, uint32 command, int32 param)"),
    setObjectHandler: lib.func("uint32 __stdcall EdsSetObjectEventHandler(void *cam, uint32 event, EdsObjectEventHandler *handler, void *ctx)"),
    setStateHandler: lib.func("uint32 __stdcall EdsSetCameraStateEventHandler(void *cam, uint32 event, EdsStateEventHandler *handler, void *ctx)"),
    getEvent: lib.func("uint32 __stdcall EdsGetEvent()"),
    createMemoryStream: lib.func("uint32 __stdcall EdsCreateMemoryStream(uint64 size, _Out_ void **stream)"),
    // The wide-char variant, so a data folder with non-ASCII characters still works.
    createFileStream: lib.func("uint32 __stdcall EdsCreateFileStreamEx(str16 path, uint32 disposition, uint32 access, _Out_ void **stream)"),
    createEvfImageRef: lib.func("uint32 __stdcall EdsCreateEvfImageRef(void *stream, _Out_ void **evf)"),
    downloadEvfImage: lib.func("uint32 __stdcall EdsDownloadEvfImage(void *cam, void *evf)"),
    getPointer: lib.func("uint32 __stdcall EdsGetPointer(void *stream, _Out_ void **pointer)"),
    getLength: lib.func("uint32 __stdcall EdsGetLength(void *stream, _Out_ uint64 *length)"),
    getDirItemInfo: lib.func("uint32 __stdcall EdsGetDirectoryItemInfo(void *item, _Out_ EdsDirectoryItemInfo *info)"),
    download: lib.func("uint32 __stdcall EdsDownload(void *item, uint64 size, void *stream)"),
    downloadComplete: lib.func("uint32 __stdcall EdsDownloadComplete(void *item)"),
    downloadCancel: lib.func("uint32 __stdcall EdsDownloadCancel(void *item)"),
  };

  const OBJECT_EVENT_ALL = 0x200;
  const STATE_EVENT_ALL = 0x300;
  const FILE_CREATE_ALWAYS = 1;
  const ACCESS_READ_WRITE = 2;

  // koffi keeps a registered callback alive until it is unregistered; hold
  // ours so a new session's handler replaces (and frees) the previous one.
  type Registered = ReturnType<typeof koffi.register>;
  let objectCallback: Registered | null = null;
  let stateCallback: Registered | null = null;
  const unregister = (cb: Registered | null) => {
    if (cb) koffi.unregister(cb);
  };

  return {
    initialize: () => f.initialize(),
    terminate: () => {
      unregister(objectCallback);
      unregister(stateCallback);
      objectCallback = stateCallback = null;
      return f.terminate();
    },
    cameras() {
      const list: unknown[] = [null];
      if (f.getCameraList(list) !== 0) return [];
      try {
        const count = [0];
        if (f.getChildCount(list[0], count) !== 0) return [];
        const found: Array<{ ref: EdsRef; description: string; port: string }> = [];
        for (let i = 0; i < (count[0] ?? 0); i += 1) {
          const cam: unknown[] = [null];
          if (f.getChildAtIndex(list[0], i, cam) !== 0) continue;
          const info: { szDeviceDescription?: string; szPortName?: string } = {};
          f.getDeviceInfo(cam[0], info);
          found.push({ ref: cam[0], description: info.szDeviceDescription || "Canon camera", port: info.szPortName ?? "" });
        }
        return found;
      } finally {
        f.release(list[0]);
      }
    },
    openSession: (cam) => f.openSession(cam),
    closeSession: (cam) => f.closeSession(cam),
    release: (ref) => {
      f.release(ref);
    },
    getU32(cam, prop) {
      const value = [0];
      const err = f.getU32(cam, prop, 0, 4, value);
      return { err, value: value[0] ?? 0 };
    },
    getString(cam, prop) {
      const type = [0];
      const size = [0];
      let err = f.getPropertySize(cam, prop, 0, type, size);
      if (err !== 0) return { err, value: "" };
      const buf = Buffer.alloc(Math.max(1, size[0] ?? 0));
      err = f.getBytes(cam, prop, 0, buf.length, buf);
      if (err !== 0) return { err, value: "" };
      const end = buf.indexOf(0);
      return { err: 0, value: buf.toString("latin1", 0, end === -1 ? buf.length : end).trim() };
    },
    setU32: (cam, prop, value) => f.setU32(cam, prop, 0, 4, [value]),
    getPropertyDesc(cam, prop) {
      const desc: { numElements?: number; propDesc?: number[] } = {};
      const err = f.getPropertyDesc(cam, prop, desc);
      if (err !== 0) return { err, values: [] };
      const n = Math.max(0, Math.min(128, desc.numElements ?? 0));
      // Codes are unsigned property values; int32 decoding would turn e.g. 0xFFFFFFFF into -1.
      return { err: 0, values: Array.from(desc.propDesc ?? []).slice(0, n).map((v) => v >>> 0) };
    },
    setCapacityHost: (cam) => f.setCapacity(cam, { numberOfFreeClusters: 0x7fffffff, bytesPerSector: 0x1000, reset: 1 }),
    sendCommand: (cam, command, param) => f.sendCommand(cam, command, param),
    setObjectHandler(cam, handler) {
      unregister(objectCallback);
      objectCallback = koffi.register((event: number, ref: EdsRef) => {
        handler(event, ref);
        return 0;
      }, koffi.pointer(ObjectHandler));
      return f.setObjectHandler(cam, OBJECT_EVENT_ALL, objectCallback, null);
    },
    setStateHandler(cam, handler) {
      unregister(stateCallback);
      stateCallback = koffi.register((event: number) => {
        handler(event);
        return 0;
      }, koffi.pointer(StateHandler));
      return f.setStateHandler(cam, STATE_EVENT_ALL, stateCallback, null);
    },
    clearHandlers(cam) {
      f.setObjectHandler(cam, OBJECT_EVENT_ALL, null, null);
      f.setStateHandler(cam, STATE_EVENT_ALL, null, null);
      unregister(objectCallback);
      unregister(stateCallback);
      objectCallback = stateCallback = null;
    },
    getEvent: () => {
      f.getEvent();
    },
    downloadEvfFrame(cam) {
      const stream: unknown[] = [null];
      let err = f.createMemoryStream(0, stream);
      if (err !== 0) return { err, jpeg: null };
      try {
        const evf: unknown[] = [null];
        err = f.createEvfImageRef(stream[0], evf);
        if (err !== 0) return { err, jpeg: null };
        try {
          err = f.downloadEvfImage(cam, evf[0]);
          if (err !== 0) return { err, jpeg: null };
          const pointer: unknown[] = [null];
          const length = [0];
          err = f.getPointer(stream[0], pointer);
          if (err !== 0) return { err, jpeg: null };
          err = f.getLength(stream[0], length);
          if (err !== 0) return { err, jpeg: null };
          // koffi.array() interns a distinct type per length, which live-view
          // frame sizes churn through constantly - koffi.view() reads without
          // registering a type. The view aliases the stream's own memory, so
          // it must be copied before the stream is released in the finally
          // blocks below.
          const view = koffi.view(pointer[0], Number(length[0]));
          return { err: 0, jpeg: Buffer.from(new Uint8Array(view)) };
        } finally {
          f.release(evf[0]);
        }
      } finally {
        f.release(stream[0]);
      }
    },
    dirItem(item) {
      const info: { size?: number | bigint; szFileName?: string } = {};
      const err = f.getDirItemInfo(item, info);
      if (err !== 0) return { err, item: null };
      const dirItem: DirItem = { size: BigInt(info.size ?? 0), fileName: info.szFileName ?? "" };
      return { err: 0, item: dirItem };
    },
    downloadToFile(item, size, filePath) {
      const stream: unknown[] = [null];
      let err = f.createFileStream(filePath, FILE_CREATE_ALWAYS, ACCESS_READ_WRITE, stream);
      if (err !== 0) {
        f.downloadCancel(item);
        return err;
      }
      try {
        err = f.download(item, size, stream[0]);
        if (err !== 0) {
          f.downloadCancel(item);
          return err;
        }
        return f.downloadComplete(item);
      } finally {
        f.release(stream[0]);
      }
    },
    downloadCancel: (item) => f.downloadCancel(item),
  };
}
