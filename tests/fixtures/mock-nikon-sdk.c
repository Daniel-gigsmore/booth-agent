/*
 * A stand-in for Nikon's ControlServiceLayer.dll, built for Linux by
 * tests/nikon.native.test.ts so the real koffi binding (nikonNative.ts) can be
 * exercised without the SDK or a camera. It behaves like the parts of the SDK
 * the binding relies on:
 *   - the same exports, argument shapes and pack(2) structure layouts as
 *     Maid3.h on Win64 (wchar_t there is 16-bit, so char16_t here);
 *   - everything it hands back is allocated with the client's allocator, for
 *     the client to free;
 *   - it calls back from its own threads (live view, events, the saved photo),
 *     and StartShooting returns before the photo is on disk.
 */
#include <pthread.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <uchar.h>
#include <unistd.h>

#pragma pack(push, 2)
typedef struct { void *ui, *event, *progress, *data, *liveView, *ref; } CSCallback;
typedef struct { uint32_t elements, value; void *data; } DeviceList;
typedef struct { uint32_t id; char name[64]; _Bool available; uint32_t pid; char version[64]; } DeviceInfo;
typedef struct { uint32_t type, numShots, bulb, start, interval; _Bool autoFocus; char16_t path[1024]; void *out; } Shooting;
typedef struct { uint32_t imageSize; uint16_t physical, bits; char header[884]; void *image; } LiveViewData;
typedef struct { uint32_t id, type, visibility, operations; char description[256]; } CapInfo;
typedef struct { uint32_t type, elements, value, def; int16_t physical; void *data; } EnumData;
typedef struct { double value, def; uint32_t valueIndex, defaultIndex; double lower, upper; uint32_t steps; } RangeData;
typedef struct { CapInfo *caps; uint32_t count, size; } EnumCapInfo;
typedef struct { uint32_t type, def; int32_t sync; char *prompt, *detail; void *object; uint64_t data; } UIRequest;
#pragma pack(pop)

_Static_assert(sizeof(DeviceInfo) == 138, "NkMAIDDeviceInfo");
_Static_assert(offsetof(DeviceInfo, pid) == 70, "ulConnectedPID");
_Static_assert(sizeof(Shooting) == 2078, "MAIDShootingStructure");
_Static_assert(offsetof(Shooting, path) == 22, "ImageSavePath");
_Static_assert(sizeof(LiveViewData) == 900, "NkMAIDLiveViewData");
_Static_assert(offsetof(LiveViewData, image) == 892, "pImageData");
_Static_assert(sizeof(CapInfo) == 272, "NkMAIDCapInfo");
_Static_assert(sizeof(EnumData) == 26, "NkMAIDEnum");
_Static_assert(offsetof(EnumData, data) == 18, "NkMAIDEnum.pData");
_Static_assert(sizeof(RangeData) == 44, "NkMAIDRange");
_Static_assert(offsetof(RangeData, steps) == 40, "NkMAIDRange.ulSteps");

typedef void *(*AllocFn)(size_t);
typedef void (*FreeFn)(void *);
typedef void (*EventProc)(void *, uint32_t, uint64_t);
typedef void (*LiveViewProc)(void *, LiveViewData *);
typedef uint32_t (*UIRequestProc)(void *, UIRequest *);

static AllocFn g_alloc;
static FreeFn g_free;
static CSCallback g_cb;
static int g_initialized, g_connected, g_unplugged, g_lvOn;
static uint32_t g_saveMedia, g_uiAnswer;
static int g_lastAutoFocus = -1, g_shots;
static pthread_t g_lvThread;
static char g_shotDir[4096];

static void utf16_to_ascii(const char16_t *in, char *out, size_t max) {
  size_t i = 0;
  for (; in[i] && i + 1 < max; i++) out[i] = (char)in[i];
  out[i] = 0;
}

static char16_t *ascii_to_utf16_alloc(const char *in) {
  size_t n = strlen(in);
  char16_t *out = g_alloc((n + 1) * sizeof(char16_t));
  for (size_t i = 0; i < n; i++) out[i] = (char16_t)in[i];
  out[n] = 0;
  return out;
}

static void fire(uint32_t event, uint64_t data) { ((EventProc)g_cb.event)(g_cb.ref, event, data); }

int32_t SetLoggingLevel(int32_t level) { return level >= 1 && level <= 3 ? 0 : -125; }

int32_t InitializeSDK(AllocFn alloc, FreeFn freeFn, CSCallback *cb, DeviceList **devices, EnumCapInfo **caps) {
  if (!alloc || !freeFn || !cb || !cb->event || !cb->liveView || !cb->ui) return -93;
  (void)devices;
  (void)caps;
  g_alloc = alloc;
  g_free = freeFn;
  g_cb = *cb;
  g_initialized = 1;
  // Ask a question nobody is there to answer: the client must give the default back.
  UIRequest q = {.type = 1, .def = 1};
  g_uiAnswer = ((UIRequestProc)g_cb.ui)(g_cb.ref, &q);
  return 0;
}

static void stop_liveview_thread(void);
int32_t FreeSDK(void) {
  stop_liveview_thread();
  g_initialized = 0;
  return 0;
}

int32_t SetImageVideoSavePath(const char16_t *image, const char16_t *video) {
  (void)video;
  return image && image[0] ? 0 : -93;
}

int32_t EnumDevices(DeviceList **out, void *proc, void *ref) {
  (void)proc;
  (void)ref;
  if (!g_initialized) return -92;
  DeviceList *list = g_alloc(sizeof(DeviceList));
  list->elements = g_unplugged ? 0 : 1;
  list->value = 0;
  list->data = NULL;
  if (!g_unplugged) {
    DeviceInfo *info = g_alloc(sizeof(DeviceInfo));
    memset(info, 0, sizeof(*info));
    info->id = 7;
    strcpy(info->name, "Z 30");
    info->available = 1;
    info->pid = 0;
    list->data = info;
  }
  *out = list;
  return 0;
}

static void *cap_change_later(void *arg) {
  (void)arg;
  usleep(20 * 1000);
  // CapChange hands the client a NkMAIDCapInfo it must free.
  CapInfo *info = g_alloc(sizeof(CapInfo));
  memset(info, 0, sizeof(*info));
  info->id = 0x8305;
  fire(4, (uint64_t)(uintptr_t)info);
  return NULL;
}

int32_t ConnectDevice(uint32_t id, EnumCapInfo **caps) {
  if (g_unplugged || id != 7) return -110;
  g_connected = 1;
  if (caps) {
    EnumCapInfo *e = g_alloc(sizeof(EnumCapInfo));
    e->count = 2;
    e->size = 2 * sizeof(CapInfo);
    e->caps = g_alloc(e->size);
    memset(e->caps, 0, e->size);
    *caps = e;
  }
  pthread_t t;
  pthread_create(&t, NULL, cap_change_later, NULL);
  pthread_detach(t);
  return 0;
}

static void stop_liveview_thread(void) {
  if (!g_lvOn) return;
  g_lvOn = 0;
  pthread_join(g_lvThread, NULL);
}

// Like the real SDK: "It will Kill live view thread and execution thread."
int32_t DisconnectDevice(void) {
  stop_liveview_thread();
  g_connected = 0;
  return 0;
}

/* Packed-string enum settings: the option strings back to back, ulElements = their byte length. */
typedef struct { uint32_t cap; const char *options; uint32_t count; uint32_t index; } PackedSetting;
static PackedSetting g_packed[] = {
  {0x8117, "ISO 100\0ISO 200\0ISO 400\0ISO 800\0", 4, 1},
  {0x8113, "f/3.5\0f/5.6\0f/8\0", 3, 1},
  {0x8112, "1/125\0""1/60\0""1/30\0", 3, 0},
  {0x8118, "Auto\0Daylight\0", 2, 0},
  {0x8110, "Fine\0Normal\0", 2, 0},
};
static uint32_t g_exposureMode = 0; /* P */
static RangeData g_ev = {0, 0, 3, 3, -1.0, 1.0, 7};
static uint32_t g_refuseSet; /* cap whose next set fails, for the error path */

static PackedSetting *find_packed(uint32_t cap) {
  for (size_t i = 0; i < sizeof g_packed / sizeof g_packed[0]; i++)
    if (g_packed[i].cap == cap) return &g_packed[i];
  return NULL;
}

static size_t packed_bytes(const PackedSetting *p) {
  size_t n = 0;
  for (uint32_t i = 0; i < p->count; i++) {
    size_t len = strlen(p->options + n) + 1;
    n += len;
  }
  return n;
}

int32_t GetCapability(uint32_t cap, int32_t request, void **data, int32_t *type) {
  if (!g_connected) return -114;
  if (request > 1) return -106;
  PackedSetting *packed = find_packed(cap);
  if (packed) {
    EnumData *e = g_alloc(sizeof(EnumData));
    memset(e, 0, sizeof *e);
    e->type = 7; /* PackedString */
    e->value = packed->index;
    e->physical = 1;
    if (request == 1) {
      size_t bytes = packed_bytes(packed);
      e->elements = (uint32_t)bytes;
      e->data = g_alloc(bytes);
      memcpy(e->data, packed->options, bytes);
    }
    *data = e;
    *type = 16; /* EnumPtr */
    return 0;
  }
  if (cap == 0x8111) {
    static const uint32_t modes[] = {0, 1, 2, 3};
    EnumData *e = g_alloc(sizeof(EnumData));
    memset(e, 0, sizeof *e);
    e->type = 2; /* Unsigned */
    e->value = g_exposureMode;
    e->physical = 4;
    if (request == 1) {
      e->elements = 4;
      e->data = g_alloc(sizeof modes);
      memcpy(e->data, modes, sizeof modes);
    }
    *data = e;
    *type = 16;
    return 0;
  }
  if (cap == 0x8115 && request == 0) {
    RangeData *r = g_alloc(sizeof(RangeData));
    *r = g_ev;
    *data = r;
    *type = 14; /* RangePtr */
    return 0;
  }
  if (request != 0) return -106;
  if (cap == 48) {
    int32_t *value = g_alloc(sizeof(int32_t));
    *value = 60;
    *data = value;
    *type = 5; // IntegerPtr
    return 0;
  }
  return -107;
}

int32_t SetCapability(uint32_t cap, void *data, int32_t type) {
  if (!g_connected) return -114;
  if (cap == g_refuseSet) {
    g_refuseSet = 0;
    return -104; /* OutOfRangeValue */
  }
  PackedSetting *packed = find_packed(cap);
  if (packed && type == 16) {
    EnumData *e = data;
    if (e->type != 7 || e->data != NULL || e->value >= packed->count) return -104;
    packed->index = e->value;
    return 0;
  }
  if (cap == 0x8115 && type == 14) {
    RangeData *r = data;
    if (r->steps != 7 || r->valueIndex >= 7) return -104;
    g_ev.valueIndex = r->valueIndex;
    return 0;
  }
  if (cap == 0x8305 && type == 6) {
    g_saveMedia = *(uint32_t *)data;
    return 0;
  }
  return -107;
}

static void *save_photo_later(void *arg) {
  (void)arg;
  char file[4200];
  snprintf(file, sizeof file, "%s/DSC_%04d.JPG", g_shotDir, g_shots);
  usleep(80 * 1000);
  // Written in two halves with a pause, like a transfer still in progress.
  FILE *f = fopen(file, "wb");
  if (!f) {
    fire(11, 0); // AcquireFailed_ImageNotSaved
    return NULL;
  }
  fputs("\xff\xd8mock-nikon-photo-", f);
  fflush(f);
  usleep(150 * 1000);
  fputs("end", f);
  fclose(f);
  fire(8, (uint64_t)(uintptr_t)ascii_to_utf16_alloc(file)); // ImageSaved: the client frees the path
  return NULL;
}

int32_t StartShooting(Shooting *shot, void *proc, void *ref) {
  (void)proc;
  (void)ref;
  if (!g_connected) return -114;
  if (shot->type != 1) return -103;
  if (g_saveMedia != 1) return -97; // Card: the photo would never reach the PC
  utf16_to_ascii(shot->path, g_shotDir, sizeof g_shotDir);
  g_lastAutoFocus = shot->autoFocus;
  g_shots++;
  pthread_t t;
  pthread_create(&t, NULL, save_photo_later, NULL);
  pthread_detach(t);
  return 0;
}

static void *liveview_loop(void *arg) {
  (void)arg;
  for (int n = 1; g_lvOn; n++) {
    char text[64];
    int len = snprintf(text, sizeof text, "\xff\xd8 frame %d", n);
    LiveViewData *frame = g_alloc(sizeof(LiveViewData));
    memset(frame, 0, sizeof(*frame));
    frame->image = g_alloc((size_t)len);
    memcpy(frame->image, text, (size_t)len);
    frame->imageSize = (uint32_t)len;
    ((LiveViewProc)g_cb.liveView)(g_cb.ref, frame); // client frees frame and image
    usleep(30 * 1000);
  }
  return NULL;
}

int32_t StartLiveView(void *proc, void *ref) {
  (void)proc;
  (void)ref;
  if (!g_connected) return -114;
  if (g_lvOn) return -112;
  g_lvOn = 1;
  pthread_create(&g_lvThread, NULL, liveview_loop, NULL);
  return 0;
}

int32_t StopLiveView(void *proc, void *ref) {
  (void)proc;
  (void)ref;
  if (!g_lvOn) return -111;
  stop_liveview_thread();
  return 0;
}

/* Test controls, not part of the SDK. */
static void *device_change_later(void *arg) {
  (void)arg;
  usleep(10 * 1000);
  fire(7, 0); // DeviceInfoChanged
  return NULL;
}
void mock_unplug(void) {
  g_unplugged = 1;
  pthread_t t;
  pthread_create(&t, NULL, device_change_later, NULL);
  pthread_detach(t);
}
uint32_t mock_save_media(void) { return g_saveMedia; }
int32_t mock_last_autofocus(void) { return g_lastAutoFocus; }
uint32_t mock_ui_answer(void) { return g_uiAnswer; }
uint32_t mock_setting_index(uint32_t cap) {
  PackedSetting *p = find_packed(cap);
  return p ? p->index : 0xffffffffu;
}
uint32_t mock_ev_index(void) { return g_ev.valueIndex; }
void mock_refuse_next_set(uint32_t cap) { g_refuseSet = cap; }
