#include <Arduino.h>

const int ADC_PIN = A0;   // Halved voltage input
const int LED_PIN = 3;    // PWM LED output (D3 on ATmega328P)

void setup() {
  Serial.begin(115200);
  pinMode(ADC_PIN, INPUT);
  pinMode(LED_PIN, OUTPUT);
}

void loop() {
  // Read halved voltage (0 - 1023)
  int raw_val = analogRead(ADC_PIN);
  
  // Adjust PWM duty cycle (0 - 255) accordingly
  // 10-bit input -> 8-bit output (divide by 4)
  int pwm_val = raw_val / 4;
  analogWrite(LED_PIN, pwm_val);
  
  // Log results
  Serial.print("raw_adc=");
  Serial.print(raw_val);
  Serial.print(" pwm_out=");
  Serial.println(pwm_val);
  
  delay(50); // 50ms interval
}
