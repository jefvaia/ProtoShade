// The head as a web server: serves the ProtoShade editor, takes a .bin upload, stores it in
// flash, and renders it across both cores.
//
//   http://<device>/          the editor (from LittleFS, if you uploaded the data folder)
//   http://<device>/upload    upload page, built into this sketch - always there
//   http://<device>/status    what is loaded right now, as JSON
//
// Flashing this needs two things beyond the sketch:
//
//   1. partitions.csv next to this file, selected as the custom partition scheme. It carves
//      out a 1 MB "protoshade" data partition for the .bin and a LittleFS partition for the
//      editor. Without it there is nowhere to put a program.
//   2. npm run build:device, which writes examples/ProtoShadeWeb/data/ - the editor,
//      gzipped. Upload it with the LittleFS uploader plugin or arduino-cli. Skip this and
//      everything still works, you just use the built-in upload page instead of the editor.
//
// The program blob belongs in flash, NOT in RTC memory: RTC RAM is 8 KB and loses its
// contents on power loss. esp_partition_mmap() maps the partition into the address space, so
// the images inside a .bin cost no RAM no matter how many you pack.

#include <LittleFS.h>
#include <WebServer.h>
#include <WiFi.h>
#include <esp_partition.h>

#include <ProtoShadeParallel.h>
#include <ProtoShadeRuntime.h>

using namespace protoshade;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Leave WIFI_SSID empty to run as an access point instead of joining a network.
#define WIFI_SSID ""
#define WIFI_PASSWORD ""
#define AP_SSID "ProtoShade"
#define AP_PASSWORD "protogen"  // at least 8 characters, or the AP silently stays open

constexpr uint16_t WIDTH = 64;
constexpr uint16_t HEIGHT = 32;
constexpr uint8_t SENSOR_SLOTS = 8;
constexpr const char* PARTITION_LABEL = "protoshade";

// ---------------------------------------------------------------------------

ProtoShadeRuntime runtime;
ParallelRenderer renderer;
WebServer server(80);

Pixel framebuffer[WIDTH * HEIGHT];
float sensorValues[SENSOR_SLOTS];

const esp_partition_t* partition = nullptr;
esp_partition_mmap_handle_t mapping = 0;
bool mapped = false;

// Upload state. The handler is called chunk by chunk from loop(), never concurrently.
struct Upload {
  uint8_t sector[4096];
  size_t inSector;
  uint32_t written;
  uint32_t declared;  // total_length out of the header, known once 48 bytes have arrived
  bool failed;
  const char* error;

  // Resets the bookkeeping but not the 4 KB buffer: assigning a fresh Upload{} would put a
  // 4 KB temporary on a handler stack that does not have room for it.
  void reset() {
    inSector = 0;
    written = 0;
    declared = 0;
    failed = false;
    error = "";
  }
  void fail(const char* why) {
    failed = true;
    error = why;
  }
} upload;

// ---------------------------------------------------------------------------
// Flash
// ---------------------------------------------------------------------------

void unmapProgram() {
  runtime.unload();  // stop rendering out of bytes that are about to be erased
  if (mapped) {
    esp_partition_munmap(mapping);
    mapped = false;
  }
}

// Maps the partition and hands the runtime whatever is in it. Returns false when there is
// no valid program yet - the runtime then draws its built-in test pattern instead of nothing.
bool loadProgramFromFlash() {
  unmapProgram();
  if (!partition) return false;

  const void* data = nullptr;
  if (esp_partition_mmap(partition, 0, partition->size, ESP_PARTITION_MMAP_DATA, &data, &mapping) != ESP_OK) {
    Serial.println("mmap failed");
    return false;
  }
  mapped = true;

  // The header's total_length says how long the blob really is; the partition is bigger.
  const uint8_t* bytes = static_cast<const uint8_t*>(data);
  uint32_t declared = 0;
  for (int i = 0; i < 4; i++) declared |= uint32_t(bytes[36 + i]) << (8 * i);
  if (declared < format::kHeaderSize || declared > partition->size) {
    Serial.println("no program flashed yet");
    return false;
  }

  if (!runtime.load(bytes, declared)) {
    Serial.printf("bad program, status %d\n", int(runtime.status()));
    return false;
  }
  Serial.printf("loaded: %u instructions, %u assets, %u sensor slots, authored for %ux%u\n",
                runtime.instructionCount(), runtime.assetCount(), runtime.sensorCount(),
                runtime.programWidthHint(), runtime.programHeightHint());
  return true;
}

// Writes one 4096-byte sector. Flash wants whole sectors, and an upload arrives in chunks of
// whatever size the browser felt like, so everything goes through this.
bool flushSector() {
  if (upload.inSector == 0) return true;
  // Pad the tail: the region is erased to 0xFF anyway, and total_length says where the
  // program really ends.
  memset(upload.sector + upload.inSector, 0xFF, sizeof(upload.sector) - upload.inSector);
  const esp_err_t err = esp_partition_write(partition, upload.written, upload.sector, sizeof(upload.sector));
  if (err != ESP_OK) {
    upload.failed = true;
    upload.error = "flash write failed";
    return false;
  }
  upload.written += sizeof(upload.sector);
  upload.inSector = 0;
  return true;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const char kUploadPage[] PROGMEM = R"(<!doctype html><html><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1"><title>ProtoShade upload</title>
<style>body{background:#171717;color:#e5e5e5;font:14px ui-monospace,monospace;display:flex;
min-height:100vh;align-items:center;justify-content:center;margin:0}form{display:flex;gap:12px;
flex-direction:column;align-items:stretch;min-width:280px}h1{font-size:15px;letter-spacing:3px;
text-transform:uppercase;text-align:center}button,input{font:inherit;padding:8px;border-radius:6px;
border:1px solid #404040;background:#262626;color:inherit}button{background:#047857;border:0;cursor:pointer}
#s{min-height:2.5em;color:#a3a3a3;white-space:pre-line}</style></head><body>
<form id=f><h1>ProtoShade</h1><input type=file id=file accept=.bin required>
<button>upload to head</button><div id=s></div></form><script>
const s=document.getElementById('s');
fetch('/status').then(r=>r.text()).then(t=>s.textContent=t).catch(()=>{});
document.getElementById('f').onsubmit=async e=>{e.preventDefault();
const f=document.getElementById('file').files[0];if(!f)return;s.textContent='uploading '+f.size+' bytes...';
const d=new FormData();d.append('program',f,'program.bin');
try{const r=await fetch('/program.bin',{method:'POST',body:d});s.textContent=await r.text();}
catch(err){s.textContent='upload failed: '+err;}};
</script></body></html>)";

String contentType(const String& path) {
  if (path.endsWith(".html")) return "text/html";
  if (path.endsWith(".js")) return "text/javascript";
  if (path.endsWith(".css")) return "text/css";
  return "application/octet-stream";
}

// Serves a file from LittleFS, preferring the gzipped copy build:device writes. Returns
// false when the editor was never uploaded, which is not an error - /upload still works.
bool serveFromFs(String path) {
  if (path.endsWith("/")) path += "index.html";
  const String gz = path + ".gz";
  const bool zipped = LittleFS.exists(gz);
  if (!zipped && !LittleFS.exists(path)) return false;

  File file = LittleFS.open(zipped ? gz : path, "r");
  if (!file) return false;
  if (zipped) server.sendHeader("Content-Encoding", "gzip");
  server.streamFile(file, contentType(path));
  file.close();
  return true;
}

void handleStatus() {
  String json = "{\"status\":" + String(int(runtime.status()));
  json += ",\"loaded\":" + String(runtime.hasProgram() ? "true" : "false");
  json += ",\"instructions\":" + String(runtime.instructionCount());
  json += ",\"assets\":" + String(runtime.assetCount());
  json += ",\"sensors\":" + String(runtime.sensorCount());
  json += ",\"width\":" + String(runtime.width()) + ",\"height\":" + String(runtime.height());
  json += ",\"partition\":" + String(partition ? partition->size : 0) + "}";
  server.send(200, "application/json", json);
}

// Streams the upload straight into flash. Nothing is buffered in RAM beyond one sector,
// because a .bin with a few images in it is bigger than the heap.
void handleUploadChunk() {
  HTTPUpload& chunk = server.upload();

  if (chunk.status == UPLOAD_FILE_START) {
    upload.reset();
    if (!partition) {
      upload.fail("no 'protoshade' partition - check partitions.csv");
      return;
    }
    // Rendering is about to lose the bytes under it.
    unmapProgram();
    Serial.printf("upload: %s\n", chunk.filename.c_str());
    return;
  }

  if (chunk.status == UPLOAD_FILE_WRITE && !upload.failed) {
    for (size_t i = 0; i < chunk.currentSize;) {
      const size_t take = min(chunk.currentSize - i, sizeof(upload.sector) - upload.inSector);
      memcpy(upload.sector + upload.inSector, chunk.buf + i, take);
      upload.inSector += take;
      i += take;

      // The header is in the first 48 bytes. Check it before erasing anything, so a garbage
      // upload cannot wipe a program that works.
      if (upload.declared == 0 && upload.written == 0 && upload.inSector >= format::kHeaderSize) {
        const uint8_t* h = upload.sector;
        uint32_t declared = 0;
        for (int b = 0; b < 4; b++) declared |= uint32_t(h[36 + b]) << (8 * b);
        if (memcmp(h, format::kMagic, 4) != 0) {
          upload.fail("not a ProtoShade .bin");
          return;
        }
        if (uint16_t(h[4] | (h[5] << 8)) != format::kVersion) {
          upload.fail("built by a different ProtoShade version");
          return;
        }
        if (declared < format::kHeaderSize || declared > partition->size) {
          upload.fail("program does not fit the partition");
          return;
        }
        upload.declared = declared;

        // Erase only what this program needs, rounded up to whole sectors. Erasing a
        // megabyte we are not going to use would cost a second for nothing.
        const uint32_t span = (declared + 4095) & ~uint32_t(4095);
        if (esp_partition_erase_range(partition, 0, span) != ESP_OK) {
          upload.fail("flash erase failed");
          return;
        }
      }

      if (upload.inSector == sizeof(upload.sector) && !flushSector()) return;
    }
    return;
  }

  if (chunk.status == UPLOAD_FILE_END && !upload.failed) {
    flushSector();
  }
}

void handleUploadDone() {
  if (upload.failed) {
    server.send(400, "text/plain", String("upload rejected: ") + upload.error);
    loadProgramFromFlash();  // whatever was there before, if the erase never happened
    return;
  }
  if (upload.declared == 0) {
    server.send(400, "text/plain", "upload rejected: file is too short to be a .bin");
    loadProgramFromFlash();
    return;
  }

  if (!loadProgramFromFlash()) {
    server.send(400, "text/plain",
                String("stored, but the runtime refused it (status ") + int(runtime.status()) +
                    "). The head is showing its test pattern.");
    return;
  }
  server.send(200, "text/plain",
              String("ok - ") + upload.declared + " bytes stored and running: " +
                  runtime.instructionCount() + " instructions, " + runtime.assetCount() +
                  " images, " + runtime.sensorCount() + " sensor slots.");
}

// ---------------------------------------------------------------------------
// Sensors
// ---------------------------------------------------------------------------

// Your hardware goes here. Fill the slots the Sensor nodes in the editor point at, in the
// range each one declares: slot 0 is Sensor index 0. A slot you never write reads 0, and a
// slot the program expects but this sketch does not fill falls back to the value baked into
// the .bin - so a half-wired head still renders.
void readSensors() {
  // Example: a flex sensor on GPIO 1, reported as 0..1.
  // sensorValues[0] = analogRead(1) / 4095.0f;
  sensorValues[0] = 0.5f + 0.5f * sinf(millis() / 800.0f);  // placeholder, remove
}

// ---------------------------------------------------------------------------

void setup() {
  Serial.begin(115200);
  delay(200);

  runtime.setResolution(WIDTH, HEIGHT);

  partition = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_ANY, PARTITION_LABEL);
  if (!partition) Serial.println("no 'protoshade' partition in the partition table");
  loadProgramFromFlash();

  if (!LittleFS.begin(true)) Serial.println("LittleFS mount failed - /upload still works");

  if (strlen(WIFI_SSID) > 0) {
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    Serial.printf("joining %s", WIFI_SSID);
    for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) {
      delay(250);
      Serial.print(".");
    }
    Serial.println();
  }
  if (WiFi.status() != WL_CONNECTED) {
    WiFi.mode(WIFI_AP);
    WiFi.softAP(AP_SSID, AP_PASSWORD);
    Serial.printf("access point %s, open http://%s/\n", AP_SSID, WiFi.softAPIP().toString().c_str());
  } else {
    Serial.printf("open http://%s/\n", WiFi.localIP().toString().c_str());
  }

  server.on("/upload", HTTP_GET, []() { server.send_P(200, "text/html", kUploadPage); });
  server.on("/status", HTTP_GET, handleStatus);
  server.on("/program.bin", HTTP_POST, handleUploadDone, handleUploadChunk);
  // Anything else: the editor out of LittleFS, or a pointer at the upload page.
  server.onNotFound([]() {
    if (serveFromFs(server.uri())) return;
    if (server.uri() == "/") {
      server.send_P(200, "text/html", kUploadPage);
      return;
    }
    server.send(404, "text/plain", "not found - try /upload");
  });
  server.begin();

  // Two pinned tasks, created once. Core 0 takes the top half, core 1 the bottom - and core
  // 0 is also running WiFi now, so the top half is the slower one.
  if (!renderer.begin()) Serial.println("renderer.begin() failed - out of memory?");
}

void loop() {
  server.handleClient();

  readSensors();
  // One snapshot per frame, shared by both cores: a reading that changed halfway through
  // would render the top half of the face differently from the bottom.
  const Sensors sensors{sensorValues, SENSOR_SLOTS};
  const Frame frame = runtime.beginFrame(millis(), sensors);
  if (!renderer.render(runtime, frame, framebuffer)) {
    Serial.println("step budget exceeded - the shader is too heavy");
  }

  // Your panel driver goes here: push `framebuffer` (WIDTH * HEIGHT RGB pixels) out over
  // HUB75 / WS2812 / whatever the visor uses.
  const Pixel& p = framebuffer[0];
  rgbLedWrite(RGB_BUILTIN, p.r / 8, p.g / 8, p.b / 8);  // /8 because it is blinding

  delay(5);
}
