# AIR XML Specification (v0.1) - Master Reference

This document is the canonical source of truth for the AIR (AI-Native Intermediate Representation) XML schema. All AI design tasks MUST adhere to this specification.

## 1. Root Element
- **Tag:** `<system>`
- **Attributes:**
    - `name` (string, required): A unique identifier for the system (e.g., "esp32_battery_monitor").
    - `ir_version` (string, required): Must be "0.1".

## 2. Metadata Block
Every design MUST include a `<metadata>` block.
- **Child Tags:**
    - `<title>`: Human-readable name.
    - `<description>`: Concise summary of the circuit.
    - `<author>`: Name of the designer or AI model.
    - `<created_at>`: ISO-8601 timestamp.

## 3. Nets Block
Defines all logical nodes in the circuit.
- **Tag:** `<nets>`
- **Child Tag:** `<net>`
    - `id` (string, required): Unique net identifier (e.g., "vcc", "gnd", "n1").
    - `role` (enum, optional): "power", "ground", "analog_signal", "digital_signal".
    - `nominal_voltage` (string, optional): For power nets (e.g., "3.3V").

## 4. Components Block
Defines the parts in the circuit.
- **Tag:** `<components>`
- **Child Tag:** `<component>`
    - `id` (string, required): Unique identifier (e.g., "R1", "U_MCU").
    - `type` (enum, required): One of: `resistor`, `capacitor`, `voltage_source`, `current_source`, `generic_load`, `ldo`, `mcu`, `mosfet`, `diode`, `bjt`.
    - `part` (string, optional): Specific part number (e.g., "ESP32-C3", "2N2222").
    - **Sub-Tags:**
        - `<value>`: String value (e.g., "10k", "100nF").
        - `<pin>`: Connects a part to a net.
            - `name` (string, required): Component-specific pin name.
            - `net` (string, required): The net ID it connects to.
            - `function` (string, optional): For MCUs (e.g., "ADC1_CH4").
        - `<property>`: Key-value metadata.
            - `name`: Property key.
            - `value`: Property value.

### Common Pin Conventions:
- **Resistors/Capacitors:** "1", "2"
- **Voltage/Current Sources:** "p" (positive), "n" (negative)
- **BJTs:** "B", "C", "E"
- **MOSFETs:** "G", "D", "S"
- **Diodes/LEDs:** "a" (anode), "c" (cathode)
- **LDOs:** "in", "out", "gnd"

## 5. Analog Subsystems & Probes
Used for grouping components for simulation and placing measurement points.
- **Tag:** `<analog>`
- **Child Tag:** `<subsystem>`
    - `id`: Unique identifier.
    - `<uses>`: Component reference. `id` attribute.
    - `<probe>`: Measurement point.
        - `id`: Unique ID.
        - `net`: Net ID to monitor.
        - `quantity`: "voltage" or "current".

## 6. Firmware Block
Defines MCU logic and source integration.
- **Tag:** `<firmware>`
- **Child Tag:** `<project>`
    - `id`: Project ID.
    - `target`: ID of the MCU component.
    - `framework`: e.g., "arduino", "esp-idf".
    - `source_tree`: Path to C++ source directory (relative to workspace).
- **Child Tag:** `<binding>`: Maps physical hardware to logical signals.
- **Child Tag:** `<task>`: High-level periodic logic declarations.

## 7. Tests Block
Defines simulation scenarios.
- **Tag:** `<tests>`
- **Child Tag:** `<test>`
    - `id`: Unique identifier.
    - `<setup>`: Initial conditions. `<set_voltage net="..." value="..."/>`.
    - `<run>`: Duration. `<run duration="..."/>`.
    - `<assert_voltage>`: Validation rule. `net`, `min`, `max` attributes.

## 8. Simulation Profiles
Orchestrates backends and tests.
- **Tag:** `<simulation_profiles>`
- **Child Tag:** `<profile>`
    - `id`: Profile ID.
    - `default`: "true" or "false".
    - `<backend>`: `type` (e.g., "ngspice").
    - `<include>`: `subsystem` (ID of analog subsystem).
    - `<run>`: `test` (ID of test).
