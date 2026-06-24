"""
Single-agent graph — a ReAct agent with persistent conversation state.

Uses LangGraph's create_react_agent compiled with AsyncPostgresSaver as the
checkpointer.  Conversation history is stored automatically in Postgres under
thread_id = f"{user_id}:{role}".  No manual history injection needed.

Streams via graph.astream(stream_mode="messages") which yields
(message, metadata) tuples — idiomatic LangGraph, no string-event filtering.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, AsyncGenerator

from langchain_anthropic import ChatAnthropic
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage
from langchain_core.tools import BaseTool
from langgraph.prebuilt import create_react_agent

from app.lib.request_context import RequestContext
from app.lib.sse import format_sse
from app.lib.text import extract_text as _extract_text_delta
from app.lib.tools import resolve_tools
from app.services.agent_registry import AgentDefinition
from app.services.wp_connection_service import WpConnectionService

if TYPE_CHECKING:
    from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

    from app.services.summarizer import ConversationSummarizer

logger = logging.getLogger(__name__)

# Threads with pending_writes older than this are considered stuck (not in-flight).
# Active streams clear their pending_writes within a few seconds; stuck threads
# from failed tool calls can be stale for hours.
_STUCK_THREAD_THRESHOLD_SECONDS = 30

# Hard wall-clock limit for a single chat stream. Prevents a hung LLM or MCP
# call from holding a Postgres connection indefinitely and starving the pool.
_STREAM_TIMEOUT_SECONDS = 120


class SingleAgentGraph:
    """
    Wraps create_react_agent with AsyncPostgresSaver for persistent conversation threads.

    thread_id = f"{user_id}:{role}" gives each (user, role) pair its own conversation.
    LangGraph loads prior messages from the checkpoint automatically — no history injection.
    """

    def __init__(  # pylint: disable=too-many-arguments,too-many-positional-arguments
        self,
        agent_def: AgentDefinition,
        api_key: str,
        wp_connection_service: WpConnectionService,
        checkpointer: "AsyncPostgresSaver | None" = None,
        summarizer: "ConversationSummarizer | None" = None,
        extra_tools: "list[BaseTool] | None" = None,
    ) -> None:
        self._agent_def = agent_def
        self._api_key = api_key
        self._wp_svc = wp_connection_service
        self._checkpointer = checkpointer
        self._summarizer = summarizer
        self._extra_tools = extra_tools or []

    # ── Public streaming interface ────────────────────────────────────────────

    async def stream(
        self,
        *,
        role: str,
        message: str,
        context: RequestContext,
        trace_metadata: "dict | None" = None,
    ) -> AsyncGenerator[str, None]:
        """Stream a chat turn as SSE events."""
        thread_id = f"{context.user_id}:{role}"

        # Determine if this agent needs MCP tools
        needs_mcp = self._agent_def.tools and any(td.get("type") == "mcp" for td in self._agent_def.tools)

        extra = {t.name: t for t in self._extra_tools}
        if needs_mcp and context.cred_username:
            async with self._wp_svc.mcp_tools_context(
                context.mcp_endpoint, context.site_url, context.cred_username, context.cred_app_password
            ) as mcp_tools:
                tools = resolve_tools(self._agent_def.tools, mcp_tools, extra)
                async for chunk in self._stream_graph(
                    message, thread_id, tools, context.langfuse_handler, trace_metadata
                ):
                    yield chunk
        else:
            tools = resolve_tools(self._agent_def.tools, [], extra)
            async for chunk in self._stream_graph(message, thread_id, tools, context.langfuse_handler, trace_metadata):
                yield chunk

        # Post-turn: compress history if threshold exceeded
        if self._summarizer:
            task = asyncio.create_task(self._summarizer.maybe_summarize(thread_id))
            task.add_done_callback(
                lambda t: (
                    logger.warning("[SingleAgentGraph] summarizer error for thread %s: %s", thread_id, t.exception())
                    if not t.cancelled() and t.exception()
                    else None
                )
            )

    async def generate(
        self,
        *,
        message: str,
        thread_id: str,
        context: RequestContext,
        trace_metadata: "dict | None" = None,
    ) -> str:
        """Non-streaming invocation — used by InvokeSpecialistTool inside the orchestrator."""
        needs_mcp = self._agent_def.tools and any(td.get("type") == "mcp" for td in self._agent_def.tools)

        extra = {t.name: t for t in self._extra_tools}
        if needs_mcp and context.cred_username:
            async with self._wp_svc.mcp_tools_context(
                context.mcp_endpoint, context.site_url, context.cred_username, context.cred_app_password
            ) as mcp_tools:
                tools = resolve_tools(self._agent_def.tools, mcp_tools, extra)
                return await self._invoke_graph(message, thread_id, tools, context.langfuse_handler, trace_metadata)
        tools = resolve_tools(self._agent_def.tools, [], extra)
        return await self._invoke_graph(message, thread_id, tools, context.langfuse_handler, trace_metadata)

    # ── Internal graph helpers ────────────────────────────────────────────────

    def _build_graph(self, tools: list[BaseTool | dict]) -> Any:
        model = ChatAnthropic(  # type: ignore[call-arg]
            model=self._agent_def.model,
            temperature=self._agent_def.temperature,
            api_key=self._api_key,  # type: ignore[arg-type]
        )
        return create_react_agent(
            model=model,
            tools=tools,
            prompt=self._agent_def.system_prompt,
            checkpointer=self._checkpointer,
        )

    def _make_config(
        self,
        thread_id: str,
        langfuse_handler: object,
        trace_metadata: "dict | None" = None,
    ) -> dict:
        config: dict = {
            "configurable": {"thread_id": thread_id},
            "recursion_limit": self._agent_def.max_turns,
        }
        if langfuse_handler is not None:
            config["callbacks"] = [langfuse_handler]
            # LangFuse v3 reads per-trace attributes from the LangChain run config:
            # langfuse_user_id / langfuse_session_id become trace fields; `tags` is a
            # flat list used for filtering (per-product cost, per-agent monitoring).
            config["metadata"] = self._trace_metadata(thread_id, trace_metadata)
            config["tags"] = self._trace_tags(trace_metadata)
        return config

    def _trace_metadata(self, thread_id: str, trace_metadata: "dict | None") -> dict:
        ctx = trace_metadata or {}
        user_id = ctx.get("user_id") or thread_id.split(":", 1)[0]
        return {
            "langfuse_session_id": thread_id,
            "langfuse_user_id": user_id,
            "product": ctx.get("product", self._agent_def.product_slug),
            "agent_slug": self._agent_def.slug,
            "mode": ctx.get("mode", ""),
        }

    def _trace_tags(self, trace_metadata: "dict | None") -> list[str]:
        ctx = trace_metadata or {}
        tags = [
            ctx.get("product", self._agent_def.product_slug),
            self._agent_def.slug,
        ]
        mode = ctx.get("mode")
        if mode:
            tags.append(mode)
        return [t for t in tags if t]

    async def _maybe_clear_stuck_thread(self, thread_id: str, config: dict) -> None:
        """Delete a thread whose checkpoint has stale pending_writes.

        pending_writes on a CheckpointTuple means LangGraph is mid-execution for
        that thread. If the checkpoint is fresh (< _STUCK_THREAD_THRESHOLD_SECONDS),
        this is a legitimately in-flight request and we must NOT delete. If it is
        old, the prior request crashed without completing and the thread is stuck.
        """
        if not self._checkpointer:
            return
        try:
            ct = await self._checkpointer.aget_tuple(config)  # type: ignore[arg-type]
        except Exception as exc:  # pylint: disable=broad-exception-caught
            logger.warning("[SingleAgentGraph] stuck-thread check failed for %s: %s", thread_id, exc)
            return
        if not ct or not ct.pending_writes:
            return
        ts_str = ct.checkpoint.get("ts", "")
        try:
            ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
            age = (datetime.now(timezone.utc) - ts).total_seconds()
        except (ValueError, TypeError):
            return
        if age > _STUCK_THREAD_THRESHOLD_SECONDS:
            logger.warning(
                "[SingleAgentGraph] thread %s has %d stale pending_writes (age %.0fs) — clearing",
                thread_id,
                len(ct.pending_writes),
                age,
            )
            await self._checkpointer.adelete_thread(thread_id)

    async def _stream_graph(  # pylint: disable=too-many-locals,too-many-arguments,too-many-positional-arguments
        self,
        message: str,
        thread_id: str,
        tools: list[BaseTool | dict],
        langfuse_handler: object,
        trace_metadata: "dict | None" = None,
        _retry: bool = True,
    ) -> AsyncGenerator[str, None]:
        graph = self._build_graph(tools)
        config = self._make_config(thread_id, langfuse_handler, trace_metadata)

        # Clear stuck threads before starting — safe because we check staleness.
        # A 30s threshold separates crashed threads (stale for hours) from
        # legitimate concurrent streams (pending_writes clear within seconds).
        if _retry:
            await self._maybe_clear_stuck_thread(thread_id, config)

        input_tokens = 0
        output_tokens = 0

        try:
            # asyncio.timeout caps total stream duration — a hung LLM or MCP
            # call would otherwise hold the Postgres connection indefinitely.
            async with asyncio.timeout(_STREAM_TIMEOUT_SECONDS):
                # stream_mode="messages" yields (message_chunk, metadata) tuples.
                # LangGraph loads prior turns from the checkpointer automatically.
                async for msg, metadata in graph.astream(
                    {"messages": [HumanMessage(content=message)]},
                    config,
                    stream_mode="messages",
                ):
                    if isinstance(msg, AIMessageChunk):
                        delta = _extract_text_delta(msg.content)
                        if delta:
                            yield format_sse({"type": "text_delta", "delta": delta})
                        # Emit tool_use for each tool call the model is invoking so
                        # the JS widget can render action cards before results arrive.
                        for tc in getattr(msg, "tool_calls", []) or []:
                            if tc.get("name"):
                                yield format_sse(
                                    {
                                        "type": "tool_use",
                                        "tool": tc["name"],
                                        "input": tc.get("args", {}),
                                    }
                                )
                        if hasattr(msg, "usage_metadata") and msg.usage_metadata:
                            usage = msg.usage_metadata
                            input_tokens += usage.get("input_tokens", 0)
                            output_tokens += usage.get("output_tokens", 0)
                    else:
                        # ToolMessage — report tool result
                        tool_name = getattr(msg, "name", "") or metadata.get("name", "")
                        content = getattr(msg, "content", "")
                        if tool_name:
                            yield format_sse({"type": "tool_result", "tool": tool_name, "output": content})

        except TimeoutError:
            logger.error(
                "[SingleAgentGraph] stream timeout after %ds for thread %s",
                _STREAM_TIMEOUT_SECONDS,
                thread_id,
            )
            yield format_sse({"type": "error", "message": "Stream timed out — please try again"})
            return

        except ValueError as exc:
            if "tool_calls that do not have a corresponding ToolMessage" in str(exc) and _retry and self._checkpointer:
                # Corrupt checkpoint: a prior interrupted turn left dangling tool calls.
                # Clear the thread and retry once from a clean state.
                logger.warning(
                    "[SingleAgentGraph] corrupt checkpoint for thread %s — clearing and retrying",
                    thread_id,
                )
                await self._checkpointer.adelete_thread(thread_id)
                async for chunk in self._stream_graph(
                    message, thread_id, tools, langfuse_handler, trace_metadata, _retry=False
                ):
                    yield chunk
                return
            raise

        yield format_sse(
            {
                "type": "message_end",
                "usage": {"inputTokens": input_tokens, "outputTokens": output_tokens},
            }
        )

    async def _invoke_graph(
        self,
        message: str,
        thread_id: str,
        tools: list[BaseTool | dict],
        langfuse_handler: object,
        trace_metadata: "dict | None" = None,
    ) -> str:
        graph = self._build_graph(tools)
        config = self._make_config(thread_id, langfuse_handler, trace_metadata)
        try:
            async with asyncio.timeout(_STREAM_TIMEOUT_SECONDS):
                result = await graph.ainvoke({"messages": [HumanMessage(content=message)]}, config)
        except TimeoutError:
            logger.error(
                "[SingleAgentGraph] invoke timeout after %ds for thread %s",
                _STREAM_TIMEOUT_SECONDS,
                thread_id,
            )
            raise
        for msg in reversed(result.get("messages", [])):
            if isinstance(msg, AIMessage) and msg.content:
                return _extract_text_delta(msg.content)
        return ""
