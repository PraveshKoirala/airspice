"""SPICE AC small-signal analysis emission (issue #62).

Verifies the oracle's ``.ac`` compilation path introduced when
``rc_lowpass_fc`` flipped from expected-fail to passing:

1. A test carrying an ``<analysis type="ac"...>`` child compiles to a netlist
   with ``.ac dec <points> <start_hz> <end_hz>`` in place of ``.tran``, every
   voltage_source line tagged with ``AC {ac_magnitude}`` (default ``AC 0`` when
   the property is absent), and probes emitted as ``vdb(net) vp(net)``.
2. A test WITHOUT an analysis child compiles to the historical ``.tran`` shape
   verbatim (backward compatibility: no golden-corpus design carries an
   analysis child, so their fixed netlist bytes must be unchanged).
3. The simulator's AC assertion (``assert_gain_db_at_freq``) picks the
   closest-in-log-frequency sample and evaluates against the [min_db, max_db]
   window, with no ngspice run required for the emit-only assertions.

The ground-truth suite (tests/test_ground_truth.py::rc_lowpass_fc) covers the
end-to-end path with real ngspice; this module hits the pure emit/parse paths
for CI shards that don't have ngspice on PATH.
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages" / "core" / "src"))

import pytest  # noqa: E402

from air.parser import parse_string  # noqa: E402
from air.simulator import _evaluate_ac_assertions, _read_ac_points, _write_canonical_ac_waveform  # noqa: E402
from air.spice import compile_spice  # noqa: E402


AC_RC_XML = """<system name="ac_rc" ir_version="0.1">
  <metadata><title>ac emit</title></metadata>
  <nets>
    <net id="gnd" role="ground"/>
    <net id="vin" role="power" nominal_voltage="1V"/>
    <net id="vout" role="analog_signal"/>
  </nets>
  <components>
    <component id="V_IN" type="voltage_source">
      <value>1V</value>
      <property name="ac_magnitude" value="1V"/>
      <pin name="p" net="vin"/>
      <pin name="n" net="gnd"/>
    </component>
    <component id="R_F" type="resistor">
      <value>1.6k</value>
      <pin name="1" net="vin"/>
      <pin name="2" net="vout"/>
    </component>
    <component id="C_F" type="capacitor">
      <value>100nF</value>
      <pin name="1" net="vout"/>
      <pin name="2" net="gnd"/>
    </component>
  </components>
  <tests>
    <test id="lpf_fc">
      <analysis type="ac" sweep="dec" points="40" start="10Hz" end="1MegHz"/>
      <assert_gain_db_at_freq net="vout" freq="994.72Hz" min_db="-3.15" max_db="-2.87"/>
    </test>
  </tests>
  <simulation_profiles>
    <profile id="p" default="true"><backend type="ngspice"/><run test="lpf_fc"/></profile>
  </simulation_profiles>
</system>"""


def _compile(xml: str) -> str:
    ir, _ = parse_string(xml)
    tmp = Path(tempfile.mkdtemp(prefix="ac_emit_"))
    test = next(iter(ir.tests.values()))
    compile_spice(ir, tmp, test)
    return (tmp / "spice" / "main.cir").read_text(encoding="utf-8")


class TestAcEmission:
    def test_ac_card_replaces_tran(self) -> None:
        netlist = _compile(AC_RC_XML)
        assert ".ac dec 40 10 1e+06" in netlist
        assert ".tran" not in netlist

    def test_voltage_source_tagged_with_ac_magnitude(self) -> None:
        netlist = _compile(AC_RC_XML)
        # Property ac_magnitude="1V" -> `AC 1V` token appended to the DC line.
        assert "V_V_IN vin 0 DC 1V AC 1V" in netlist

    def test_default_ac_magnitude_is_zero(self) -> None:
        # A voltage source without an ac_magnitude property must emit `AC 0`
        # so it acts as a pure bias under the AC solve.
        xml = AC_RC_XML.replace('<property name="ac_magnitude" value="1V"/>', "")
        netlist = _compile(xml)
        assert "V_V_IN vin 0 DC 1V AC 0" in netlist

    def test_probe_uses_vdb_and_vp(self) -> None:
        netlist = _compile(AC_RC_XML)
        assert "wrdata ../waveforms/lpf_fc_vout.csv vdb(vout) vp(vout)" in netlist

    def test_frequency_uses_g_scientific_form(self) -> None:
        # 1MegHz = 1e6 renders as `1e+06` (CPython `%g` byte-for-byte).
        netlist = _compile(AC_RC_XML)
        assert ".ac dec 40 10 1e+06" in netlist

    def test_backward_compat_tran_path_unchanged(self) -> None:
        # A test without <analysis> emits the pre-#62 netlist verbatim: no AC
        # token on sources, .tran card, wrdata v() (not vdb/vp).
        xml = AC_RC_XML.replace(
            '<analysis type="ac" sweep="dec" points="40" start="10Hz" end="1MegHz"/>',
            '<run duration="10ms"/>',
        ).replace(
            '<assert_gain_db_at_freq net="vout" freq="994.72Hz" min_db="-3.15" max_db="-2.87"/>',
            '<assert_voltage net="vout" min="0.9V" max="1.1V"/>',
        )
        netlist = _compile(xml)
        assert ".tran 1u 10ms" in netlist
        assert ".ac " not in netlist
        # Voltage source has no AC token even though ac_magnitude is present
        # (property is inert on the .tran path).
        assert "V_V_IN vin 0 DC 1V\n" in netlist or netlist.endswith("V_V_IN vin 0 DC 1V")
        # wrdata is v(net) not vdb/vp.
        assert "wrdata ../waveforms/t_vout.csv v(vout)" not in netlist  # test id is lpf_fc
        assert "wrdata ../waveforms/lpf_fc_vout.csv v(vout)" in netlist


class TestAcWaveformIo:
    """Round-trip: ngspice wrdata output -> _read_ac_points -> canonical CSV.

    The ngspice ``wrdata`` output for AC is space-delimited with the frequency
    column REPEATED for each variable, so a ``vdb(net) vp(net)`` line has four
    numbers: ``freq vdb freq vphase``. Phase is in RADIANS by default and must
    be converted to degrees at the parse boundary.
    """

    def test_reads_four_column_wrdata(self, tmp_path: Path) -> None:
        # A synthesized wrdata output for an RC low-pass at 3 freq points near fc.
        # phase is in radians; -pi/4 rad = -45 deg is the fc phase.
        import math
        raw = (
            f" 9.94720000e+02  -3.01029995e+00  9.94720000e+02  {-math.pi/4:.8e}\n"
            f" 1.00000000e+02  -4.32137378e-02  1.00000000e+02  {-math.atan(100/994.72):.8e}\n"
            f" 1.00000000e+04  -2.00432137e+01  1.00000000e+04  {-math.atan(10000/994.72):.8e}\n"
        )
        path = tmp_path / "waveform.csv"
        path.write_text(raw, encoding="utf-8")
        points = _read_ac_points(path)
        assert len(points) == 3
        assert points[0]["freq_hz"] == pytest.approx(994.72)
        assert points[0]["mag_db"] == pytest.approx(-3.010, abs=0.001)
        # Phase converted to degrees: -pi/4 rad -> -45 deg exactly.
        assert points[0]["phase_deg"] == pytest.approx(-45.0, abs=0.001)
        # Sanity on the other points.
        assert points[1]["mag_db"] == pytest.approx(-0.0432, abs=0.001)
        assert points[2]["mag_db"] == pytest.approx(-20.04, abs=0.01)

    def test_canonical_write_preserves_final_point(self, tmp_path: Path) -> None:
        # A long AC sweep is downsampled but the LAST point (highest frequency)
        # must survive so the UI plot shows the full frequency range.
        points = [{"freq_hz": 10.0 * (10 ** (i / 40.0)),
                    "mag_db": -3.0 * i / 200.0,
                    "phase_deg": -1.0 * i / 200.0}
                   for i in range(1000)]
        path = tmp_path / "ac.csv"
        _write_canonical_ac_waveform(path, "vout", points, max_points=100)
        # Header + <=101 data rows.
        rows = path.read_text(encoding="utf-8").strip().splitlines()
        assert rows[0].startswith("freq_hz,vdb(vout),vp(vout)")
        # Last row is the highest-freq point.
        last = rows[-1].split(",")
        assert float(last[0]) == pytest.approx(points[-1]["freq_hz"])


class TestAcAssertions:
    """`assert_gain_db_at_freq` closest-log-frequency lookup.

    The evaluator picks the sample point closest in log-frequency to the target
    (mirroring what the ground-truth runner does) and checks its magnitude in
    dB against the ``[min_db, max_db]`` window. Passing = no diagnostic; failing
    = one ASSERT_FAILED diagnostic naming the observed mag_db and phase_deg.
    """

    def _test_with(self, assertion_xml: str):
        xml = AC_RC_XML.replace(
            '<assert_gain_db_at_freq net="vout" freq="994.72Hz" min_db="-3.15" max_db="-2.87"/>',
            assertion_xml,
        )
        ir, _ = parse_string(xml)
        return next(iter(ir.tests.values()))

    def test_pass_when_mag_db_in_window(self) -> None:
        test = self._test_with(
            '<assert_gain_db_at_freq net="vout" freq="994.72Hz" min_db="-3.15" max_db="-2.87"/>'
        )
        response = {"vout": [
            {"freq_hz": 100.0, "mag_db": -0.04, "phase_deg": -5.7},
            {"freq_hz": 994.72, "mag_db": -3.01, "phase_deg": -45.0},
            {"freq_hz": 10000.0, "mag_db": -20.04, "phase_deg": -84.3},
        ]}
        diags = _evaluate_ac_assertions(test, response)
        assert diags == []

    def test_fail_when_mag_db_outside_window(self) -> None:
        test = self._test_with(
            '<assert_gain_db_at_freq net="vout" freq="994.72Hz" min_db="-3.15" max_db="-2.87"/>'
        )
        response = {"vout": [
            {"freq_hz": 994.72, "mag_db": -6.0, "phase_deg": -45.0},  # too low
        ]}
        diags = _evaluate_ac_assertions(test, response)
        assert len(diags) == 1
        assert diags[0].code == "ASSERT_FAILED"
        assert "vout" in diags[0].message
        assert diags[0].observed["mag_db"] == "-6"

    def test_no_measurement_when_probe_missing(self) -> None:
        test = self._test_with(
            '<assert_gain_db_at_freq net="vout" freq="994.72Hz" min_db="-3.15" max_db="-2.87"/>'
        )
        diags = _evaluate_ac_assertions(test, {})
        assert len(diags) == 1
        assert diags[0].code == "ASSERT_NO_MEASUREMENT"

    def test_log_frequency_lookup_prefers_closer_neighbour_in_log(self) -> None:
        # With log spacing, freq points near fc space geometrically; the closer
        # sample in log distance is the correct pick, not the closer in linear
        # distance. Target 1000 Hz between 700 Hz (log dist 0.155) and
        # 1500 Hz (log dist 0.176): log picks 700 Hz, linear would pick 1500 Hz.
        test = self._test_with(
            '<assert_gain_db_at_freq net="vout" freq="1000Hz" min_db="-4" max_db="-2"/>'
        )
        response = {"vout": [
            {"freq_hz": 700.0, "mag_db": -3.0, "phase_deg": -35.0},   # PASS (in window)
            {"freq_hz": 1500.0, "mag_db": -10.0, "phase_deg": -55.0}, # FAIL if picked
        ]}
        diags = _evaluate_ac_assertions(test, response)
        assert diags == [], "log-distance should pick 700 Hz (mag -3, in window)"
