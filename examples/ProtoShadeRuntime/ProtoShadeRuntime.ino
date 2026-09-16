#include <ProtoShadeRuntime.h>

ProtoShadeRuntime face(8, 8);

void setup() {
  Serial.begin(115200);
}

void loop() {
  uint8_t v = face.pixel(0, 0, millis());
  rgbLedWrite(RGB_BUILTIN, 0, v / 8, v / 8);  // onboard RGB LED; /8 because it's blinding
  Serial.println(v);
  delay(20);
}
