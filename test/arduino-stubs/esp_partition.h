#pragma once
// Syntax-check stub, see Arduino.h.
#include <cstdint>
#include <cstddef>

typedef int esp_err_t;
#define ESP_OK 0
typedef enum { ESP_PARTITION_TYPE_APP, ESP_PARTITION_TYPE_DATA } esp_partition_type_t;
typedef enum { ESP_PARTITION_SUBTYPE_ANY } esp_partition_subtype_t;
typedef enum { ESP_PARTITION_MMAP_DATA } esp_partition_mmap_memory_t;
typedef uint32_t esp_partition_mmap_handle_t;

typedef struct {
  uint32_t size;
} esp_partition_t;

const esp_partition_t* esp_partition_find_first(esp_partition_type_t, esp_partition_subtype_t, const char*);
esp_err_t esp_partition_mmap(const esp_partition_t*, size_t, size_t, esp_partition_mmap_memory_t, const void**, esp_partition_mmap_handle_t*);
void esp_partition_munmap(esp_partition_mmap_handle_t);
esp_err_t esp_partition_erase_range(const esp_partition_t*, size_t, size_t);
esp_err_t esp_partition_write(const esp_partition_t*, size_t, const void*, size_t);
