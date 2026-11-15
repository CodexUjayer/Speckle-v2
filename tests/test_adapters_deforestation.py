"""R4 / R6 / R7 / R10 / S4 reference adapters: documented-shape payloads parse; every failure is a DEGRADED RESULT, never an exception.

These tests do not touch the network. The live paths were not exercised where the adapters were written; what is pinned here is
the request construction, the parsers and the failure behaviour."""
import io
import json
import urllib.error
from datetime import datetime, timezone

import pytest

from engine.retrieval.clients.adapters import _http, r4_imerg, r6_firms, r7_gfw_alerts, r10_ibtracs, s4_tree_loss


class _Resp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


@pytest.fixture()
def net(monkeypatch, tmp_path):
    monkeypatch.setenv("NISAR_DATA_DIR", str(tmp_path))
    calls = []

    def install(handler):
        def fake(req, timeout=None):
            calls.append(req)
            out = handler(req)
            if isinstance(out, Exception):
                raise out
            return _Resp(out if isinstance(out, bytes) else out.encode())
        monkeypatch.setattr(_http, "_urlopen", fake)
        return calls
    return install


GFW_OK = {"status": "success", "data": [
    {"longitude": 10.5, "latitude": -3.2, "gfw_integrated_alerts__date": "2026-09-05", "gfw_integrated_alerts__intensity": 4, "gfw_integrated_alerts__confidence": "high"},
    {"longitude": 10.51, "latitude": -3.21, "gfw_integrated_alerts__date": "2026-09-06", "gfw_integrated_alerts__intensity": 1, "gfw_integrated_alerts__confidence": "nominal"},
    {"longitude": None, "latitude": -3.0, "gfw_integrated_alerts__date": "2026-09-06"}]}


def test_r7_parses_and_builds_the_documented_request(net, monkeypatch):
    monkeypatch.setenv("GFW_API_KEY", "k")
    calls = net(lambda req: json.dumps(GFW_OK))
    out = r7_gfw_alerts.fetch_alerts((10.4, -3.3, 10.6, -3.1), "2026-08-01T00:00:00Z", "2026-10-01T00:00:00Z")
    assert not out["degraded"] and len(out["alerts"]) == 2 and out["alerts"][0]["rank"] == 2 and out["provenance"]["sha256"]
    req = calls[0]
    body = json.loads(req.data)
    assert req.get_method() == "POST" and req.headers["X-api-key"] == "k" and body["geometry"]["type"] == "Polygon"
    assert "gfw_integrated_alerts__date >= '2026-08-01'" in body["sql"] and "FROM results" in body["sql"]


def test_r7_retries_the_other_table_name_on_400_and_degrades_without_a_key_or_on_errors(net, monkeypatch):
    monkeypatch.setenv("GFW_API_KEY", "k")
    seen = []

    def h(req):
        seen.append(json.loads(req.data)["sql"])
        return urllib.error.HTTPError(req.full_url, 400, "bad", {}, None) if "FROM results" in seen[-1] else json.dumps(GFW_OK)
    net(h)
    out = r7_gfw_alerts.fetch_alerts((1, 1, 2, 2), "2026-01-01", "2026-02-01")
    assert not out["degraded"] and "FROM data" in seen[-1]
    monkeypatch.delenv("GFW_API_KEY")
    d = r7_gfw_alerts.fetch_alerts((1, 1, 2, 2), "2026-01-01", "2026-02-01")
    assert d["degraded"] and "GFW_API_KEY" in d["error"] and d["alerts"] == []
    monkeypatch.setenv("GFW_API_KEY", "k")
    net(lambda req: urllib.error.URLError("dns"))
    assert r7_gfw_alerts.fetch_alerts((3, 3, 4, 4), "2026-01-01", "2026-02-01")["degraded"]
    net(lambda req: "not json")
    assert "malformed" in r7_gfw_alerts.fetch_alerts((5, 5, 6, 6), "2026-01-01", "2026-02-01")["error"]


def test_s4_parses_loss_by_year_and_respects_the_query_budget(net, monkeypatch):
    monkeypatch.setenv("GFW_API_KEY", "k")
    calls = net(lambda req: json.dumps({"status": "success", "data": [{"umd_tree_cover_loss__year": 2023, "loss_ha": 1.5}, {"umd_tree_cover_loss__year": 2025, "loss_ha": 0.5}]}))
    polys = [(i, (10 + i, -3, 10.1 + i, -2.9)) for i in range(1, 8)]
    out = s4_tree_loss.fetch_loss_by_year(polys, max_queries=3)
    assert len(calls) == 3 and set(out["results"]) == {1, 2, 3} and out["results"][1] == {2023: 1.5, 2025: 0.5}
    monkeypatch.delenv("GFW_API_KEY")
    assert s4_tree_loss.fetch_loss_by_year(polys)["degraded"]


FIRMS_CSV = ("latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight\n"
             "-3.2,10.5,330.1,0.4,0.4,2026-09-09,530,N,VIIRS,n,2.0NRT,290.0,12.5,N\n-3.21,10.51,340.0,0.4,0.4,2026-09-09,530,N,VIIRS,h,2.0NRT,291.0,20.0,N\n")


def test_r6_chunks_windows_dedupes_and_surfaces_text_errors(net, monkeypatch):
    now = datetime(2026, 10, 20, tzinfo=timezone.utc)
    calls = net(lambda req: FIRMS_CSV)
    out = r6_firms.fetch_fires((10.4, -3.3, 10.6, -3.1), "2026-09-01", "2026-09-12", map_key="k9f3a7c1d2e4", now=now)
    assert not out["degraded"] and len(out["fires"]) == 2 and out["fires"][0]["time"] == "0530" and out["fires"][1]["frp"] == 20.0
    assert len(calls) >= 3 and all("/k9f3a7c1d2e4/" in c.full_url and c.full_url.count("/") >= 9 for c in calls)
    assert all(int(c.full_url.rstrip("/").split("/")[-2]) <= 5 for c in calls)           # DAY_RANGE capped at 5
    net(lambda req: "Invalid MAP_KEY.")
    bad = r6_firms.fetch_fires((1, 1, 2, 2), "2026-09-01", "2026-09-03", map_key="k9f3a7c1d2e4", now=now)
    assert bad["degraded"] and "Invalid MAP_KEY" in bad["error"] and "k9f3a7c1d2e4" not in json.dumps(bad)
    monkeypatch.delenv("FIRMS_MAP_KEY", raising=False)
    assert r6_firms.fetch_fires((1, 1, 2, 2), "2026-09-01", "2026-09-03")["degraded"]


def test_r4_reads_dimension_order_from_the_dds_and_never_turns_failure_into_zero_rain(net, monkeypatch):
    assert r4_imerg.parse_dds_order("Float32 precipitation[time = 1][lon = 3600][lat = 1800];") == ["time", "lon", "lat"]
    assert r4_imerg.cell_index(-3.25, 10.55) == (1905, 867)
    assert r4_imerg.parse_ascii_value("Dataset: x\nprecipitation.precipitation[0][0][0], 7.25\n") == 7.25
    assert r4_imerg.parse_ascii_value("precipitation, -9999.9") is None
    assert r4_imerg.day_url("2026-09-05").endswith("2026/09/3B-DAY-L.MS.MRG.3IMERG.20260905-S000000-E235959.V07B.nc4")

    def h(req):
        u = req.full_url
        return "Float32 precipitation[time = 1][lon = 3600][lat = 1800];" if u.endswith(".dds") else "precipitation.precipitation, 12.0\n"
    calls = net(h)
    monkeypatch.setenv("EARTHDATA_TOKEN", "tok")
    out = r4_imerg.fetch_daily(-3.25, 10.55, ["2026-09-05", "2026-09-06"])
    assert out["daily_mm"] == {"2026-09-05": 12.0, "2026-09-06": 12.0} and calls[0].headers["Authorization"] == "Bearer tok"
    assert "precipitation[0:0][1905:1905][867:867]" in calls[1].full_url
    net(lambda req: urllib.error.HTTPError(req.full_url, 401, "no", {}, None))
    bad = r4_imerg.fetch_daily(-3.2, 10.6, ["2026-09-07"])
    assert bad["degraded"] and bad["daily_mm"] == {"2026-09-07": None}                    # unknown, NOT 0 mm
    monkeypatch.delenv("EARTHDATA_TOKEN")
    assert r4_imerg.fetch_daily(0, 0, ["2026-09-07"])["degraded"]


IBTRACS = ("SID,SEASON,NUMBER,BASIN,SUBBASIN,NAME,ISO_TIME,NATURE,LAT,LON,WMO_WIND,WMO_PRES,USA_WIND,USA_R34_NE,USA_R34_SE,USA_R34_SW,USA_R34_NW\n"
           " ,Year, ,  , ,  ,  ,  ,degrees_north,degrees_east,kts,mb,kts,nmile,nmile,nmile,nmile\n"
           "2026X1,2026,1,WP,MM,TEST,2026-09-18 12:00:00,TS,-2.0,10.8,70,980,80,100,90,80,70\n"
           "2026X1,2026,1,WP,MM,TEST,2026-09-19 12:00:00,TS,30.0,150.0,70,980,80,100,90,80,70\n"
           "2026X2,2026,2,WP,MM,OLD,2026-03-01 12:00:00,TS,-2.0,10.8,70,980,80,100,90,80,70\n")


def test_r10_filters_by_time_distance_skips_the_units_row_and_states_the_lag(net):
    pts = r10_ibtracs.parse_csv(IBTRACS, -3.2, 10.5, "2026-08-01", "2026-10-01", 300.0)
    assert len(pts) == 1 and pts[0]["wind_kt"] == 80 and pts[0]["r34_nmi"] == 100 and pts[0]["distance_km"] < 200
    net(lambda req: IBTRACS)
    out = r10_ibtracs.fetch_tracks(-3.2, 10.5, "2026-08-01", "2026-10-01", 300.0)
    assert not out["degraded"] and len(out["points"]) == 1 and "lag" in out["lag_note"].lower()
    net(lambda req: urllib.error.URLError("down"))
    bad = r10_ibtracs.fetch_tracks(10.0, 10.0, "2026-08-01", "2026-10-01", 300.0)
    assert bad["degraded"] and bad["points"] == []
