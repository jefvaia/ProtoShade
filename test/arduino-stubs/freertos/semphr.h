#pragma once
// Syntax-check stub, see Arduino.h.
#include <freertos/FreeRTOS.h>

SemaphoreHandle_t xSemaphoreCreateBinary();
SemaphoreHandle_t xSemaphoreCreateCounting(UBaseType_t, UBaseType_t);
BaseType_t xSemaphoreTake(SemaphoreHandle_t, uint32_t);
BaseType_t xSemaphoreGive(SemaphoreHandle_t);
void vSemaphoreDelete(SemaphoreHandle_t);
