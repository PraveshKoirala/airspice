import pytest

@pytest.mark.skip
def test_a():
    assert True

@pytest.mark.skip(reason="flaky")
def test_b():
    assert True