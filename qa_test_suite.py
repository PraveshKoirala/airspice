import requests
import json
import re
import os
from pathlib import Path

BASE_URL = "http://127.0.0.1:8000"
QA_DIR = Path("generated/qa_batch")
QA_DIR.mkdir(parents=True, exist_ok=True)

def chat(message, history=None, provider="gemini"):
    url = f"{BASE_URL}/agent/chat"
    payload = {
        "message": message,
        "history": history or [],
        "provider": provider
    }
    response = requests.post(url, json=payload)
    response.raise_for_status()
    return response.json()

def check_design(design_path):
    url = f"{BASE_URL}/check"
    payload = {
        "design": str(design_path),
        "out_dir": str(design_path.parent / (design_path.stem + "_check"))
    }
    response = requests.post(url, json=payload)
    response.raise_for_status()
    return response.json()

def extract_xml(text):
    match = re.search(r'(<system.*?</system>)', text, re.DOTALL)
    if match:
        return match.group(1)
    return None

def run_test(i, requirement):
    print(f"--- Test {i}: {requirement} ---")
    
    # 1. Generate design
    prompt = f"Create a complete AIR XML design for: {requirement}. " \
             "Include all necessary components, nets, and at least one test/simulation probe. " \
             "Respond with the XML code block."
    
    chat_res = chat(prompt)
    response_text = chat_res.get("response", "")
    xml = extract_xml(response_text)
    
    if not xml:
        print(f"Failed to extract XML for design {i}")
        return {"status": "error", "error": "No XML found"}

    design_path = QA_DIR / f"design_{i}.air.xml"
    design_path.write_text(xml, encoding="utf-8")
    
    # 2. Check design
    check_res = check_design(design_path)
    success = check_res.get("success", False)
    
    result = {
        "requirement": requirement,
        "design_path": str(design_path),
        "success": success,
        "check_result": check_res
    }
    
    # 3. Fix if failed
    if not success:
        print(f"Design {i} failed validation. Requesting fix...")
        errors = json.dumps(check_res.get("errors", []) + check_res.get("diagnostics", []))
        fix_prompt = f"The design you generated has the following errors: {errors}. Please fix the AIR XML."
        
        fix_chat_res = chat(fix_prompt, history=chat_res.get("history", []))
        fix_text = fix_chat_res.get("response", "")
        fix_xml = extract_xml(fix_text)
        
        if fix_xml:
            design_path.write_text(fix_xml, encoding="utf-8")
            check_res = check_design(design_path)
            success = check_res.get("success", False)
            result["success"] = success
            result["check_result"] = check_res
            result["fixed"] = True
        else:
            print(f"Failed to extract fixed XML for design {i}")
            result["fixed"] = False

    return result

requirements = [
    "LED driver with PWM control using an N-MOSFET (BSS138) and a 5V source.",
    "Voltage divider with a 10k and 5k resistor, 12V input, and a probe on the output.",
    "Common Emitter Amplifier using a 2N2222 BJT, with appropriate biasing resistors.",
    "ESP32-C3 circuit with a 3.3V LDO (REG1117) and a decoupling capacitor.",
    "Battery voltage sensor for ESP32 using a voltage divider (100k/10k) from a 4.2V battery.",
    "Simple RC Low Pass Filter with 1k resistor and 100nF capacitor, with an AC simulation probe.",
    "Inverting Op-Amp amplifier using LM358 with a gain of -10 (1k and 10k resistors).",
    "Diode bridge rectifier using four 1N4148 diodes and a 10uF smoothing capacitor.",
    "MOSFET switch for a 12V motor (represented as a generic load) controlled by a 3.3V signal.",
    "ESP32-WROOM-32 minimal setup with a reset button (switch) and a power-on LED."
]

summary = []
for i, req in enumerate(requirements, 1):
    res = run_test(i, req)
    summary.append(res)

with open("generated/qa_batch/summary.json", "w") as f:
    json.dump(summary, f, indent=2)

print("\n=== QA Summary ===")
for i, s in enumerate(summary, 1):
    status = "PASSED" if s.get("success") else "FAILED"
    fixed = " (Fixed)" if s.get("fixed") else ""
    print(f"{i}. {s['requirement']}: {status}{fixed}")
