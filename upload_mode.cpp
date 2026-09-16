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

// Serial upload. The chunk is small enough to sit on the loop task's stack and big enough
// that the acks are not the thing setting the transfer rate; the timeout is per read, so a
// host that dies mid-file costs one of these and not the face.
constexpr size_t kSerialChunk = 1024;
constexpr uint32_t kSerialTimeoutMs = 3000;

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
  // The first sector, held back until the last byte of the program is in flash. The magic
  // and total_length live in it, so until it is written the partition does not parse as a
  // program at all - which is the whole point. A transfer that stops halfway, or a head
  // unplugged mid-upload, then leaves something that is refused rather than something that
  // loads and renders erased flash. Erased flash is 0xFF, and 0xFF in an RGBA image is
  // opaque white, so the failure that shape of bug produces is a face that is simply white.
  // 4 KB of static RAM to make a half-written face impossible is a good trade.
  uint8_t first[4096];
  size_t inSector;
  uint32_t written;
  uint32_t erased;    // how far the erase has got, ahead of `written`
  uint32_t declared;  // total_length out of the header, known once 48 bytes have arrived
  bool failed;
  const char* error;

  // Resets the bookkeeping but not the 4 KB buffer: assigning a fresh Upload{} would put a
  // 4 KB temporary on a handler stack that does not have room for it.
  void reset() {
    inSector = 0;
    written = 0;
    erased = 0;
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

// Erases ahead of the write head, a block at a time.
//
// Erasing the program's whole span in one call was simpler and, on a big .bin, fatal: the
// head stops answering for as long as it takes, and the host is sitting on a ten-second
// timeout waiting for the ack that paces the transfer. Three and a half megabytes is on the
// order of ten seconds of erase, so the transfer died at the first chunk of a big file and
// blamed the cable. A block at a time is the same total work spread over the upload, and no
// single call takes longer than one erase of one block.
//
// 64 KB because that is the block the flash erases natively; going sector by sector would be
// correct and several times slower.
constexpr uint32_t kEraseBlock = 64 * 1024;

bool eraseThrough(uint32_t upto) {
  while (state.erased < upto) {
    uint32_t take = kEraseBlock;
    if (state.erased + take > partition->size) take = partition->size - state.erased;
    if (take == 0 || esp_partition_erase_range(partition, state.erased, take) != ESP_OK) {
      state.fail("flash erase failed");
      return false;
    }
    state.erased += take;
  }
  return true;
}

// Writes one 4096-byte sector. Flash wants whole sectors, and an upload arrives in chunks of
// whatever size the browser felt like, so everything goes through this.
bool flushSector() {
  if (state.inSector == 0) return true;
  // Pad the tail: the region is erased to 0xFF anyway, and total_length says where the
  // program really ends.
  memset(state.sector + state.inSector, 0xFF, sizeof(state.sector) - state.inSector);

  // Sector zero is kept in RAM and written by commit() once everything else has landed.
  if (state.written == 0) {
    memcpy(state.first, state.sector, sizeof(state.sector));
    state.written += sizeof(state.sector);
    state.inSector = 0;
    return true;
  }

  if (!eraseThrough(state.written + uint32_t(sizeof(state.sector)))) return false;
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

// The last write of an upload: the header, which is what makes the partition a program.
//
// Nothing before this point is loadable, so there is no window in which a half-written file
// looks like a whole one - not to the next loadProgram(), and not to the next boot either.
// It also refuses to commit a file shorter than its own header claims, which is the other
// way a browser can leave a program with a tail of erased flash in it.
bool commit() {
  if (state.declared == 0 || state.written == 0) {
    state.fail("nothing was written");
    return false;
  }
  if (state.written < state.declared) {
    state.fail("the transfer stopped halfway");
    return false;
  }
  if (!eraseThrough(uint32_t(sizeof(state.first)))) return false;
  if (esp_partition_write(partition, 0, state.first, sizeof(state.first)) != ESP_OK) {
    state.fail("flash write failed");
    return false;
  }
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
  const String type = contentType(path);
  // Content-Encoding is not ours to send. streamFile() adds it itself for a file whose name
  // ends in .gz, and sendHeader() appends rather than replaces, so sending one here too put
  // two in the response: the browser reads "gzip, gzip", inflates twice and gives up - which
  // is the "Content Encoding Error" page you get instead of the editor.
  //
  // The one type it will not label that way is application/octet-stream, so a file we cannot
  // name serves its plain copy or nothing at all, never gzip nobody declared.
  const String gz = path + ".gz";
  const bool zipped = type != "application/octet-stream" && LittleFS.exists(gz);
  if (!zipped && !LittleFS.exists(path)) return false;

  File file = LittleFS.open(zipped ? gz : path, "r");
  if (!file) return false;
  server.streamFile(file, type);
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

// One chunk of an incoming .bin, wherever it arrived from. Both ways in - the browser over
// WiFi and the editor over USB - go through here, so the header check, the erase and the
// sector writes cannot drift apart between them. Returns false once the upload has failed;
// state.error says why.
//
// Nothing is buffered in RAM beyond one sector, because a .bin with a few images in it is
// bigger than the heap.
bool feed(const uint8_t* data, size_t len) {
  if (state.failed) return false;
  for (size_t i = 0; i < len;) {
    const size_t take = min(len - i, sizeof(state.sector) - state.inSector);
    memcpy(state.sector + state.inSector, data + i, take);
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
        return false;
      }
      if (uint16_t(h[4] | (h[5] << 8)) != format::kVersion) {
        state.fail("built by a different ProtoShade version");
        return false;
      }
      if (declared < format::kHeaderSize || declared > partition->size) {
        state.fail("program does not fit the partition");
        return false;
      }
      state.declared = declared;
      // Nothing is erased here: eraseThrough() does it a block ahead of the write head, so
      // the head never goes quiet for longer than one block. Until the first sector is
      // written the old program is still intact, which is what makes a rejected header
      // harmless.
    }

    if (state.inSector == sizeof(state.sector) && !flushSector()) return false;
  }
  return true;
}

// Ready to take a program: the partition is known and nothing is rendering out of it.
bool beginWrite() {
  state.reset();
  if (!partition) {
    state.fail("no 'protoshade' partition - check partitions.csv");
    return false;
  }
  unmapProgram();  // rendering is about to lose the bytes under it
  return true;
}

// Streams the upload straight into flash.
void handleUploadChunk() {
  HTTPUpload& chunk = server.upload();

  if (chunk.status == UPLOAD_FILE_START) {
    if (beginWrite()) Serial.printf("upload: %s\n", chunk.filename.c_str());
    return;
  }

  if (chunk.status == UPLOAD_FILE_WRITE) {
    feed(chunk.buf, chunk.currentSize);
    return;
  }

  if (chunk.status == UPLOAD_FILE_END && !state.failed) {
    if (flushSector()) commit();
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

// Takes a .bin over the USB port the head already logs on, so a computer with no WiFi -
// or nobody who wants to join an access point to change a face - can flash it with the
// cable that is already plugged in.
//
//   host -> head:  0x02 "PSUP" length_u32_le, then the bytes
//   head -> host:  "psflash ready <n>", one "psflash ack <n>" per chunk consumed,
//                  then "psflash done ..." or "psflash error ...", as lines in the log
//
// The ack is flow control, not politeness: writing a sector takes tens of milliseconds and
// the USB receive buffer is a few hundred bytes, so the host has to be told when to send
// more. It also means a transfer that dies halfway stops rather than silently truncating.
//
// The sketch calls this with rendering stopped; the erase takes the flash cache down with
// it and the VM would be reading the bytes being erased.
bool receiveOverSerial(ProtoShadeRuntime& runtime) {
  runtime_ = &runtime;
  if (!partition) {
    partition = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_ANY, kPartitionLabel);
  }

  Serial.setTimeout(kSerialTimeoutMs);
  uint8_t head[8];
  if (Serial.readBytes(head, sizeof(head)) != sizeof(head) || memcmp(head, "PSUP", 4) != 0) {
    Serial.println("psflash error - no PSUP header, nothing was touched");
    return false;
  }
  uint32_t declared = 0;
  for (int i = 0; i < 4; i++) declared |= uint32_t(head[4 + i]) << (8 * i);

  last_failed = true;  // until it is not
  if (!beginWrite()) {
    Serial.printf("psflash error - %s\n", state.error);
    return false;
  }
  if (declared < format::kHeaderSize || declared > partition->size) {
    Serial.println("psflash error - that length does not fit the partition");
    loadProgram();
    return false;
  }
  Serial.printf("psflash ready %lu\n", (unsigned long)declared);

  uint8_t chunk[kSerialChunk];
  uint32_t received = 0;
  while (received < declared) {
    const size_t want = min(size_t(declared - received), sizeof(chunk));
    if (Serial.readBytes(chunk, want) != want) {
      state.fail("the transfer stopped halfway");
      break;
    }
    if (!feed(chunk, want)) break;
    received += want;
    // After the write, not before: this is what tells the host the head is ready for more.
    Serial.printf("psflash ack %lu\n", (unsigned long)received);
  }

  if (!state.failed && flushSector()) commit();
  if (state.failed) {
    Serial.printf("psflash error - %s\n", state.error);
    loadProgram();  // whatever was there before, if the erase never happened
    return false;
  }
  if (!loadProgram()) {
    Serial.printf("psflash error - stored, but the runtime refused it (status %d)\n",
                  int(runtime_->status()));
    return false;
  }
  last_failed = false;
  Serial.printf("psflash done %lu bytes, %u instructions, %u images, %u sensor slots\n",
                (unsigned long)declared, runtime_->instructionCount(), runtime_->assetCount(),
                runtime_->sensorCount());
  return true;
}

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
