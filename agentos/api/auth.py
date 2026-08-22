"""
Auth middleware. Port of src/api/auth.ts.
Bearer token (CLI) or session cookie (UI).
"""
from fastapi import Cookie, Depends, HTTPException, Request
from fastapi.responses import JSONResponse

from agentos.config import safe_equal


def _extract_token(request: Request) -> str | None:
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return request.cookies.get("agentos_session")


def require_operator(request: Request) -> None:
    from agentos.config import load_config
    config = load_config()
    token = _extract_token(request)
    if not token or not safe_equal(token, config.operator_token):
        raise HTTPException(status_code=401, detail="unauthorized")


def set_session_cookie(response: JSONResponse, token: str) -> None:
    response.set_cookie(
        "agentos_session", token,
        httponly=True, samesite="lax", secure=False, max_age=86400 * 30,
    )


def clear_session_cookie(response: JSONResponse) -> None:
    response.delete_cookie("agentos_session")
