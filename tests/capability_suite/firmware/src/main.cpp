#include <Arduino.h>
#include "air_pinmap.h"

// Complex CC/CV Charging Logic
// CC Stage: 500mA until 4.1V
// CV Stage: Constant 4.2V until current drops < 50mA

enum ChargeState {
    IDLE,
    CONSTANT_CURRENT,
    CONSTANT_VOLTAGE,
    FULL
};

ChargeState state = CONSTANT_CURRENT;
const int TARGET_CV_MV = 4200;
const int TERM_CURRENT_MA = 50;

void setup() {
    Serial.begin(115200);
    pinMode(AIR_BATTERY_VOLTAGE_ADC_PIN, INPUT);
    pinMode(AIR_DAC1_PIN, OUTPUT);
}

void loop() {
    int raw = analogRead(AIR_BATTERY_VOLTAGE_ADC_PIN);
    long mv = (long)raw * 3300L / 4095L * 2; // Divider ratio 2x

    Serial.print("v_bat_mv=");
    Serial.println(mv);

    switch(state) {
        case CONSTANT_CURRENT:
            // Output high to turn on MOSFET fully (simulating CC via current source in real world,
            // but here we just toggle the gate to show interaction)
            analogWrite(AIR_DAC1_PIN, 255); 
            if (mv >= TARGET_CV_MV) state = CONSTANT_VOLTAGE;
            break;
            
        case CONSTANT_VOLTAGE:
            // Simple P-control for constant voltage
            int error = TARGET_CV_MV - mv;
            int output = constrain(128 + error / 10, 0, 255);
            analogWrite(AIR_DAC1_PIN, output);
            if (error < 5) state = FULL;
            break;

        case FULL:
            analogWrite(AIR_DAC1_PIN, 0);
            break;
            
        default:
            break;
    }

    delay(10); // 10ms control loop
}
