# AI Agent Spec v0.1

The AI integration is provider-based.

Implemented providers:

- `mock`: deterministic local repair provider backed by known repair recipes.
- `openai`: Responses API provider using structured JSON output.

CLI:

```powershell
python -m air.cli ai-repair examples/failing/bad_adc_divider.air.xml --provider mock --out generated/ai.patch.xml --apply-out generated/ai.fixed.air.xml --json
```

OpenAI provider:

```powershell
$env:OPENAI_API_KEY="..."
python -m air.cli ai-repair examples/failing/bad_adc_divider.air.xml --provider openai --model gpt-4.1 --out generated/openai.patch.xml --json
python -m air.cli patch-preview examples/failing/bad_adc_divider.air.xml generated/openai.patch.xml --json
```

The adapter uses the Responses API with JSON schema structured output. The model
returns a JSON object containing `patch_xml`, `reasoning_summary`, and
`expected_effect`; only `patch_xml` is written as the proposed patch.

The provider contract is represented by `AgentClient`:

```python
class AgentClient(Protocol):
    def propose_patch(self, context: dict[str, object]) -> str:
        ...
```

Patch application still goes through deterministic validation. A provider may
propose XML patches, but the backend applies them only after schema/semantic
validation succeeds.

Repair sessions:

```powershell
python -m air.cli repair-session-start examples/failing/bad_adc_divider.air.xml --provider mock --out-dir generated/repair_session --json
python -m air.cli repair-session-apply examples/failing/bad_adc_divider.air.xml generated/repair_session/proposed.patch.xml --out generated/repair_session.fixed.air.xml --json
```
