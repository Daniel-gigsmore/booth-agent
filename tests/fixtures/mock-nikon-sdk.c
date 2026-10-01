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

int32_t GetCapability(uint32_t cap, int32_t request, void **data, int32_t *type) {
  if (!g_connected) return -114;
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
