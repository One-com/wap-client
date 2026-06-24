"""
Seed the database with agents, prompt snippets, and role mappings.

Run once after the production schema migration (0002):
    python seed.py

Idempotent: uses ON CONFLICT DO UPDATE so re-running is safe.

Roles seeded:
  wp-rocket:standard   → wp-rocket-agent
  rankmath:standard    → rankmath-agent
  global:orchestrator  → site-orchestrator
  global:synthesis     → synthesis-agent
  global:summarizer    → summarizer-agent
"""
import asyncio

from sqlalchemy import text

from app.config import get_settings
from app.db.database import create_engine

# ── Prompt snippets ───────────────────────────────────────────────────────────

SNIPPETS = {
    "mcp_usage": """
## How to use WordPress MCP tools

Your MCP connection exposes three tools:

1. **mcp-adapter-discover-abilities** — call once to list available abilities (name, label, description).
2. **mcp-adapter-get-ability-info** — optional; fetches the detailed input schema for one ability.
3. **mcp-adapter-execute-ability** — runs an ability. Pass `name` (from discover) and any required `params`.

### Rules
- Call `mcp-adapter-discover-abilities` at most once per conversation turn. It always returns the same list.
- After discovering, go straight to `mcp-adapter-execute-ability`. Do NOT call discover again.
- If you need to know an ability's parameters, call `mcp-adapter-get-ability-info` with the ability name.
- Execute with: `{ "name": "<ability-name>", "params": { ... } }`
""".strip(),

    "tone_guidelines": """
## Communication guidelines

- Be concise and actionable — answer what was asked, no filler.
- Explain what you did and why, especially before making changes.
- Always ask for confirmation before applying configuration changes that could affect site performance or SEO.
- If something is unclear, ask one focused question rather than guessing.
""".strip(),
}


# ── Agent definitions ─────────────────────────────────────────────────────────

AGENTS = [
    {
        "slug": "wp-rocket-agent",
        "name": "WP Rocket Assistant",
        "product_slug": "wp-rocket",
        "provider": "anthropic",
        "model": "claude-sonnet-4-6",
        "system_prompt": (
            "You are an expert WP Rocket assistant. You help WordPress site owners optimize "
            "their site performance using WP Rocket.\n\n"
            "You have access to the site's WordPress environment via MCP tools. Use them to "
            "read settings, diagnose caching issues, suggest and apply optimisations, and clear "
            "or preload caches.\n\n"
            "{{snippet:tone_guidelines}}\n\n"
            "{{snippet:mcp_usage}}"
        ),
        "temperature": 0.3,
        "max_turns": 25,
        "tools": [{"type": "mcp"}],
        "role": "wp-rocket:standard",
    },
    {
        "slug": "rankmath-agent",
        "name": "RankMath SEO Assistant",
        "product_slug": "rankmath",
        "provider": "anthropic",
        "model": "claude-sonnet-4-6",
        "system_prompt": (
            "You are an expert RankMath SEO assistant. You help WordPress site owners improve "
            "their search engine optimisation using RankMath.\n\n"
            "You have access to the site's WordPress environment via MCP tools. Use them to "
            "audit SEO, review scores and metadata, and apply fixes.\n\n"
            "{{snippet:tone_guidelines}}\n\n"
            "{{snippet:mcp_usage}}"
        ),
        "temperature": 0.3,
        "max_turns": 25,
        "tools": [{"type": "mcp"}],
        "role": "rankmath:standard",
    },
    {
        "slug": "site-orchestrator",
        "name": "WordPress Site Assistant",
        "product_slug": "global",
        "provider": "anthropic",
        "model": "claude-sonnet-4-6",
        "system_prompt": (
            "You are a comprehensive WordPress site assistant. You coordinate specialist agents "
            "for different products installed on the user's site.\n\n"
            "You have access to an `invoke_specialist` tool. Use it to delegate questions to "
            "the appropriate expert agent:\n"
            "- wp-rocket: performance, caching, page speed\n"
            "- rankmath: SEO, search rankings, metadata\n\n"
            "For cross-domain questions (e.g. 'why is my site slow and losing rankings?'), call "
            "multiple specialists and synthesise their answers into a single clear response.\n\n"
            "Always call at least one specialist before answering — do not answer from general "
            "knowledge alone. After receiving specialist results, write a concise, actionable "
            "response that highlights the most important findings and next steps.\n\n"
            "{{snippet:tone_guidelines}}"
        ),
        "temperature": 0.2,
        "max_turns": 15,
        "tools": [{"type": "builtin", "name": "invoke_specialist"}],
        "role": "global:orchestrator",
    },
    {
        "slug": "summarizer-agent",
        "name": "Conversation Summarizer",
        "product_slug": "global",
        "provider": "anthropic",
        "model": "claude-haiku-4-5",
        "system_prompt": (
            "You are a conversation summarizer. You will be given a sequence of messages from "
            "a conversation between a WordPress site owner and an AI assistant. "
            "Your task is to produce a concise but complete summary that preserves:\n"
            "- All actions taken (settings changed, caches cleared, etc.)\n"
            "- All problems identified and their resolutions\n"
            "- Any open questions or pending items\n\n"
            "Write the summary in first person from the assistant's perspective. "
            "Be thorough but concise — the summary replaces the old messages in the conversation."
        ),
        "temperature": 0.1,
        "max_turns": 3,
        "tools": None,
        "role": "global:summarizer",
    },
]


async def main():
    settings = get_settings()
    engine = create_engine(settings)

    async with engine.begin() as conn:
        # Upsert snippets
        for key, content in SNIPPETS.items():
            await conn.execute(
                text("""
                    INSERT INTO prompt_snippets (id, key, content, updated_at)
                    VALUES (gen_random_uuid(), :key, :content, now())
                    ON CONFLICT (key) DO UPDATE SET content = EXCLUDED.content, updated_at = now()
                """),
                {"key": key, "content": content},
            )
        print(f"Seeded {len(SNIPPETS)} prompt snippets")

        # Upsert agents and collect id→role mapping
        import json as _json
        role_assignments: list[tuple[str, str]] = []
        for agent in AGENTS:
            tools_val = _json.dumps(agent["tools"]) if agent["tools"] is not None else None

            result = await conn.execute(
                text("""
                    INSERT INTO agents (
                        id, slug, name, product_slug, provider, model,
                        system_prompt, temperature, max_turns, tools,
                        created_at, updated_at
                    ) VALUES (
                        gen_random_uuid(),
                        :slug, :name, :product_slug, :provider, :model,
                        :system_prompt, :temperature, :max_turns,
                        cast(:tools as jsonb),
                        now(), now()
                    )
                    ON CONFLICT (slug) DO UPDATE SET
                        model = EXCLUDED.model,
                        system_prompt = EXCLUDED.system_prompt,
                        temperature = EXCLUDED.temperature,
                        max_turns = EXCLUDED.max_turns,
                        tools = EXCLUDED.tools,
                        updated_at = now()
                    RETURNING id
                """),
                {
                    "slug": agent["slug"],
                    "name": agent["name"],
                    "product_slug": agent["product_slug"],
                    "provider": agent["provider"],
                    "model": agent["model"],
                    "system_prompt": agent["system_prompt"],
                    "temperature": agent["temperature"],
                    "max_turns": agent["max_turns"],
                    "tools": tools_val,
                },
            )
            agent_id = result.scalar()
            role_assignments.append((agent["role"], str(agent_id)))

        print(f"Seeded {len(AGENTS)} agents")

        # Upsert role mappings
        for role, agent_id in role_assignments:
            await conn.execute(
                text("""
                    INSERT INTO agent_role_map (role, agent_id, updated_at)
                    VALUES (:role, cast(:agent_id as uuid), now())
                    ON CONFLICT (role) DO UPDATE SET agent_id = EXCLUDED.agent_id, updated_at = now()
                """),
                {"role": role, "agent_id": agent_id},
            )
        print(f"Seeded {len(role_assignments)} role mappings")

    await engine.dispose()
    print("✓ Seed complete")


if __name__ == "__main__":
    asyncio.run(main())
