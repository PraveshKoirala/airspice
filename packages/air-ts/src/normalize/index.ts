/**
 * The normalize/ surface (issue #11 deliverable 2). The transformation port
 * itself lives in ../normalizer.ts (it landed with #7 because the parser builds
 * its model from the NORMALIZED clone -- see ../index.ts `parse`). This barrel
 * exposes it under the directory name the issue names, and adds the string-level
 * `normalize()` facade the agent layer (M3) and the UI's AI-apply path call.
 *
 * Transformation-branch inventory (enumerated here so the count is auditable
 * against normalizer.py; each references the Python source lines):
 *
 *   _coerce_structure (normalizer.py:18-32)
 *     T1  name -> id on nets/components/tests/profiles  (py:23-26)
 *     T2  unwrap a <pins> container into direct <pin>s   (py:27-32)
 *   _normalize_nets (normalizer.py:39-53)
 *     T3  default a net's `role` via _infer_net_role     (py:45)
 *     T4  net-owned <node component/pin> -> component-owned <pin> (py:46-53)
 *   _normalize_components (normalizer.py:62-97)
 *     T5  part="<known type>" -> type=..., drop part      (py:69-74)
 *     T6  pin name-case per component type (bjt/mosfet)   (py:76-78)
 *     T7  pin node=/ref= alias -> net=                    (py:79-82)
 *     T8  synthesize <value> from <parameter>s            (py:84-92)
 *     T9  bjt spice_model from a <parameter name="type">  (py:94-97)
 *   _normalize_simulation_profiles (normalizer.py:100-122)
 *     T10 <simulation_profile> tag -> <profile>           (py:107-108)
 *     T11 solver="X" attr -> <backend type="X"> child     (py:111-113)
 *     T12 default a missing <backend> to ngspice          (py:114-116)
 *     T13 default <run> children from the test ids        (py:117-119)
 *     T14 default <include> children from analog subsystems (py:120-122)
 *
 * FOURTEEN transformation branches. Helper functions (_infer_net_role,
 * _value_from_parameters, _parameter_value, _with_default_unit,
 * _normalize_pin_name, _known_component_types) are shared machinery those
 * branches call, not branches themselves. See ../normalizer.ts for the verbatim
 * port with per-branch // PARITY comments.
 */

export { normalizeTree, cloneElement } from "../normalizer.js";

import { parseXml } from "../xml.js";
import { canonicalizeTree } from "../canonicalizer.js";
import { normalizeTree } from "../normalizer.js";

/**
 * Normalize near-miss AI XML into the strict AIR shape and return the byte-exact
 * CANONICAL XML, mirroring the oracle's `save_design` path:
 * `canonicalize_tree(normalize_air_xml(xml))` (service.py:37,43).
 *
 * The normalizer runs on a clone (../normalizer.ts), then the canonicalizer runs
 * on THAT normalized tree (unlike the parse path, where canonicalize consumes the
 * RAW tree -- here the whole point is to persist the coerced shape). Parsing
 * failures (malformed XML, security-contract violations) propagate as the same
 * error types `parse`/`validate` raise.
 */
export function normalize(xmlText: string): string {
  const root = parseXml(xmlText);
  const normalized = normalizeTree(root);
  return canonicalizeTree(normalized);
}
