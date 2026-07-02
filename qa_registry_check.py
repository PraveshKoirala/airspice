import requests
import json

def get_registry():
    url = "http://127.0.0.1:8000/agent/chat"
    payload = {"message": "list the registry parts"}
    try:
        response = requests.post(url, json=payload)
        response.raise_for_status()
        print(response.json().get("response", "No response content"))
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    get_registry()
