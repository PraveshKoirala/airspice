import os
import sys

def check_gemini():
    print("--- Gemini API Connectivity Check ---")
    
    # 1. Check for SDK
    try:
        import google.generativeai as genai
        print("✅ google-generativeai SDK is installed.")
    except ImportError:
        print("❌ SDK not found. Install with: pip install google-generativeai")
        return

    # 2. Check for API Key
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        print("❌ GEMINI_API_KEY environment variable is NOT set.")
        print("   Get one at: https://aistudio.google.com/app/apikey")
        return
    else:
        print(f"✅ GEMINI_API_KEY found (starts with: {api_key[:4]}...)")

    # 3. Attempt a simple call
    try:
        genai.configure(api_key=api_key)
        # Using Gemini 3.5 Flash for a quick, cheap check
        model = genai.GenerativeModel('gemini-3.5-flash')
        print("📡 Attempting connection to Google AI services (Gemini 3.5 Flash)...")
        response = model.generate_content("Say 'Gemini is online!'")
        
        if response and response.text:
            print(f"✨ Success! Response: {response.text.strip()}")
            print("✅ Your Gemini integration is fully functional.")
        else:
            print("⚠️ Received an empty response from Gemini.")
            
    except Exception as e:
        print(f"❌ API Call Failed: {str(e)}")
        if "API_KEY_INVALID" in str(e):
            print("   Tip: Your API key appears to be invalid.")
        elif "quota" in str(e).lower():
            print("   Tip: You might have exceeded your API quota.")

if __name__ == "__main__":
    check_gemini()
