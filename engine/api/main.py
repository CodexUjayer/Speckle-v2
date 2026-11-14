
"""5 — FastAPI app entrypoint.

    python -m uvicorn engine.api.main:app --host 0.0.0.0 --port 8900

Serving slice for the unified UI.
"""
from __future__ import annotations

import logging
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from engine.common.config import data_root
from engine.registry import Registry

from .jobs import earthdata_present, scans_enabled
from .routes_background import router as background_router
from .routes_bundles import router as bundles_router
from .routes_events import router as events_router
from .routes_jobs import router as jobs_router
from .routes_pipelines import router as pipelines_router
from .routes_retrievals import router as retrievals_router
from .routes_settings import router as settings_router
from .routes_runs import router as runs_router
from .routes_scanner import router as scanner_router
from .routes_tiles import router as tiles_router


# Logging configuration
if not logging.getLogger().handlers:
    logging.basicConfig(
        level=os.environ.get("NISAR_LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )


# Allowed frontend origins
_LOCAL_ORIGINS = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",

    # Production Vercel deployments
    "https://speckle-v2.vercel.app",
    "https://dancing-with-sa-rs-yvro.vercel.app",
]


def _ui_origins() -> list[str]:
    """Return unique allowed frontend origins.

    Supports additional production/preview origins through
    NISAR_UI_ORIGINS (comma-separated).
    """
    extra = [
        origin.strip().rstrip("/")
        for origin in os.environ.get(
            "NISAR_UI_ORIGINS", ""
        ).split(",")
        if origin.strip()
    ]

    origins = []

    for origin in [*extra, *_LOCAL_ORIGINS]:
        if origin not in origins:
            origins.append(origin)

    return origins


def create_app() -> FastAPI:
    app = FastAPI(
        title="speckle",
        version="0.1.0",
    )

    # Exception handler middleware.
    # Keeps unexpected errors readable and allows CORS middleware
    # to attach headers to generated 500 responses.
    @app.middleware("http")
    async def _readable_500(request, call_next):
        try:
            return await call_next(request)

        except Exception as ex:
            from fastapi.responses import JSONResponse

            logging.getLogger("nisar.api").exception(
                "unhandled error on %s %s",
                request.method,
                request.url.path,
            )

            return JSONResponse(
                status_code=500,
                content={
                    "detail": {
                        "ok": False,
                        "error": (
                            f"engine error: "
                            f"{type(ex).__name__}: {ex}"
                        ),
                    }
                },
            )

    # CORS configuration
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_ui_origins(),
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=[
            "X-Img-Meta",
            "Retry-After",
            "Content-Disposition",
            "Content-Range",
        ],
    )

    # API routers
    app.include_router(pipelines_router)
    app.include_router(bundles_router)
    app.include_router(tiles_router)
    app.include_router(runs_router)
    app.include_router(events_router)
    app.include_router(jobs_router)
    app.include_router(scanner_router)
    app.include_router(background_router)
    app.include_router(retrievals_router)
    app.include_router(settings_router)

    # Health endpoint
    @app.get("/api/health")
    def health():
        data_dir = data_root()
        bundles_dir = Registry().bundles_dir

        cache_enabled = True
        cache_reason = None

        try:
            from .state import get_runner

            cache = get_runner().cache
            cache_enabled = cache.enabled
            cache_reason = cache.disabled_reason

        except Exception as ex:
            cache_enabled = False
            cache_reason = (
                f"{type(ex).__name__}: {ex}"
            )

        try:
            from engine.common.sqlite_util import resolve_db_dir

            db_dir = str(resolve_db_dir(data_dir))

        except Exception as ex:
            db_dir = (
                f"unavailable: {type(ex).__name__}: {ex}"
            )

        # Earthdata credentials
        creds = (
            "present"
            if earthdata_present()
            else "absent"
        )

        # Runner status
        try:
            from .state import get_runner

            busy = get_runner().busy()

        except Exception:
            busy = None

        # Granule search status
        granule_search = {
            "status": (
                "enabled"
                if creds == "present"
                else "disabled"
            ),
            "reason": (
                None
                if creds == "present"
                else (
                    "Earthdata credentials absent — "
                    "ASF search needs EARTHDATA_TOKEN "
                    "or EARTHDATA_USERNAME + "
                    "EARTHDATA_PASSWORD"
                )
            ),
        }

        return {
            "ok": True,
            "data_dir": str(data_dir),
            "data_dir_exists": data_dir.exists(),

            "db_dir": db_dir,

            "bundles_dir": str(bundles_dir),
            "bundles_dir_exists": bundles_dir.exists(),

            "scans_enabled": scans_enabled(),

            "busy": busy,

            "earthdata_credentials": creds,

            "cache_write": {
                "status": (
                    "enabled"
                    if cache_enabled
                    else "disabled"
                ),
                "reason": cache_reason,
            },

            "granule_search": granule_search,

            "note": (
                "presence-only health; "
                "it never implies verdicts"
            ),
        }

    return app


app = create_app()
