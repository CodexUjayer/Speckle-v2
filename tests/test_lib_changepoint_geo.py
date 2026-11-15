"""engine.lib.changepoint (CUSUM kernels) and engine.lib.geo UTM <-> lon/lat (pinned against the chain's own copy)."""
import numpy as np
import pytest

from engine.common import _geo as chain_geo
from engine.lib import geo
from engine.lib.changepoint import first_true_from, page_cusum, persistence


def test_cusum_alarm_and_onset_on_a_clean_step():
    z = np.zeros((10, 2))
    z[5:, 0] = -3.0
    z[6:, 1] = -3.0
    r = page_cusum(z, k=0.5, h=4.0, direction="down")
    assert r["alarm"].tolist() == [6, 7] and r["onset"].tolist() == [5, 6]


def test_cusum_up_is_the_mirror_of_down():
    z = np.zeros((8, 1))
    z[4:] = 3.0
    assert page_cusum(z, direction="up")["alarm"][0] == page_cusum(-z, direction="down")["alarm"][0]


def test_cusum_ignores_noise_inside_the_allowance_and_missing_epochs_carry_state():
    rng = np.random.default_rng(1)
    z = rng.normal(0, 0.3, (50, 400))
    assert (page_cusum(z, k=0.5, h=4.0)["alarm"] < 0).all()
    z = np.zeros((8, 1)); z[3:] = -2.0; z[4] = np.nan                      # a gap must neither reset nor accumulate
    assert page_cusum(z, k=0.5, h=4.0)["onset"][0] == 3
    with pytest.raises(ValueError):
        page_cusum(z, direction="sideways")


def test_first_true_from_and_persistence_treat_unusable_epochs_as_neutral():
    shifted = np.array([[0], [1], [0], [1], [1]], bool)
    usable = np.array([[1], [1], [0], [1], [1]], bool)                    # epoch 2 is rain-flagged: neither adds nor breaks
    onset = first_true_from(shifted & usable, np.array([0]))
    assert onset.tolist() == [1]
    p = persistence(shifted, usable, onset)
    assert p["count"][0] == 3 and not p["broken"][0] and p["n_usable_after"][0] == 3
    shifted[3, 0] = False
    assert persistence(shifted, usable, onset)["broken"][0]


def test_utm_roundtrip_and_agreement_with_the_chain_projection():
    x, y = np.array([500000.0, 312345.0, 687000.0]), np.array([3760000.0, 3801234.0, 3790000.0])
    lon, lat = geo.utm_to_lonlat(x, y, 32611)
    ref = chain_geo.utm_to_lonlat(x, y, 11, True)
    assert np.abs(lon - ref[0]).max() < 1e-9 and np.abs(lat - ref[1]).max() < 1e-9
    xb, yb = geo.lonlat_to_utm(lon, lat, 32611)
    assert np.abs(xb - x).max() < 1e-4 and np.abs(yb - y).max() < 1e-4
    lon_s, lat_s = geo.utm_to_lonlat(np.array([300000.0]), np.array([7000000.0]), 32711)   # southern hemisphere
    assert lat_s[0] < 0 and abs(geo.lonlat_to_utm(lon_s, lat_s, 32711)[1][0] - 7000000.0) < 1e-4
    with pytest.raises(ValueError):
        geo.utm_to_lonlat(x, y, 4326)
