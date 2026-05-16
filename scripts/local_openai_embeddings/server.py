"""
Локальный OpenAI-совместимый POST /v1/embeddings на CPU (sentence-transformers / PyTorch).

Запуск (из корня репозитория, с установленными зависимостями):
  python scripts/local_openai_embeddings/server.py

Переменные окружения:
  LOCAL_EMBEDDINGS_HOST — по умолчанию 127.0.0.1
  LOCAL_EMBEDDINGS_PORT — по умолчанию 8765
  LOCAL_EMBEDDINGS_MODEL — HuggingFace id; по умолчанию
      sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2
  LOCAL_EMBEDDINGS_API_KEY — если задан, требуется Authorization: Bearer <тот же ключ>
  LOCAL_EMBEDDINGS_INSECURE_SSL=1 — только при невозможности проверить HTTPS (отладка); см. README

В Node для rag index / query:
  set LENA_EMBEDDING_BASE_URL=http://127.0.0.1:8765/v1
  set LENA_EMBEDDING_MODEL=sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2
  set LENA_EMBEDDING_API_KEY=sk-local-любой   (если LOCAL_EMBEDDINGS_API_KEY не задан — любой непустой Bearer)
"""

from __future__ import annotations

import json
import os
import sys
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    _load_model()
    yield


app = FastAPI(title="local-openai-embeddings", version="1.0.0", lifespan=_lifespan)

_model = None
_model_name: str = ""


def _env(name: str, default: str) -> str:
    v = os.environ.get(name)
    return (v.strip() if v else "") or default


def _use_certifi_for_ssl() -> None:
    """На части Windows/Python HTTPS к Hugging Face падает без цепочки CA — certifi обычно помогает."""
    try:
        import certifi

        ca = certifi.where()
        os.environ.setdefault("SSL_CERT_FILE", ca)
        os.environ.setdefault("REQUESTS_CA_BUNDLE", ca)
    except ImportError:
        pass


def _use_truststore_windows() -> None:
    """Windows: встроенное хранилище доверия через truststore (часто чинит HF при «unable to get local issuer»)."""
    try:
        import truststore

        truststore.inject_into_ssl()
    except ImportError:
        pass


def _maybe_insecure_ssl_for_hf() -> None:
    """Только при LOCAL_EMBEDDINGS_INSECURE_SSL=1 — обход проверки сертификата (только отладка / особый прокси)."""
    if os.environ.get("LOCAL_EMBEDDINGS_INSECURE_SSL", "").strip() != "1":
        return
    import ssl
    import urllib.request

    ctx = ssl._create_unverified_context()
    ssl._create_default_https_context = ssl._create_unverified_context  # type: ignore[method-assign]
    urllib.request.install_opener(urllib.request.build_opener(urllib.request.HTTPSHandler(context=ctx)))


def _load_model() -> None:
    global _model, _model_name
    _use_truststore_windows()
    _use_certifi_for_ssl()
    _maybe_insecure_ssl_for_hf()
    from sentence_transformers import SentenceTransformer

    _model_name = _env(
        "LOCAL_EMBEDDINGS_MODEL",
        "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
    )
    print(f"[local-embeddings] loading {_model_name!r} (first run may download weights)…", file=sys.stderr)
    _model = SentenceTransformer(_model_name, device="cpu")
    print("[local-embeddings] model ready.", file=sys.stderr)


def _check_auth(request: Request) -> None:
    expected = os.environ.get("LOCAL_EMBEDDINGS_API_KEY", "").strip()
    if not expected:
        return
    auth = request.headers.get("authorization") or ""
    if auth.strip() != f"Bearer {expected}":
        raise HTTPException(status_code=401, detail="Invalid API key")


def _normalize_input(body: dict[str, Any]) -> list[str]:
    inp = body.get("input")
    if inp is None:
        raise HTTPException(status_code=400, detail="Missing 'input'")
    if isinstance(inp, str):
        texts = [inp]
    elif isinstance(inp, list):
        texts = [str(x) for x in inp]
    else:
        raise HTTPException(status_code=400, detail="'input' must be string or array of strings")
    if len(texts) == 0:
        raise HTTPException(status_code=400, detail="Empty 'input'")
    if len(texts) > 256:
        raise HTTPException(status_code=400, detail="Max 256 inputs per request")
    return texts


def _maybe_truncate(vec: list[float], dim: int | None) -> list[float]:
    if dim is None or dim <= 0 or dim >= len(vec):
        return vec
    return vec[:dim]


@app.post("/v1/embeddings")
async def embeddings(request: Request) -> JSONResponse:
    _check_auth(request)
    if _model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    try:
        raw = await request.json()
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=400, detail=f"Invalid JSON: {e}") from e

    texts = _normalize_input(raw if isinstance(raw, dict) else {})
    dim_raw = raw.get("dimensions") if isinstance(raw, dict) else None
    dim: int | None = None
    if isinstance(dim_raw, int) and dim_raw > 0:
        dim = dim_raw
    elif isinstance(dim_raw, str) and dim_raw.isdigit():
        dim = int(dim_raw)

    try:
        import numpy as np

        arr = _model.encode(
            texts,
            convert_to_numpy=True,
            show_progress_bar=False,
            normalize_embeddings=True,
        )
        if arr.ndim == 1:
            vectors = [arr]
        else:
            vectors = [arr[i] for i in range(arr.shape[0])]
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Embedding failed: {e!r}") from e

    if len(vectors) != len(texts):
        raise HTTPException(
            status_code=500,
            detail=f"Expected {len(texts)} vectors, got {len(vectors)}",
        )

    data = []
    for i, row in enumerate(vectors):
        vec = [float(x) for x in np.asarray(row).flatten().tolist()]
        vec = _maybe_truncate(vec, dim)
        data.append(
            {
                "object": "embedding",
                "embedding": vec,
                "index": i,
            }
        )

    req_model = raw.get("model") if isinstance(raw, dict) else None
    out_model = (
        req_model.strip()
        if isinstance(req_model, str) and req_model.strip()
        else _model_name
    )
    return JSONResponse(
        {
            "object": "list",
            "data": data,
            "model": out_model,
            "usage": {"prompt_tokens": 0, "total_tokens": 0},
        }
    )


@app.get("/v1/models")
async def list_models() -> dict[str, Any]:
    return {
        "object": "list",
        "data": [
            {
                "id": _model_name or "local-sentence-transformers",
                "object": "model",
            }
        ],
    }


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "model": _model_name}


def main() -> None:
    host = _env("LOCAL_EMBEDDINGS_HOST", "127.0.0.1")
    port = int(_env("LOCAL_EMBEDDINGS_PORT", "8765"))
    import uvicorn

    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
