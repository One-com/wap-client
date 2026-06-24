"""
Conversation summarization service.

After each chat turn, SingleAgentGraph calls maybe_summarize().
If the thread has exceeded MESSAGE_THRESHOLD messages, the summarizer
agent condenses prior history and writes a replacement SystemMessage
checkpoint to keep context windows manageable.

The summarizer agent is resolved from global:summarizer in the registry.
If the role is unmapped the service is a no-op.
"""

from __future__ import annotations

import copy
import logging
from typing import TYPE_CHECKING

from langchain_anthropic import ChatAnthropic
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

from app.lib.text import extract_text as _text

if TYPE_CHECKING:
    from psycopg_pool import AsyncConnectionPool

    from app.services.agent_registry import AgentDefinition, AgentRegistry

logger = logging.getLogger(__name__)

# Trigger summarization when the thread holds more than this many messages.
# 20 = ~10 full turns (human+AI each counts as 1).
MESSAGE_THRESHOLD = 20


class ConversationSummarizer:
    """Opportunistically summarizes long conversation threads.

    Designed to be called after each streaming turn — it is a no-op when the
    thread is within the threshold or when global:summarizer is unmapped.

    Accepts the shared AsyncConnectionPool rather than a pre-built checkpointer so
    that each maybe_summarize() call creates its own AsyncPostgresSaver instance
    with its own asyncio.Lock.  This avoids a race between the background summarize
    task and the per-request checkpointer that just finished writing the turn.
    """

    def __init__(
        self,
        registry: "AgentRegistry",
        api_key: str,
        pg_pool: "AsyncConnectionPool",
        message_threshold: int = MESSAGE_THRESHOLD,
    ) -> None:
        self._registry = registry
        self._api_key = api_key
        self._pg_pool = pg_pool
        self._message_threshold = message_threshold

    async def maybe_summarize(self, thread_id: str) -> bool:
        """Summarize the thread if it exceeds the message threshold.

        Returns True if summarization was performed, False otherwise.
        """
        summarizer_def = self._registry.get_summarizer()
        if summarizer_def is None:
            return False

        # Fresh instance per call: its own asyncio.Lock avoids contention with
        # the per-request checkpointer that just completed the stream.
        checkpointer = AsyncPostgresSaver(self._pg_pool)  # type: ignore[arg-type]

        config = {"configurable": {"thread_id": thread_id}}
        checkpoint_tuple = await checkpointer.aget_tuple(config)  # type: ignore[arg-type]
        if checkpoint_tuple is None:
            return False

        messages = checkpoint_tuple.checkpoint.get("channel_values", {}).get("messages", [])
        if len(messages) <= self._message_threshold:
            return False

        # Build a summary over the existing messages
        try:
            summary = await self._generate_summary(messages, summarizer_def)
        except Exception as exc:  # pylint: disable=broad-exception-caught
            logger.warning("[ConversationSummarizer] summarization failed for %s: %s", thread_id, exc)
            return False

        # Replace history with: [SystemMessage(summary)] + last 2 messages
        # Keeping the last human+AI pair gives the model immediate context.
        tail = messages[-2:] if len(messages) >= 2 else messages
        new_messages = [SystemMessage(content=summary)] + tail

        # Write a new checkpoint with the compressed message list.
        # Deep-copy so that other channel values (channel_versions, pending_sends, etc.)
        # are not shared references between the old and new checkpoint objects.
        new_checkpoint = copy.deepcopy(checkpoint_tuple.checkpoint)
        new_checkpoint["channel_values"]["messages"] = new_messages

        await checkpointer.aput(
            config,  # type: ignore[arg-type]
            new_checkpoint,
            checkpoint_tuple.metadata or {},
            new_checkpoint.get("channel_versions", {}),
        )

        logger.info(
            "[ConversationSummarizer] summarized thread %s: %d → %d messages",
            thread_id,
            len(messages),
            len(new_messages),
        )
        return True

    async def _generate_summary(self, messages: list, summarizer_def: "AgentDefinition") -> str:
        """Call the summarizer LLM to produce a compact summary."""
        model = ChatAnthropic(  # type: ignore[call-arg]
            model=summarizer_def.model,
            temperature=summarizer_def.temperature,
            api_key=self._api_key,  # type: ignore[arg-type]
        )

        # Render conversation for summarization
        lines: list[str] = []
        for msg in messages:
            if isinstance(msg, HumanMessage):
                lines.append(f"User: {_text(msg.content)}")
            elif isinstance(msg, AIMessage):
                lines.append(f"Assistant: {_text(msg.content)}")
            elif isinstance(msg, SystemMessage):
                lines.append(f"[system: {_text(msg.content)}]")
            # ToolMessage deliberately omitted — raw tool output not useful in summary

        conversation_text = "\n".join(lines)
        prompt = f"{summarizer_def.system_prompt}\n\nConversation to summarize:\n\n{conversation_text}"

        result = await model.ainvoke([HumanMessage(content=prompt)])
        return _text(result.content)
