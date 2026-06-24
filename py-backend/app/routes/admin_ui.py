"""
Admin GUI HTML routes — browser-facing views served via Jinja2 templates.

Authentication:
  GET  /admin/login    — login form (unauthenticated)
  POST /admin/login    — credential validation + cookie issuance
  GET  /admin/logout   — cookie revocation + redirect

Protected pages (all require admin_session cookie):
  GET /admin/ui/agents            — agents list page
  GET /admin/ui/agents/new        — HTMX partial: new agent form
  GET /admin/ui/agents/{id}/edit  — HTMX partial: agent edit form
  GET /admin/ui/roles             — role mapping page
  GET /admin/ui/snippets          — snippet management page
"""

from __future__ import annotations

import logging
import time
import uuid
from typing import Annotated, Any, cast

from fastapi import APIRouter, Cookie, Depends, Form, HTTPException, Request, status
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy import select

from app.config import get_settings
from app.db.models import AdminUser, Agent, PromptSnippet
from app.lib.password import _DUMMY_HASH, verify_password
from app.lib.tools import TOOL_CATALOG
from app.services.admin_session_service import AdminSessionData, AdminSessionService
from app.state import get_state

logger = logging.getLogger(__name__)
router = APIRouter()


def _catalog_ids() -> set[str]:
    return {entry["id"] for entry in TOOL_CATALOG}


def _agent_tool_ids(tools: list[dict] | None) -> set[str]:
    if not tools:
        return set()
    ids: set[str] = set()
    for td in tools:
        if td.get("type") == "mcp":
            ids.add("mcp")
        elif td.get("type") == "builtin" and td.get("name"):
            ids.add(td["name"])
    return ids


def _agent_unknown_tools(tools: list[dict] | None, known_ids: set[str]) -> list[dict]:
    if not tools:
        return []
    result = []
    for td in tools:
        if td.get("type") == "mcp" and "mcp" in known_ids:
            continue
        if td.get("type") == "builtin" and td.get("name") in known_ids:
            continue
        result.append(td)
    return result


_COOKIE_NAME = "admin_session"
_COOKIE_MAX_AGE = 28800  # 8 hours — matches Redis TTL


# ── Redirect sentinel ─────────────────────────────────────────────────────────


class _LoginRedirect(Exception):
    """Raised by require_admin_ui_session to trigger a redirect to /admin/login."""


# ── Auth dependency ───────────────────────────────────────────────────────────


async def require_admin_ui_session(
    request: Request,
    admin_session: str | None = Cookie(default=None),
) -> AdminSessionData:
    """Dependency for protected HTML routes. Redirects to /admin/login on failure."""
    if admin_session is None:
        raise _LoginRedirect()

    svc: AdminSessionService = get_state(request).admin_session_service
    session = await svc.validate(admin_session)
    if session is None:
        raise _LoginRedirect()

    return session


def _t(request: Request) -> Jinja2Templates:
    return get_state(request).templates


# ── Login / logout ────────────────────────────────────────────────────────────


@router.get("/login", response_class=HTMLResponse, response_model=None)
async def get_login(
    request: Request,
    admin_session: str | None = Cookie(default=None),
) -> HTMLResponse | RedirectResponse:
    if admin_session:
        svc: AdminSessionService = get_state(request).admin_session_service
        if await svc.validate(admin_session):
            return RedirectResponse(url="/admin/ui/agents", status_code=303)

    return _t(request).TemplateResponse(request, "admin/login.html", {"error": None})


async def _authenticate_admin(session_factory: Any, email: str, password: str) -> AdminUser | None:
    """Return the AdminUser for valid credentials, else None.

    Always runs bcrypt (against a dummy hash when the user is unknown) so the
    response time does not reveal whether an email exists — prevents timing-based
    user enumeration.
    """
    async with session_factory() as db_session:
        result = await db_session.execute(select(AdminUser).where(AdminUser.email == email.lower().strip()))
        user: AdminUser | None = result.scalar_one_or_none()

    if user is None:
        verify_password(password, _DUMMY_HASH)
        return None
    if not verify_password(password, user.hashed_password):
        return None
    return user


@router.post("/login", response_model=None)
async def post_login(
    request: Request,
    email: Annotated[str, Form()],
    password: Annotated[str, Form()],
) -> HTMLResponse | RedirectResponse:
    state = get_state(request)
    svc: AdminSessionService = state.admin_session_service

    user = await _authenticate_admin(state.session_factory, email, password)
    if user is None:
        return _t(request).TemplateResponse(
            request,
            "admin/login.html",
            {"error": "Invalid email or password"},
            status_code=status.HTTP_401_UNAUTHORIZED,
        )

    session_data = AdminSessionData(
        admin_user_id=str(user.id),
        email=user.email,
        display_name=user.display_name,
        created_at=int(time.time() * 1000),
    )
    token = await svc.create(session_data)

    is_production = state.settings.is_production
    response = RedirectResponse(url="/admin/ui/agents", status_code=303)
    response.set_cookie(
        key=_COOKIE_NAME,
        value=token,
        httponly=True,
        samesite="strict",
        secure=is_production,
        max_age=_COOKIE_MAX_AGE,
    )
    return response


@router.get("/logout")
async def logout(
    request: Request,
    admin_session: str | None = Cookie(default=None),
) -> RedirectResponse:
    if admin_session:
        svc: AdminSessionService = get_state(request).admin_session_service
        await svc.revoke(admin_session)

    response = RedirectResponse(url="/admin/login", status_code=303)
    response.delete_cookie(key=_COOKIE_NAME)
    return response


# ── Protected pages ───────────────────────────────────────────────────────────


@router.get("/ui/agents", response_class=HTMLResponse)
async def agents_page(
    request: Request,
    session: AdminSessionData = Depends(require_admin_ui_session),
) -> HTMLResponse:
    registry = get_state(request).agent_registry
    agents = [a.to_dict() for a in registry.all()]
    return _t(request).TemplateResponse(
        request,
        "admin/agents.html",
        {"agents": agents, "session": session},
    )


@router.get("/ui/agents/new", response_class=HTMLResponse)
async def agents_new_form(
    request: Request,
    _session: AdminSessionData = Depends(require_admin_ui_session),
) -> HTMLResponse:
    return _t(request).TemplateResponse(
        request,
        "admin/partials/agent_form.html",
        {
            "agent": None,
            "tool_catalog": TOOL_CATALOG,
            "agent_tool_ids": set(),
            "agent_unknown_tools": [],
        },
    )


@router.get("/ui/agents/{agent_id}/edit", response_class=HTMLResponse)
async def agents_edit_form(
    agent_id: str,
    request: Request,
    _session: AdminSessionData = Depends(require_admin_ui_session),
) -> HTMLResponse:
    # Read raw prompt from DB (unresolved snippets) so the editor shows {{snippet:key}}
    session_factory = get_state(request).session_factory
    async with session_factory() as db_session:
        row = (await db_session.execute(select(Agent).where(Agent.id == uuid.UUID(agent_id)))).scalar_one_or_none()

    if not row:
        raise HTTPException(status_code=404, detail="not_found")

    agent = {
        "id": str(row.id),
        "slug": row.slug,
        "name": row.name,
        "productSlug": row.product_slug,
        "provider": row.provider,
        "model": row.model,
        "systemPrompt": row.system_prompt,  # raw — snippets not resolved
        "temperature": row.temperature,
        "maxTurns": row.max_turns,
        "tools": row.tools,
    }
    known_ids = _catalog_ids()
    tools = cast(list[dict] | None, agent["tools"])
    tool_ids = _agent_tool_ids(tools)
    unknown_tools = _agent_unknown_tools(tools, known_ids)
    return _t(request).TemplateResponse(
        request,
        "admin/partials/agent_form.html",
        {
            "agent": agent,
            "tool_catalog": TOOL_CATALOG,
            "agent_tool_ids": tool_ids,
            "agent_unknown_tools": unknown_tools,
        },
    )


@router.get("/ui/chat", response_class=HTMLResponse)
async def chat_page(
    request: Request,
    session: AdminSessionData = Depends(require_admin_ui_session),
) -> HTMLResponse:
    """Admin chat tester — reuses the WP client widget to talk to any role."""
    registry = get_state(request).agent_registry
    agents_by_id = {a.id: a for a in registry.all()}

    # Enrich each role mapping with its active agent's name and the auth params a
    # WordPress client would supply for that role (product / mode / page_context),
    # so the page can mint a representative session without re-parsing role strings
    # in JS. Role format: "{product}:{context}" (context == "standard" for the
    # default agent); "global:orchestrator" is the orchestrator entry point.
    options = []
    for entry in registry.all_roles():
        role = entry["role"]
        agent = agents_by_id.get(entry["agentId"])
        product, _, context = role.partition(":")
        is_orchestrator = role == "global:orchestrator"
        options.append(
            {
                "role": role,
                "agentName": agent.name if agent else "(unknown agent)",
                "product": product,
                "mode": "orchestrator" if is_orchestrator else "product",
                # Only pass a page_context for non-standard product roles; the
                # backend falls back to {product}:standard when it's absent.
                "pageContext": context if (context and context != "standard" and not is_orchestrator) else "",
            }
        )
    options.sort(key=lambda o: o["role"])

    return _t(request).TemplateResponse(
        request,
        "admin/chat.html",
        {"roles": options, "session": session, "public_api_url": get_settings().PUBLIC_API_URL},
    )


@router.get("/ui/roles", response_class=HTMLResponse)
async def roles_page(
    request: Request,
    session: AdminSessionData = Depends(require_admin_ui_session),
) -> HTMLResponse:
    registry = get_state(request).agent_registry
    roles = registry.all_roles()
    agents = [a.to_dict() for a in registry.all()]
    return _t(request).TemplateResponse(
        request,
        "admin/roles.html",
        {"roles": roles, "agents": agents, "session": session},
    )


@router.get("/ui/snippets", response_class=HTMLResponse)
async def snippets_page(
    request: Request,
    session: AdminSessionData = Depends(require_admin_ui_session),
) -> HTMLResponse:
    session_factory = get_state(request).session_factory
    async with session_factory() as db_session:
        rows = (await db_session.execute(select(PromptSnippet).order_by(PromptSnippet.key))).scalars().all()

    snippets = [{"id": str(r.id), "key": r.key, "content": r.content} for r in rows]
    return _t(request).TemplateResponse(
        request,
        "admin/snippets.html",
        {"snippets": snippets, "session": session},
    )


@router.get("/ui/allowlist", response_class=HTMLResponse)
async def allowlist_page(
    request: Request,
    session: AdminSessionData = Depends(require_admin_ui_session),
) -> HTMLResponse:
    svc = get_state(request).site_allowlist_service
    entries = [
        {"id": str(e.id), "pattern": e.pattern, "description": e.description or ""} for e in await svc.list_all()
    ]
    return _t(request).TemplateResponse(
        request,
        "admin/allowlist.html",
        {
            "entries": entries,
            "enabled": get_state(request).settings.AUTH_SITE_ALLOWLIST_ENABLED,
            "session": session,
        },
    )
