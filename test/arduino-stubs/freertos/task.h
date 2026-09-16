#pragma once
// Syntax-check stub, see Arduino.h.
#include <freertos/FreeRTOS.h>

BaseType_t xTaskCreatePinnedToCore(void (*)(void*), const char*, uint32_t, void*, UBaseType_t, TaskHandle_t*, BaseType_t);
void vTaskDelete(TaskHandle_t);
