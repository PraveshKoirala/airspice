/**
 * @file main.cpp
 * @brief ESP32-C3 Temperature Controller and Load Driver Firmware
 * 
 * This firmware reads an analog temperature sensor (thermistor voltage divider)
 * on GPIO0 (ADC1_CH0), performs filtering, computes the temperature,
 * and controls a high-power load via a MOSFET on GPIO1.
 * It also controls an active-low status LED on GPIO2.
 */

#include <Arduino.h>

// Pin Definitions
#define PIN_TEMP_SENSE 0   // GPIO0 (ADC1_CH0)
#define PIN_LOAD_CTRL  1   // GPIO1 (MOSFET Gate)
#define PIN_STATUS_LED 2   // GPIO2 (Active-Low LED)

// Thermistor Parameter Constants
const float SERIES_RESISTOR = 10000.0; // 10k ohm voltage divider pulldown
const float THERMISTOR_NOMINAL = 10000.0; // 10k ohm thermistor at 25C
const float TEMPERATURE_NOMINAL = 25.0; // 25 degrees C
const float B_COEFFICIENT = 3950.0; // Beta coefficient
const float ADC_MAX = 4095.0; // 12-bit ADC
const float VREF = 3.3; // 3.3V reference

// Temperature Thresholds for Bang-Bang Control
const float TEMP_SETPOINT = 35.0; // Setpoint in C
const float TEMP_HYSTERESIS = 1.0; // Hysteresis band

// Timing Variables
unsigned long last_sensor_read_time = 0;
const unsigned long SENSOR_READ_INTERVAL = 1000; // Read every 1s

/**
 * @brief Read temperature from thermistor divider
 * @return Temperature in Celsius
 */
float readTemperature() {
    int adc_val = analogRead(PIN_TEMP_SENSE);
    if (adc_val == 0) return -273.15; // Prevent division by zero

    // Calculate voltage and resistance of thermistor
    // Thermistor is on high side (VCC to ADC), Series pulldown is on low side (ADC to GND)
    // V_adc = VREF * R_div / (R_therm + R_div)
    // R_therm = R_div * (VREF - V_adc) / V_adc = R_div * (ADC_MAX - ADC_VAL) / ADC_VAL
    float r_therm = SERIES_RESISTOR * (ADC_MAX - (float)adc_val) / (float)adc_val;

    // Apply Beta Equation to get Kelvin
    float kelvin = r_therm / THERMISTOR_NOMINAL;     // R/Ro
    kelvin = log(kelvin);                            // ln(R/Ro)
    kelvin /= B_COEFFICIENT;                         // 1/B * ln(R/Ro)
    kelvin += 1.0 / (TEMPERATURE_NOMINAL + 273.15); // + 1/To
    kelvin = 1.0 / kelvin;                           // Invert to get Kelvin

    return kelvin - 273.15; // Convert to Celsius
}

void setup() {
    // Initialize Serial Port
    Serial.begin(115200);
    delay(500);
    Serial.println("--- ESP32-C3 Intelligent Sensor Node Initialized ---");

    // Initialize Pins
    pinMode(PIN_LOAD_CTRL, OUTPUT);
    pinMode(PIN_STATUS_LED, OUTPUT);
    
    // Set initial states
    digitalWrite(PIN_LOAD_CTRL, LOW);   // Load OFF
    digitalWrite(PIN_STATUS_LED, HIGH); // LED OFF (Active-Low)

    // Configure ADC resolution (12-bit is default on ESP32-C3)
    analogReadResolution(12);
}

void loop() {
    unsigned long current_time = millis();

    // Periodic sensor reading and control logic
    if (current_time - last_sensor_read_time >= SENSOR_READ_INTERVAL) {
        last_sensor_read_time = current_time;

        float temperature = readTemperature();
        Serial.printf("Sensor Reading - ADC: %d, Temp: %.2f C\n", analogRead(PIN_TEMP_SENSE), temperature);

        // Active-low status LED heart-beat / error indicator
        if (temperature < -50.0 || temperature > 150.0) {
            // Sensor fault - rapid blink and turn off load for safety
            digitalWrite(PIN_LOAD_CTRL, LOW);
            for (int i = 0; i < 5; i++) {
                digitalWrite(PIN_STATUS_LED, LOW);
                delay(50);
                digitalWrite(PIN_STATUS_LED, HIGH);
                delay(50);
            }
            Serial.println("WARNING: Sensor Fault Detected! Disabling Load.");
            return;
        }

        // Thermostatic (Bang-Bang) Control with Hysteresis
        // If temperature goes below (SETPOINT - HYSTERESIS), turn ON heating load
        // If temperature goes above (SETPOINT + HYSTERESIS), turn OFF heating load
        if (temperature < (TEMP_SETPOINT - TEMP_HYSTERESIS)) {
            digitalWrite(PIN_LOAD_CTRL, HIGH);
            digitalWrite(PIN_STATUS_LED, LOW); // LED ON indicating active heating
            Serial.println("Thermostat Status: HEATING ACTIVE");
        } 
        else if (temperature > (TEMP_SETPOINT + TEMP_HYSTERESIS)) {
            digitalWrite(PIN_LOAD_CTRL, LOW);
            digitalWrite(PIN_STATUS_LED, HIGH); // LED OFF indicating load inactive
            Serial.println("Thermostat Status: STANDBY (Setpoint reached)");
        }
    }
}
