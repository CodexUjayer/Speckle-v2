"""Put the repo root and the shared fixture directory (tests/) on sys.path, and build the known-truth forest scene ONCE per module."""
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_HERE, "..", "..", "..", ".."))
for _p in (_ROOT, os.path.join(_ROOT, "tests")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import pytest  # noqa: E402


@pytest.fixture(scope="module")
def scene(tmp_path_factory):
    pytest.importorskip("pyproj")
    import deforestation_scene as S
    b = S.build_forest_bundle(tmp_path_factory.mktemp("anc"), active_codes={"M2"})
    return b, S.providers(b)


@pytest.fixture(scope="module")
def result(scene):
    from engine.pipelines.deforestation.verdict import run
    b, prov = scene
    return run(b, providers=prov)
