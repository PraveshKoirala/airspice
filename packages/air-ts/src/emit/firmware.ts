/**
 * Firmware codegen (port of `packages/core/src/air/firmware.py`).
 *
 * PURE functions: the oracle's `compile_firmware` writes a PlatformIO tree to
 * disk; this port returns the same file CONTENTS as strings so the browser UI
 * (zero-backend) can render/copy them. The Arduino C++ output (`_main_cpp`,
 * `_task_block`, `_pinmap`, platformio.ini, air_config.h) mirrors the oracle
 * line for line: same helper (`battery_raw_to_mv`), same setup/loop shape,
 * same macro naming (`AIR_<SIGNAL>_ADC_PIN`), same `sorted(task ids)` /
 * insertion-order semantics, same period->ms fallback (1000ms).
 *
 * One additive extension the oracle does not have: when the design's firmware
 * project declares `language="micropython"` (or "python"/"py"), a deterministic
 * MicroPython `main.py` is rendered from the SAME task IR (same op semantics,
 * same ordering) instead of the C++ tree.
 */

import type { FirmwareBinding, FirmwareTask, SystemIR } from "../model.js";
import { MCUS } from "../registry/index.js";

/** One generated firmware file (path is relative to the firmware root). */
export interface FirmwareFile {
  path: string;
  kind: "firmware_config" | "firmware_header" | "firmware_source";
  content: string;
}

export interface PlatformioSettings {
  platform: string;
  framework: string;
  board: string;
}

/**
 * Port of `firmware_platformio_settings`: resolve PlatformIO platform /
 * framework / board for the design's MCU, data-driven from the MCU registry's
 * `platformio` block. The registry board is authoritative for a known part;
 * the design's free-text <board> is the fallback, then the ESP32-C3 default.
 */
export function firmwarePlatformioSettings(ir: SystemIR): PlatformioSettings {
  const project = firstProject(ir);
  const mcu = [...ir.components.values()].find((c) => c.type === "mcu");
  const spec = mcu && mcu.part ? MCUS[mcu.part] : undefined;
  const pioRaw = spec ? spec["platformio"] : undefined;
  const pio: Record<string, string> = isStringRecord(pioRaw) ? pioRaw : {};
  const board =
    pio["board"] || (project && project.board ? project.board : "") || "esp32-c3-devkitm-1";
  return {
    platform: pio["platform"] || "espressif32",
    framework: pio["framework"] || "arduino",
    board,
  };
}

/**
 * Port of `compile_firmware`, minus the filesystem: returns the generated
 * file set. C++ (default): platformio.ini + include/air_pinmap.h +
 * include/air_config.h + src/main.cpp. MicroPython projects get src/main.py.
 */
export function emitFirmware(ir: SystemIR): FirmwareFile[] {
  const project = firstProject(ir);
  const language = (project?.language ?? "").trim().toLowerCase();
  if (language === "micropython" || language === "python" || language === "py") {
    return [{ path: "src/main.py", kind: "firmware_source", content: emitMainPy(ir) }];
  }

  const settings = firmwarePlatformioSettings(ir);
  const platformioIni =
    `[env:${settings.board}]\n` +
    `platform = ${settings.platform}\n` +
    `board = ${settings.board}\n` +
    `framework = ${settings.framework}\n` +
    `monitor_speed = 115200\n`;

  return [
    { path: "platformio.ini", kind: "firmware_config", content: platformioIni },
    { path: "include/air_pinmap.h", kind: "firmware_header", content: emitPinmapHeader(ir) },
    {
      path: "include/air_config.h",
      kind: "firmware_header",
      content: "#pragma once\n#define AIR_UART_BAUD 115200\n",
    },
    { path: "src/main.cpp", kind: "firmware_source", content: emitMainCpp(ir) },
  ];
}

/** Port of `_output_pin_numbers`: GPIO numbers driven by any write_gpio op. */
function outputPinNumbers(ir: SystemIR): string[] {
  const numbers: string[] = [];
  for (const task of ir.firmware_tasks.values()) {
    for (const operation of task.operations) {
      if (operation["op"] === "write_gpio") {
        const number = gpioNumber(operation["pin"] ?? "");
        if (number !== null && !numbers.includes(number)) numbers.push(number);
      }
    }
  }
  return numbers;
}

/** Port of `_main_cpp`. */
export function emitMainCpp(ir: SystemIR): string {
  const taskBlocks = sortedKeys(ir.firmware_tasks).map((taskId) => taskBlock(ir, taskId));
  let loopBody = taskBlocks.join("\n").trim();
  if (!loopBody) {
    loopBody = 'Serial.println("air_status=idle");\n  delay(1000);';
  }
  const setupLines = ["Serial.begin(AIR_UART_BAUD);"];
  for (const number of outputPinNumbers(ir)) {
    setupLines.push(`pinMode(${number}, OUTPUT);`);
  }
  const setupBody = setupLines.join("\n  ");
  return `#include <Arduino.h>
#include "air_pinmap.h"
#include "air_config.h"

static long battery_raw_to_mv(int raw) {
  return (long)raw * 3300L / 4095L;
}

void setup() {
  ${setupBody}
}

void loop() {
  ${loopBody}
}
`;
}

/** Port of `_task_block`. */
function taskBlock(ir: SystemIR, taskId: string): string {
  const task = ir.firmware_tasks.get(taskId) as FirmwareTask;
  const lines = [`// Task: ${task.id}`];
  const variables = new Set<string>();
  for (const operation of task.operations) {
    const op = operation["op"];
    if (op === "read_adc") {
      const bindingId = operation["binding"] ?? "";
      const into = operation["into"] || "adc_raw";
      const binding = ir.firmware_bindings.get(bindingId);
      const pinMacro = binding ? `AIR_${macro(binding.signal)}_ADC_PIN` : "A0";
      lines.push(`int ${into} = analogRead(${pinMacro});`);
      variables.add(into);
    } else if (op === "convert") {
      const into = operation["into"] || "converted";
      const expr = operation["expr"] ?? "";
      const source = extractFirstArg(expr) ?? firstOf(variables, "adc_raw");
      if (expr.includes("battery_raw_to_mv")) {
        lines.push(`long ${into} = battery_raw_to_mv(${source});`);
      } else {
        lines.push(`long ${into} = ${source};`);
      }
      variables.add(into);
    } else if (op === "write_gpio") {
      const number = gpioNumber(operation["pin"] ?? "");
      const level = operation["value"] === "high" ? "HIGH" : "LOW";
      if (number !== null) {
        lines.push(`digitalWrite(${number}, ${level});`);
      }
    } else if (op === "delay") {
      const duration = operation["duration"] ?? "";
      const milliseconds = duration ? periodToMs(duration) : 0;
      if (milliseconds) {
        lines.push(`delay(${milliseconds});`);
      }
    } else if (op === "log") {
      const value = operation["value"] ?? "";
      lines.push(`Serial.print("${value}=");`);
      lines.push(`Serial.println(${value});`);
    }
  }
  const delayMs = task.period ? periodToMs(task.period) : 1000;
  lines.push(`delay(${delayMs});`);
  return lines.join("\n  ");
}

/** Port of `_pinmap`. */
export function emitPinmapHeader(ir: SystemIR): string {
  const lines = ["#pragma once", ""];
  const bindings = [...ir.firmware_bindings.values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  for (const binding of bindings) {
    if (binding.channel.includes("ADC")) {
      lines.push(`#define AIR_${macro(binding.signal)}_ADC_CHANNEL ${binding.channel}`);
      const pinNumber = bindingPinNumber(ir, binding.component, binding.channel);
      if (pinNumber !== null) {
        lines.push(`#define AIR_${macro(binding.signal)}_ADC_PIN ${pinNumber}`);
      }
    }
  }
  for (const component of ir.components.values()) {
    if (component.type !== "mcu") continue;
    for (const pin of component.pins.values()) {
      const number = gpioNumber(pin.name);
      if (pin.function === "I2C_SDA" && number !== null) {
        lines.push(`#define AIR_I2C_SDA_PIN ${number}`);
      }
      if (pin.function === "I2C_SCL" && number !== null) {
        lines.push(`#define AIR_I2C_SCL_PIN ${number}`);
      }
    }
  }
  return lines.join("\n") + "\n";
}

// --------------------------------------------------------------------------- //
// MicroPython rendering (additive; same task IR, same op semantics/ordering). //
// --------------------------------------------------------------------------- //

/**
 * Deterministic MicroPython `main.py` from the declarative tasks. Shape
 * mirrors the C++ output: one commented block per task (sorted by id) inside
 * `while True:`, each ending in its period sleep; ADC/GPIO objects are
 * declared once at the top from the bindings/ops the tasks reference.
 */
export function emitMainPy(ir: SystemIR): string {
  const header = [
    "# Generated by AirSpice from the design's <firmware> tasks.",
    "from machine import ADC, Pin",
    "import time",
    "",
    "",
    "def battery_raw_to_mv(raw):",
    "    return raw * 3300 // 4095",
    "",
  ];

  // Declare one ADC object per binding referenced by a read_adc op, and one
  // output Pin per write_gpio target -- in first-use order.
  const adcDecls = new Map<string, string>(); // binding id -> variable name
  const pinDecls: string[] = []; // GPIO numbers
  for (const taskId of sortedKeys(ir.firmware_tasks)) {
    const task = ir.firmware_tasks.get(taskId) as FirmwareTask;
    for (const operation of task.operations) {
      if (operation["op"] === "read_adc") {
        const bindingId = operation["binding"] ?? "";
        if (bindingId && !adcDecls.has(bindingId)) {
          const binding = ir.firmware_bindings.get(bindingId);
          const name = binding && binding.signal ? `adc_${macro(binding.signal).toLowerCase()}` : "adc0";
          adcDecls.set(bindingId, name);
        }
      } else if (operation["op"] === "write_gpio") {
        const number = gpioNumber(operation["pin"] ?? "");
        if (number !== null && !pinDecls.includes(number)) pinDecls.push(number);
      }
    }
  }

  const decls: string[] = [];
  for (const [bindingId, name] of adcDecls) {
    const binding = ir.firmware_bindings.get(bindingId);
    const pinNumber = binding ? bindingPinNumber(ir, binding.component, binding.channel) : null;
    decls.push(pinNumber !== null ? `${name} = ADC(Pin(${pinNumber}))` : `${name} = ADC(0)`);
  }
  for (const number of pinDecls) {
    decls.push(`pin_${number} = Pin(${number}, Pin.OUT)`);
  }

  const body: string[] = ["while True:"];
  let emitted = 0;
  for (const taskId of sortedKeys(ir.firmware_tasks)) {
    const task = ir.firmware_tasks.get(taskId) as FirmwareTask;
    body.push(`    # Task: ${task.id}`);
    const variables = new Set<string>();
    for (const operation of task.operations) {
      const op = operation["op"];
      if (op === "read_adc") {
        const into = operation["into"] || "adc_raw";
        const name = adcDecls.get(operation["binding"] ?? "") ?? "adc0";
        body.push(`    ${into} = ${name}.read()`);
        variables.add(into);
      } else if (op === "convert") {
        const into = operation["into"] || "converted";
        const expr = operation["expr"] ?? "";
        const source = extractFirstArg(expr) ?? firstOf(variables, "adc_raw");
        if (expr.includes("battery_raw_to_mv")) {
          body.push(`    ${into} = battery_raw_to_mv(${source})`);
        } else {
          body.push(`    ${into} = ${source}`);
        }
        variables.add(into);
      } else if (op === "write_gpio") {
        const number = gpioNumber(operation["pin"] ?? "");
        const level = operation["value"] === "high" ? "1" : "0";
        if (number !== null) body.push(`    pin_${number}.value(${level})`);
      } else if (op === "delay") {
        const duration = operation["duration"] ?? "";
        const milliseconds = duration ? periodToMs(duration) : 0;
        if (milliseconds) body.push(`    time.sleep_ms(${milliseconds})`);
      } else if (op === "log") {
        const value = operation["value"] ?? "";
        body.push(`    print("${value}=", ${value})`);
      }
    }
    const delayMs = task.period ? periodToMs(task.period) : 1000;
    body.push(`    time.sleep_ms(${delayMs})`);
    emitted += 1;
  }
  if (emitted === 0) {
    body.push('    print("air_status=idle")');
    body.push("    time.sleep_ms(1000)");
  }

  const parts = [...header];
  if (decls.length > 0) parts.push(...decls, "");
  parts.push(...body);
  return parts.join("\n") + "\n";
}

// --------------------------------------------------------------------------- //
// Helpers (ports of firmware.py's module helpers).                            //
// --------------------------------------------------------------------------- //

function firstProject(ir: SystemIR) {
  for (const project of ir.firmware_projects.values()) return project;
  return null;
}

/** Python `next(iter(set), default)`: first inserted member, or the default. */
function firstOf(values: Set<string>, fallback: string): string {
  for (const value of values) return value;
  return fallback;
}

/** Narrow the registry's open-index `platformio` block to {string: string}. */
function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((v) => typeof v === "string");
}

/** Python `sorted(dict)` over string keys: code-point order. */
function sortedKeys(map: Map<string, unknown>): string[] {
  return [...map.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Port of `_macro`: upper-case, squash non-alphanumerics to `_`, strip. */
export function macro(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Port of `_gpio_number`: "GPIO4" -> "4", anything else -> null. */
export function gpioNumber(pin: string): string | null {
  const match = /^GPIO(\d+)$/.exec(pin);
  return match ? (match[1] as string) : null;
}

/** Port of `_binding_pin_number`: the MCU pin whose `function` is the channel. */
export function bindingPinNumber(
  ir: SystemIR,
  componentId: string,
  channel: string,
): string | null {
  const component = ir.components.get(componentId);
  if (!component) return null;
  for (const pin of component.pins.values()) {
    if (pin.function === channel) return gpioNumber(pin.name);
  }
  return null;
}

/** Port of `_extract_first_arg`: text inside the first (...) group. */
export function extractFirstArg(expr: string): string | null {
  const match = /\(([^)]+)\)/.exec(expr);
  return match ? (match[1] as string).trim() : null;
}

/** Port of `_period_to_ms`: "60s" -> 60000, "250ms" -> 250, no match -> 1000. */
export function periodToMs(period: string): number {
  const match = /^(\d+)(ms|s)?$/.exec(period.trim());
  if (!match) return 1000;
  const value = parseInt(match[1] as string, 10);
  const unit = match[2] ?? "ms";
  return unit === "s" ? value * 1000 : value;
}

/** Resolved binding view (used by the UI's Firmware panel). */
export interface ResolvedBinding extends FirmwareBinding {
  /** The MCU pin name whose `function` matches the channel (e.g. "GPIO4"). */
  pinName: string | null;
}

/** Bindings with their MCU pin resolved (presentation helper, insertion order). */
export function resolveBindings(ir: SystemIR): ResolvedBinding[] {
  const out: ResolvedBinding[] = [];
  for (const binding of ir.firmware_bindings.values()) {
    let pinName: string | null = null;
    const component = ir.components.get(binding.component);
    if (component) {
      for (const pin of component.pins.values()) {
        if (pin.function === binding.channel) {
          pinName = pin.name;
          break;
        }
      }
    }
    out.push({ ...binding, pinName });
  }
  return out;
}
