#include <Arduino.h>
#include "air_pinmap.h"
#include "air_config.h"

static long battery_raw_to_mv(int raw) {
  return (long)raw * 3300L / 4095L;
}

void setup() {
  Serial.begin(AIR_UART_BAUD);
}

void loop() {
  Serial.println("air_status=idle");
  delay(1000);
}
