"""
FastAPI dependency for Bearer-token session authentication.

Usage:
    @router.post("/stream")
    async def endpoint(session: SessionData = Depends(get_session)):
        ...
"""

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.dependencies import get_session_service
from app.services.session_service import SessionData, SessionService

_bearer = HTTPBearer(auto_error=False)


async def get_session(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    session_service: SessionService = Depends(get_session_service),
) -> SessionData:
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="missing_token",
        )

    session = await session_service.validate(credentials.credentials)

    if session is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid_or_expired_token",
        )

    return session
