"""
Admin routes — CRUD for agents, role mappings, and prompt snippets.

All routes are protected by ADMIN_API_KEY (Bearer token in Authorization header).
This path group should only be reachable on the private/internal network ingress.

Endpoints:
  GET/POST/PUT/DELETE /agents
  GET/PUT/DELETE /roles/{role}
  GET/POST/PUT/DELETE /snippets
  GET /observability
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime

from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, status
from fastapi.responses import Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field
from sqlalchemy import delete, select

from app.db.models import Agent as AgentModel
from app.db.models import AgentRoleMap, PromptSnippet
from app.state import get_state

logger = logging.getLogger(__name__)
router = APIRouter()

_bearer = HTTPBearer(auto_error=False)


async def _require_admin(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    admin_session: str | None = Cookie(default=None),
) -> None:
    settings = get_state(request).settings
    # Option 1: existing Bearer token (backward compat for CLI/scripts)
    if credentials is not None and credentials.credentials == settings.ADMIN_API_KEY:
        return
    # Option 2: admin GUI session cookie
    if admin_session is not None:
        svc = get_state(request).admin_session_service
        if await svc.validate(admin_session) is not None:
            return
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="unauthorized",
    )


# ── Agent Pydantic schemas ────────────────────────────────────────────────────


class AgentCreate(BaseModel):
    slug: str = Field(min_length=1)
    name: str = Field(min_length=1)
    product_slug: str = Field(min_length=1, alias="productSlug")
    provider: str = Field(default="anthropic", pattern="^(anthropic)$")
    model: str = Field(min_length=1)
    system_prompt: str = Field(min_length=1, alias="systemPrompt")
    temperature: float = Field(default=0.3, ge=0.0, le=1.0)
    max_turns: int = Field(default=25, ge=1, le=100, alias="maxTurns")
    tools: list[dict] | None = Field(default=None)

    model_config = {"populate_by_name": True}


class AgentUpdate(BaseModel):
    slug: str | None = None
    name: str | None = None
    product_slug: str | None = Field(default=None, alias="productSlug")
    provider: str | None = None
    model: str | None = None
    system_prompt: str | None = Field(default=None, alias="systemPrompt")
    temperature: float | None = Field(default=None, ge=0.0, le=1.0)
    max_turns: int | None = Field(default=None, ge=1, le=100, alias="maxTurns")
    tools: list[dict] | None = None

    model_config = {"populate_by_name": True}


# ── Snippet Pydantic schemas ──────────────────────────────────────────────────


class SnippetCreate(BaseModel):
    key: str = Field(min_length=1, pattern=r"^[a-z0-9_-]+$")
    content: str = Field(min_length=1)


class SnippetUpdate(BaseModel):
    content: str = Field(min_length=1)


class AllowlistCreate(BaseModel):
    pattern: str = Field(min_length=1, max_length=500)
    description: str | None = Field(default=None, max_length=255)


# ── Role Pydantic schemas ─────────────────────────────────────────────────────


class RoleAssign(BaseModel):
    agent_id: str = Field(min_length=1, alias="agentId")

    model_config = {"populate_by_name": True}


# ── Agent endpoints ───────────────────────────────────────────────────────────


@router.get("/agents", dependencies=[Depends(_require_admin)])
async def list_agents(request: Request) -> dict:
    """List all agent definitions (mapped and unmapped)."""
    registry = get_state(request).agent_registry
    return {"agents": [a.to_dict() for a in registry.all()]}


@router.post("/agents", status_code=201, dependencies=[Depends(_require_admin)])
async def create_agent(body: AgentCreate, request: Request) -> dict:
    """Create a new agent definition.

    The agent is not mapped to any role — it is an undeployed draft.
    Use PUT /roles/{role} to assign it.
    """
    session_factory = get_state(request).session_factory
    registry = get_state(request).agent_registry

    agent_id = uuid.uuid4()
    async with session_factory() as session:
        async with session.begin():
            row = AgentModel(
                id=agent_id,
                slug=body.slug,
                name=body.name,
                product_slug=body.product_slug,
                provider=body.provider,
                model=body.model,
                system_prompt=body.system_prompt,
                temperature=body.temperature,
                max_turns=body.max_turns,
                tools=body.tools,
            )
            session.add(row)

    await registry.reload(str(agent_id))
    agent = registry.get_by_id(str(agent_id))
    return agent.to_dict() if agent else {"id": str(agent_id)}


@router.get("/agents/{agent_id}", dependencies=[Depends(_require_admin)])
async def get_agent(agent_id: str, request: Request) -> dict:
    registry = get_state(request).agent_registry
    agent = registry.get_by_id(agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="not_found")
    return agent.to_dict()


@router.put("/agents/{agent_id}", dependencies=[Depends(_require_admin)])
async def update_agent(agent_id: str, body: AgentUpdate, request: Request) -> dict:
    """Update an agent definition.  Triggers registry reload for this agent."""
    session_factory = get_state(request).session_factory
    registry = get_state(request).agent_registry

    async with session_factory() as session:
        async with session.begin():
            result = await session.execute(select(AgentModel).where(AgentModel.id == uuid.UUID(agent_id)))
            row = result.scalar_one_or_none()
            if not row:
                raise HTTPException(status_code=404, detail="not_found")

            updates = body.model_dump(exclude_none=True, by_alias=False)
            for field_name, value in updates.items():
                setattr(row, field_name, value)
            row.updated_at = datetime.utcnow()

    await registry.reload(agent_id)
    agent = registry.get_by_id(agent_id)
    return agent.to_dict() if agent else {"id": agent_id}


@router.delete("/agents/{agent_id}", status_code=204, dependencies=[Depends(_require_admin)])
async def delete_agent(agent_id: str, request: Request) -> Response:
    """Hard-delete an agent.

    Fails with 409 if the agent is currently mapped to any role.
    """
    session_factory = get_state(request).session_factory
    registry = get_state(request).agent_registry

    async with session_factory() as session:
        async with session.begin():
            # Check no role references this agent
            role_result = await session.execute(
                select(AgentRoleMap).where(AgentRoleMap.agent_id == uuid.UUID(agent_id))
            )
            if role_result.scalar_one_or_none():
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail={"error": "agent_in_use", "message": "Agent is mapped to a role — unmap it first"},
                )

            await session.execute(delete(AgentModel).where(AgentModel.id == uuid.UUID(agent_id)))

    registry.invalidate(agent_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── Role endpoints ────────────────────────────────────────────────────────────


@router.get("/roles", dependencies=[Depends(_require_admin)])
async def list_roles(request: Request) -> dict:
    """List all role → agent_id mappings."""
    registry = get_state(request).agent_registry
    return {"roles": registry.all_roles()}


@router.get("/roles/{role:path}", dependencies=[Depends(_require_admin)])
async def get_role(role: str, request: Request) -> dict:
    registry = get_state(request).agent_registry
    agent = registry.get_by_role(role)
    if not agent:
        raise HTTPException(status_code=404, detail="role_not_found")
    return {"role": role, "agentId": agent.id, "agent": agent.to_dict()}


@router.put("/roles/{role:path}", dependencies=[Depends(_require_admin)])
async def assign_role(role: str, body: RoleAssign, request: Request) -> dict:
    """Assign an agent to a role.  Triggers registry reload for this role.

    This is the only action needed to swap the active agent for a role.
    Existing conversation history is preserved because thread_id is keyed on the role.
    """
    session_factory = get_state(request).session_factory
    registry = get_state(request).agent_registry

    agent_uuid = uuid.UUID(body.agent_id)

    async with session_factory() as session:
        async with session.begin():
            # Verify the agent exists
            agent_result = await session.execute(select(AgentModel).where(AgentModel.id == agent_uuid))
            if not agent_result.scalar_one_or_none():
                raise HTTPException(status_code=404, detail="agent_not_found")

            existing = await session.execute(select(AgentRoleMap).where(AgentRoleMap.role == role))
            mapping = existing.scalar_one_or_none()
            if mapping:
                mapping.agent_id = agent_uuid
                mapping.updated_at = datetime.utcnow()
            else:
                session.add(AgentRoleMap(role=role, agent_id=agent_uuid))

    await registry.reload_role(role)
    return {"role": role, "agentId": body.agent_id, "updatedAt": datetime.utcnow().isoformat()}


@router.delete("/roles/{role:path}", status_code=204, dependencies=[Depends(_require_admin)])
async def unmap_role(role: str, request: Request) -> Response:
    """Remove a role mapping (does not delete the agent)."""
    session_factory = get_state(request).session_factory
    registry = get_state(request).agent_registry

    async with session_factory() as session:
        async with session.begin():
            await session.execute(delete(AgentRoleMap).where(AgentRoleMap.role == role))

    await registry.reload_role(role)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── Snippet endpoints ─────────────────────────────────────────────────────────


@router.get("/snippets", dependencies=[Depends(_require_admin)])
async def list_snippets(request: Request) -> dict:
    session_factory = get_state(request).session_factory
    async with session_factory() as session:
        rows = (await session.execute(select(PromptSnippet))).scalars().all()
    return {
        "snippets": [
            {"id": str(r.id), "key": r.key, "content": r.content, "updatedAt": r.updated_at.isoformat()} for r in rows
        ]
    }


@router.post("/snippets", status_code=201, dependencies=[Depends(_require_admin)])
async def create_snippet(body: SnippetCreate, request: Request) -> dict:
    session_factory = get_state(request).session_factory
    snippet_id = uuid.uuid4()

    async with session_factory() as session:
        async with session.begin():
            session.add(PromptSnippet(id=snippet_id, key=body.key, content=body.content))

    return {"id": str(snippet_id), "key": body.key, "content": body.content}


@router.put("/snippets/{key}", dependencies=[Depends(_require_admin)])
async def update_snippet(key: str, body: SnippetUpdate, request: Request) -> dict:
    """Update a snippet.  Triggers registry reload for all agents that reference it."""
    session_factory = get_state(request).session_factory
    registry = get_state(request).agent_registry

    async with session_factory() as session:
        async with session.begin():
            result = await session.execute(select(PromptSnippet).where(PromptSnippet.key == key))
            snippet = result.scalar_one_or_none()
            if not snippet:
                raise HTTPException(status_code=404, detail="snippet_not_found")
            snippet.content = body.content
            snippet.updated_at = datetime.utcnow()

    await registry.reload_snippets_for_agents(key)
    return {"key": key, "content": body.content, "updatedAt": datetime.utcnow().isoformat()}


@router.delete("/snippets/{key}", status_code=204, dependencies=[Depends(_require_admin)])
async def delete_snippet(key: str, request: Request) -> Response:
    """Delete a snippet.  Fails if any agent references it."""
    session_factory = get_state(request).session_factory

    async with session_factory() as session:
        async with session.begin():
            # Check if any agent's system_prompt references this key
            agents = (await session.execute(select(AgentModel))).scalars().all()
            placeholder = "{{" + f"snippet:{key}" + "}}"
            referencing = [a.slug for a in agents if placeholder in a.system_prompt]
            if referencing:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail={
                        "error": "snippet_in_use",
                        "message": f"Snippet '{key}' is referenced by agents: {referencing}",
                    },
                )

            await session.execute(delete(PromptSnippet).where(PromptSnippet.key == key))

    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/snippets/{key}", dependencies=[Depends(_require_admin)])
async def get_snippet(key: str, request: Request) -> dict:
    session_factory = get_state(request).session_factory
    async with session_factory() as session:
        result = await session.execute(select(PromptSnippet).where(PromptSnippet.key == key))
        snippet = result.scalar_one_or_none()
    if not snippet:
        raise HTTPException(status_code=404, detail="snippet_not_found")
    return {"id": str(snippet.id), "key": snippet.key, "content": snippet.content}


# ── Observability endpoint ────────────────────────────────────────────────────


@router.get("/observability", dependencies=[Depends(_require_admin)])
async def get_observability(request: Request) -> dict:
    """Returns the LangFuse dashboard URL for monitoring."""
    settings = get_state(request).settings
    if not settings.LANGFUSE_PUBLIC_KEY:
        return {"enabled": False, "message": "LangFuse not configured (LANGFUSE_PUBLIC_KEY not set)"}
    dashboard_url = f"{settings.LANGFUSE_BASE_URL}/dashboard"
    return {"enabled": True, "dashboardUrl": dashboard_url}


# ── Site allowlist endpoints ──────────────────────────────────────────────────


@router.get("/allowlist", dependencies=[Depends(_require_admin)])
async def list_allowlist(request: Request) -> dict:
    svc = get_state(request).site_allowlist_service
    entries = await svc.list_all()
    return {
        "enabled": get_state(request).settings.AUTH_SITE_ALLOWLIST_ENABLED,
        "entries": [
            {
                "id": str(e.id),
                "pattern": e.pattern,
                "description": e.description,
                "createdAt": e.created_at.isoformat(),
            }
            for e in entries
        ],
    }


@router.post("/allowlist", status_code=201, dependencies=[Depends(_require_admin)])
async def create_allowlist_entry(body: AllowlistCreate, request: Request) -> dict:
    svc = get_state(request).site_allowlist_service
    entry = await svc.add(body.pattern, body.description)
    return {"id": str(entry.id), "pattern": entry.pattern, "description": entry.description}


@router.delete("/allowlist/{entry_id}", status_code=204, dependencies=[Depends(_require_admin)])
async def delete_allowlist_entry(entry_id: uuid.UUID, request: Request) -> Response:
    svc = get_state(request).site_allowlist_service
    await svc.delete(entry_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
