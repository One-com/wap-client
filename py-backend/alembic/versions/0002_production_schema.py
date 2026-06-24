"""Production schema — replaces POC schema.

Changes from 0001:
  - agents: drop role/is_active/mcp_enabled/mcp_tools columns;
            add max_turns INT + tools JSONB
  - Add agent_role_map table (role → agent_id mapping)
  - Add prompt_snippets table
  - Drop agent_tool_configs, conversations, messages (superseded by LangGraph checkpoints)
  - site_credentials: snake_case column names (fix camelCase mismatch from POC)
  - audit_logs: snake_case column names

This is a DESTRUCTIVE migration (drops tables/columns). Only run against a fresh DB.

Revision ID: 0002
"""
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── Drop tables no longer needed ─────────────────────────────────────────
    op.drop_table("messages")
    op.drop_table("conversations")
    op.drop_table("agent_tool_configs")

    # ── Recreate agents with production schema ────────────────────────────────
    # Drop old and recreate clean rather than ALTER (many columns changing)
    op.drop_table("agents")
    op.create_table(
        "agents",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("slug", sa.String(100), nullable=False, unique=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("product_slug", sa.String(100), nullable=False),
        sa.Column("provider", sa.String(50), nullable=False, server_default="anthropic"),
        sa.Column("model", sa.String(100), nullable=False),
        sa.Column("system_prompt", sa.Text(), nullable=False),
        sa.Column("temperature", sa.Float(), nullable=False, server_default="0.3"),
        sa.Column("max_turns", sa.Integer(), nullable=False, server_default="25"),
        # tools JSONB: list of tool descriptors — null means no tools
        # e.g. [{"type": "mcp"}, {"type": "builtin", "name": "web_fetch"}]
        sa.Column(
            "tools",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )

    # ── agent_role_map: role string → agent_id (active deployment state) ─────
    # A role is e.g. "wp-rocket:standard", "global:orchestrator"
    op.create_table(
        "agent_role_map",
        sa.Column("role", sa.String(100), primary_key=True),
        sa.Column(
            "agent_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("agents.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )

    # ── prompt_snippets: reusable prompt blocks ───────────────────────────────
    # Referenced in agent.system_prompt as {{snippet:key}}
    op.create_table(
        "prompt_snippets",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("key", sa.String(100), nullable=False, unique=True),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )

    # ── site_credentials: recreate with snake_case columns ───────────────────
    op.drop_table("site_credentials")
    op.create_table(
        "site_credentials",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("user_id", sa.String(255), nullable=False),
        sa.Column("site_url", sa.String(500), nullable=False),
        sa.Column("product", sa.String(100), nullable=False),
        sa.Column("wp_username", sa.String(255), nullable=False),
        sa.Column("encrypted_wp_app_password", sa.Text(), nullable=False),
        sa.Column("mcp_endpoint", sa.String(500), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    # Lookup index for credential resolution at chat time
    op.create_index(
        "ix_site_credentials_lookup",
        "site_credentials",
        ["user_id", "site_url", "product"],
        unique=True,
    )

    # ── audit_logs: recreate with snake_case columns ──────────────────────────
    op.drop_table("audit_logs")
    op.create_table(
        "audit_logs",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("event_type", sa.String(100), nullable=False),
        sa.Column("user_id", sa.String(255), nullable=True),
        sa.Column("product", sa.String(100), nullable=True),
        sa.Column("site_url", sa.String(500), nullable=True),
        sa.Column("agent_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column(
            "metadata",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )


def downgrade() -> None:
    # Downgrade restores the POC schema (0001 state)
    op.drop_table("audit_logs")
    op.drop_table("site_credentials")
    op.drop_table("prompt_snippets")
    op.drop_table("agent_role_map")
    op.drop_table("agents")

    # Recreate POC tables (abbreviated — just enough to satisfy 0001 state)
    op.create_table(
        "agents",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("slug", sa.String(100), nullable=False, unique=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("productSlug", sa.String(100), nullable=False),
        sa.Column("provider", sa.String(50), nullable=False),
        sa.Column("model", sa.String(100), nullable=False),
        sa.Column("systemPrompt", sa.Text(), nullable=False),
        sa.Column("temperature", sa.Float(), nullable=False),
        sa.Column("mcpEnabled", sa.Boolean(), nullable=False),
        sa.Column("mcpTools", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("role", sa.String(20), nullable=False),
        sa.Column("isActive", sa.Boolean(), nullable=False),
        sa.Column("createdAt", sa.DateTime(), nullable=False),
        sa.Column("updatedAt", sa.DateTime(), nullable=False),
    )
    op.create_table(
        "site_credentials",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("userId", sa.String(255), nullable=False),
        sa.Column("siteUrl", sa.String(500), nullable=False),
        sa.Column("product", sa.String(100), nullable=False),
        sa.Column("wpUsername", sa.String(255), nullable=False),
        sa.Column("encryptedWpAppPassword", sa.Text(), nullable=False),
        sa.Column("mcpEndpoint", sa.String(500), nullable=False),
        sa.Column("createdAt", sa.DateTime(), nullable=False),
        sa.Column("updatedAt", sa.DateTime(), nullable=False),
    )
    op.create_table(
        "audit_logs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("eventType", sa.String(100), nullable=False),
        sa.Column("product", sa.String(100), nullable=True),
        sa.Column("siteUrl", sa.String(500), nullable=True),
        sa.Column("agentId", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("metadata", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("createdAt", sa.DateTime(), nullable=False),
    )
