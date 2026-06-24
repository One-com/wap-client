"""
SQLAlchemy 2.0 async ORM models — production schema.

All column names use snake_case (matching the Alembic 0002 migration).
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Agent(Base):
    """Agent definition — model, prompt, tool configuration.

    Agents are never deleted; unmapped agents (not in agent_role_map) act as drafts.
    """

    __tablename__ = "agents"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    slug: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    product_slug: Mapped[str] = mapped_column(String(100), nullable=False)
    provider: Mapped[str] = mapped_column(String(50), nullable=False, default="anthropic")
    model: Mapped[str] = mapped_column(String(100), nullable=False)
    system_prompt: Mapped[str] = mapped_column(Text, nullable=False)
    temperature: Mapped[float] = mapped_column(Float, nullable=False, default=0.3)
    # Recursion limit for the ReAct loop
    max_turns: Mapped[int] = mapped_column(Integer, nullable=False, default=25)
    # Tool descriptors — None means no tools.
    # Format: [{"type": "mcp"}, {"type": "builtin", "name": "web_fetch"}]
    tools: Mapped[list[dict] | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)


class AgentRoleMap(Base):
    """Maps a role string to an active agent.

    This is the only table that says which agent is currently serving a role.
    Updating this row hot-swaps the agent for all future requests.

    Well-known roles: wp-rocket:standard, rankmath:standard,
                      global:orchestrator, global:synthesis, global:summarizer
    """

    __tablename__ = "agent_role_map"

    role: Mapped[str] = mapped_column(String(100), primary_key=True)
    agent_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("agents.id", ondelete="RESTRICT"),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)


class PromptSnippet(Base):
    """Reusable prompt blocks referenced by {{snippet:key}} in agent system prompts.

    Resolved at AgentRegistry load time. Missing keys fail loudly.
    """

    __tablename__ = "prompt_snippets"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    key: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)


class SiteCredential(Base):
    """WP Application Password stored encrypted per (user_id, product, site_url)."""

    __tablename__ = "site_credentials"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[str] = mapped_column(String(255), nullable=False)
    site_url: Mapped[str] = mapped_column(String(500), nullable=False)
    product: Mapped[str] = mapped_column(String(100), nullable=False)
    wp_username: Mapped[str] = mapped_column(String(255), nullable=False)
    encrypted_wp_app_password: Mapped[str] = mapped_column(Text, nullable=False)
    mcp_endpoint: Mapped[str] = mapped_column(String(500), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)


class AdminUser(Base):
    """Admin user for the browser-based admin GUI. Email is used as login identifier."""

    __tablename__ = "admin_users"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    hashed_password: Mapped[str] = mapped_column(Text, nullable=False)
    display_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)


class SiteAllowlist(Base):
    """Allowed site_url patterns for gating session creation (fnmatch wildcards).

    Only enforced when AUTH_SITE_ALLOWLIST_ENABLED is true (test/staging). A
    pattern may be exact ("https://my.site") or wildcarded ("https://*.example.com").
    """

    __tablename__ = "site_allowlist"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    pattern: Mapped[str] = mapped_column(String(500), unique=True, nullable=False)
    description: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
