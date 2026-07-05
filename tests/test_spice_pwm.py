"""Firmware -> SPICE PWM duty-cycle emission (issue #59).

The oracle used to map the firmware ON-time straight onto the SPICE ``PULSE``
plateau width ``PW`` while adding fixed 1 us rise/fall edges. Because a PULSE is a
trapezoid whose high-area is ``PW + (TR+TF)/2``, that made the *effective* duty
``ton/period + 1us/period`` -- a 50 %-intended 100 kHz PWM averaged to 60 %
(1.98 V instead of 1.65 V across the ground-truth RC filter).

The fix (``air.spice._pwm_pulse``) compensates the ramp area so the emitted
trapezoid's true high-area equals ``ton`` and the effective duty is exactly
``ton/period``. These tests assert the emitted netlist parameters directly (no
ngspice needed) for 50 %, a small sub-edge duty, 0 %/100 %, and several
frequencies, and check the compensated trapezoid's analytic average lands where
physics wants it.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages" / "core" / "src"))

import pytest  # noqa: E402

from air.parser import parse_string  # noqa: E402
from air.spice import PWM_EDGE_S, _mcu_stimulus_lines, _pwm_pulse  # noqa: E402
from air.units import parse_quantity  # noqa: E402


def _pulse_fields(card: str) -> list[str]:
    """Split ``PULSE(V1 V2 TD TR TF PW PER)`` into its 7 numeric field strings."""
    assert card.startswith("PULSE("), f"not a PULSE card: {card!r}"
    inner = card[len("PULSE(") : card.rindex(")")]
    fields = inner.split()
    assert len(fields) == 7, f"expected 7 PULSE fields, got {fields}"
    return fields


def _trapezoid_avg(card: str) -> float:
    """Analytic one-period time-average of a ``PULSE(0 A 0 TR TF PW PER)`` card.

    V_avg = A * (PW + (TR+TF)/2) / PER -- the same trapezoid area the RC filter
    settles to. For a ``DC v`` card the average is just v.
    """
    if card.startswith("DC "):
        return float(card.split()[1])
    _v1, v2, _td, tr, tf, pw, per = _pulse_fields(card)
    a = float(v2)
    tr_s = parse_quantity(tr, "s")
    tf_s = parse_quantity(tf, "s")
    pw_s = parse_quantity(pw, "s")
    per_s = parse_quantity(per, "s")
    return a * (pw_s + (tr_s + tf_s) / 2.0) / per_s


def _effective_duty(card: str, period: str, amplitude: float = 3.3) -> float:
    return _trapezoid_avg(card) / amplitude


# ---------------------------------------------------------------------------
# _pwm_pulse: emitted-parameter assertions
# ---------------------------------------------------------------------------

class TestPwmPulseEmission:
    def test_50pct_duty_compensates_edges(self) -> None:
        # Ground-truth pwm_rc_average case: 5 us on / 10 us period @ 3.3 V.
        card = _pwm_pulse("5us", "10us")
        v1, v2, td, tr, tf, pw, per = _pulse_fields(card)
        assert (v1, v2, td) == ("0", "3.3", "0")
        # PW = ton - (TR+TF)/2 = 5us - 1us = 4us, NOT the old (buggy) 5us.
        assert parse_quantity(pw, "s") == pytest.approx(4e-6)
        assert parse_quantity(tr, "s") == pytest.approx(PWM_EDGE_S)
        assert parse_quantity(tf, "s") == pytest.approx(PWM_EDGE_S)
        assert parse_quantity(per, "s") == pytest.approx(10e-6)
        # Effective duty and average land on the physics target, not 60 %.
        assert _effective_duty(card, "10us") == pytest.approx(0.5, abs=1e-9)
        assert _trapezoid_avg(card) == pytest.approx(1.650, abs=1e-6)

    def test_50pct_duty_low_frequency(self) -> None:
        # Corpus mixed_signal_switch case: 5 ms on / 10 ms period.
        card = _pwm_pulse("5ms", "10ms")
        _, _, _, _, _, pw, _ = _pulse_fields(card)
        assert parse_quantity(pw, "s") == pytest.approx(4.999e-3)
        assert _effective_duty(card, "10ms") == pytest.approx(0.5, abs=1e-9)

    @pytest.mark.parametrize(
        "ton,period,duty",
        [
            ("2us", "10us", 0.2),
            ("9us", "10us", 0.9),
            ("25us", "100us", 0.25),   # 10 kHz
            ("500us", "1ms", 0.5),     # 1 kHz
            ("300ns", "1us", 0.3),     # 1 MHz, sub-edge regime
        ],
    )
    def test_effective_duty_matches_intended(self, ton: str, period: str, duty: float) -> None:
        card = _pwm_pulse(ton, period)
        assert _effective_duty(card, period) == pytest.approx(duty, abs=1e-9)

    def test_small_duty_near_edge_floor_uses_triangle(self) -> None:
        # ton (500 ns) < the 1 us edge: fixed 1 us edges cannot represent this
        # duty, so the plateau collapses (PW=0) and the edges shrink to ton so the
        # triangle area (TR+TF)/2 == ton preserves the duty. PW must stay valid.
        card = _pwm_pulse("500ns", "10us")
        _, _, _, tr, tf, pw, _ = _pulse_fields(card)
        assert parse_quantity(pw, "s") == pytest.approx(0.0)
        assert parse_quantity(tr, "s") == pytest.approx(500e-9)
        assert parse_quantity(tf, "s") == pytest.approx(500e-9)
        assert _effective_duty(card, "10us") == pytest.approx(0.05, abs=1e-9)

    def test_edge_floor_exact(self) -> None:
        # ton exactly one edge (1 us): triangle with PW=0, area = 1us -> 10 %.
        card = _pwm_pulse("1us", "10us")
        _, _, _, _, _, pw, _ = _pulse_fields(card)
        assert parse_quantity(pw, "s") == pytest.approx(0.0)
        assert _effective_duty(card, "10us") == pytest.approx(0.1, abs=1e-9)

    def test_zero_duty_is_dc_low(self) -> None:
        assert _pwm_pulse("0us", "10us") == "DC 0"

    def test_full_duty_is_dc_high(self) -> None:
        assert _pwm_pulse("10us", "10us") == "DC 3.3"
        # ton beyond the period is still a constant rail (>=100 %).
        assert _pwm_pulse("20us", "10us") == "DC 3.3"

    def test_never_emits_nonpositive_plateau(self) -> None:
        # Across a sweep no emitted PULSE may carry PW < 0 (ngspice would choke).
        for ton, period in [
            ("100ns", "1us"), ("500ns", "1us"), ("1us", "1us"),
            ("250ns", "10us"), ("5us", "10us"), ("9us", "10us"),
            ("1s", "2s"),
        ]:
            card = _pwm_pulse(ton, period)
            if card.startswith("PULSE("):
                _, _, _, _, _, pw, _ = _pulse_fields(card)
                assert parse_quantity(pw, "s") >= 0.0, f"{ton}/{period} -> {card}"


# ---------------------------------------------------------------------------
# End-to-end through the IR: _mcu_stimulus_lines emits the compensated card.
# ---------------------------------------------------------------------------

_PWM_DESIGN = """
<system name="pwm_emit" ir_version="0.1">
  <nets>
    <net id="gnd" role="ground"/>
    <net id="pwm" role="digital_signal"/>
  </nets>
  <components>
    <component id="U_MCU" type="mcu" part="ESP32-C3">
      <pin name="GND" net="gnd"/>
      <pin name="GPIO2" net="pwm" function="GPIO_OUT"/>
    </component>
  </components>
  <firmware>
    <project id="fw" target="U_MCU" framework="platformio" language="cpp">
      <board>esp32-c3-devkitm-1</board>
    </project>
    <task id="t" target="fw">
      <period>10us</period>
      <write_gpio pin="GPIO2" value="high"/>
      <delay duration="5us"/>
      <write_gpio pin="GPIO2" value="low"/>
    </task>
  </firmware>
</system>
"""


class TestMcuStimulusIntegration:
    def test_stimulus_line_uses_compensated_pulse(self) -> None:
        ir, _ = parse_string(_PWM_DESIGN)
        lines = _mcu_stimulus_lines(ir)
        stim = [ln for ln in lines if ln.startswith("V_STIM_")]
        assert len(stim) == 1, lines
        line = stim[0]
        assert line.startswith("V_STIM_U_MCU_GPIO2 pwm 0 PULSE(")
        card = line.split(" ", 3)[3]
        # 50 % intended -> compensated 4 us plateau, 50 % effective.
        assert _effective_duty(card, "10us") == pytest.approx(0.5, abs=1e-9)
        # Regression guard: the buggy 60 % duty (1.98 V) must NOT be emitted.
        assert _trapezoid_avg(card) == pytest.approx(1.650, abs=1e-6)
        assert _trapezoid_avg(card) != pytest.approx(1.980, abs=1e-3)
