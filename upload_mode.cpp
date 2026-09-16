#include "upload_mode.h"

#include <Arduino.h>
#include <LittleFS.h>
#include <WebServer.h>
#include <WiFi.h>
#include <esp_partition.h>

using namespace protoshade;

namespace upload {
namespace {

constexpr const char* kPartitionLabel = "protoshade";

ProtoShadeRuntime* runtime_ = nullptr;
WebServer server(80);
const esp_partition_t* partition = nullptr;
esp_partition_mmap_handle_t mapping = 0;
bool mapped = false;
String address_;
bool last_failed = false;

// Upload state. The handler is called chunk by chunk from loop(), never concurrently.
// Named `state`, not `upload`: a variable with the same name as the enclosing namespace
// hides it, and then nothing inside here can say upload:: again.
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
} state;

// ---------------------------------------------------------------------------
// Flash
// ---------------------------------------------------------------------------

void unmapProgram() {
  if (runtime_) runtime_->unload();  // stop rendering out of bytes that are about to be erased
  if (mapped) {
    esp_partition_munmap(mapping);
    mapped = false;
  }
}

// Maps the partition and hands the runtime whatever is in it. Returns false when there is
// no valid program yet - the runtime then draws its built-in test pattern instead of nothing.
bool loadProgram() {
  if (!runtime_) return false;
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

  if (!runtime_->load(bytes, declared)) {
    Serial.printf("bad program, status %d\n", int(runtime_->status()));
    return false;
  }
  Serial.printf("loaded: %u instructions, %u assets, %u sensor slots, authored for %ux%u\n",
                runtime_->instructionCount(), runtime_->assetCount(), runtime_->sensorCount(),
                runtime_->programWidthHint(), runtime_->programHeightHint());
  return true;
}

// Writes one 4096-byte sector. Flash wants whole sectors, and an upload arrives in chunks of
// whatever size the browser felt like, so everything goes through this.
bool flushSector() {
  if (state.inSector == 0) return true;
  // Pad the tail: the region is erased to 0xFF anyway, and total_length says where the
  // program really ends.
  memset(state.sector + state.inSector, 0xFF, sizeof(state.sector) - state.inSector);
  const esp_err_t err = esp_partition_write(partition, state.written, state.sector, sizeof(state.sector));
  if (err != ESP_OK) {
    state.failed = true;
    state.error = "flash write failed";
    return false;
  }
  state.written += sizeof(state.sector);
  state.inSector = 0;
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
  String json = "{\"status\":" + String(int(runtime_->status()));
  json += ",\"loaded\":" + String(runtime_->hasProgram() ? "true" : "false");
  json += ",\"instructions\":" + String(runtime_->instructionCount());
  json += ",\"assets\":" + String(runtime_->assetCount());
  json += ",\"sensors\":" + String(runtime_->sensorCount());
  json += ",\"width\":" + String(runtime_->width()) + ",\"height\":" + String(runtime_->height());
  json += ",\"partition\":" + String(partition ? partition->size : 0) + "}";
  server.send(200, "application/json", json);
}

// Streams the upload straight into flash. Nothing is buffered in RAM beyond one sector,
// because a .bin with a few images in it is bigger than the heap.
void handleUploadChunk() {
  HTTPUpload& chunk = server.upload();

  if (chunk.status == UPLOAD_FILE_START) {
    state.reset();
    if (!partition) {
      state.fail("no 'protoshade' partition - check partitions.csv");
      return;
    }
    // Rendering is about to lose the bytes under it.
    unmapProgram();
    Serial.printf("upload: %s\n", chunk.filename.c_str());
    return;
  }

  if (chunk.status == UPLOAD_FILE_WRITE && !state.failed) {
    for (size_t i = 0; i < chunk.currentSize;) {
      const size_t take = min(chunk.currentSize - i, sizeof(state.sector) - state.inSector);
      memcpy(state.sector + state.inSector, chunk.buf + i, take);
      state.inSector += take;
      i += take;

      // The header is in the first 48 bytes. Check it before erasing anything, so a garbage
      // upload cannot wipe a program that works.
      if (state.declared == 0 && state.written == 0 && state.inSector >= format::kHeaderSize) {
        const uint8_t* h = state.sector;
        uint32_t declared = 0;
        for (int b = 0; b < 4; b++) declared |= uint32_t(h[36 + b]) << (8 * b);
        if (memcmp(h, format::kMagic, 4) != 0) {
          state.fail("not a ProtoShade .bin");
          return;
        }
        if (uint16_t(h[4] | (h[5] << 8)) != format::kVersion) {
          state.fail("built by a different ProtoShade version");
          return;
        }
        if (declared < format::kHeaderSize || declared > partition->size) {
          state.fail("program does not fit the partition");
          return;
        }
        state.declared = declared;

        // Erase only what this program needs, rounded up to whole sectors. Erasing a
        // megabyte we are not going to use would cost a second for nothing.
        const uint32_t span = (declared + 4095) & ~uint32_t(4095);
        if (esp_partition_erase_range(partition, 0, span) != ESP_OK) {
          state.fail("flash erase failed");
          return;
        }
      }

      if (state.inSector == sizeof(state.sector) && !flushSector()) return;
    }
    return;
  }

  if (chunk.status == UPLOAD_FILE_END && !state.failed) {
    flushSector();
  }
}

void handleUploadDone() {
  last_failed = state.failed || state.declared == 0;
  if (state.failed) {
    server.send(400, "text/plain", String("upload rejected: ") + state.error);
    loadProgram();  // whatever was there before, if the erase never happened
    return;
  }
  if (state.declared == 0) {
    server.send(400, "text/plain", "upload rejected: file is too short to be a .bin");
    loadProgram();
    return;
  }

  if (!loadProgram()) {
    last_failed = true;
    server.send(400, "text/plain",
                String("stored, but the runtime refused it (status ") + int(runtime_->status()) +
                    "). The head is showing its test pattern.");
    return;
  }
  server.send(200, "text/plain",
              String("ok - ") + state.declared + " bytes stored and running: " +
                  runtime_->instructionCount() + " instructions, " + runtime_->assetCount() +
                  " images, " + runtime_->sensorCount() + " sensor slots.");
}
}  // namespace

bool loadProgramFromFlash(ProtoShadeRuntime& runtime) {
  runtime_ = &runtime;
  if (!partition) {
    partition = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_ANY, kPartitionLabel);
  }
  if (!partition) {
    Serial.println("no 'protoshade' partition in the partition table - check partitions.csv");
    return false;
  }
  return loadProgram();
}

bool begin(ProtoShadeRuntime& runtime, const char* ap_ssid, const char* ap_password) {
  runtime_ = &runtime;
  if (!partition) {
    partition = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_ANY, kPartitionLabel);
  }
  if (!LittleFS.begin(true)) Serial.println("LittleFS mount failed - /upload still works");

  WiFi.mode(WIFI_AP);
  WiFi.softAP(ap_ssid, ap_password);
  address_ = WiFi.softAPIP().toString();
  Serial.printf("upload mode: join %s, open http://%s/\n", ap_ssid, address_.c_str());

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
  return true;
}

void handle() { server.handleClient(); }

bool lastUploadFailed() { return last_failed; }

const char* address() { return address_.c_str(); }

}  // namespace upload
