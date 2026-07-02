import os
import requests
import json
from pathlib import Path

API_BASE = "http://127.0.0.1:8000"

def run_suite():
    suite_dir = Path("tests/capability_suite")
    designs = list(suite_dir.glob("*.air.xml"))
    
    print(f"--- Running Capability Test Suite ({len(designs)} designs) ---")
    
    results = []
    for design in designs:
        print(f"\nTesting: {design.name}")
        
        # 1. Validate
        resp = requests.post(f"{API_BASE}/validate", json={"design": str(design)})
        valid = resp.json()
        
        # 2. Simulate (Mixed-Signal)
        resp = requests.post(f"{API_BASE}/mixed-signal-check", json={"design": str(design), "out_dir": f"generated/test_suite/{design.stem}"})
        sim = resp.json()
        
        results.append({
            "design": design.name,
            "validated": valid.get("status") == "success" or not valid.get("errors"),
            "simulated": sim.get("success", False),
            "diagnostics": valid.get("errors", []) + sim.get("diagnostics", [])
        })
        
        status = "PASSED" if results[-1]["validated"] and results[-1]["simulated"] else "FAILED"
        print(f"Status: {status}")

    with open("generated/test_suite/summary.json", "w") as f:
        json.dump(results, f, indent=2)

    print("\n=== Suite Summary ===")
    for r in results:
        print(f"{r['design']}: {'PASS' if r['validated'] and r['simulated'] else 'FAIL'}")

if __name__ == "__main__":
    os.makedirs("generated/test_suite", exist_ok=True)
    run_suite()
