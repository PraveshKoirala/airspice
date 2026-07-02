/**
 * @file config.h
 * @brief Configuration settings for the ESP32-C3 Sensor Node
 */

#ifndef CONFIG_H
#define CONFIG_H

// Network Configuration (Placeholder for future wireless capability)
#define WIFI_SSID       "SensorNode_AP"
#define WIFI_PASSWORD   "SecurePass123"

// System Configuration
#define FW_VERSION      "1.0.0"
#define DEVICE_NAME     "ESP32C3-TEMP-CTRL-01"

// Hardware Configuration
#define STATUS_LED_ACTIVE_LOW  true
#define ADC_OVERSAMPLING_SAMPLES 16

#endif // CONFIG_H
