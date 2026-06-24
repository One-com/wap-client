"""
Unit tests for app/services/summarizer.py
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

from app.services.summarizer import MESSAGE_THRESHOLD, ConversationSummarizer, _text

# ── _text helper ──────────────────────────────────────────────────────────────


def test_text_str():
    assert _text("hello") == "hello"


def test_text_list_of_blocks():
    blocks = [{"type": "text", "text": "hello"}, {"type": "tool_use", "text": "ignored"}]
    assert _text(blocks) == "hello"


def test_text_empty_list():
    assert _text([]) == ""


# ── ConversationSummarizer ────────────────────────────────────────────────────


def _make_summarizer(registry, checkpointer):
    """Build a ConversationSummarizer whose maybe_summarize uses a mock checkpointer.

    ConversationSummarizer now accepts a pg_pool and creates its own
    AsyncPostgresSaver per call.  We pass a mock pool and patch
    AsyncPostgresSaver so the mock checkpointer is injected instead.
    """
    mock_pool = MagicMock()
    summarizer = ConversationSummarizer(registry, "sk-ant-test", mock_pool)
    # Attach the mock checkpointer so tests can patch AsyncPostgresSaver to return it.
    summarizer._mock_checkpointer = checkpointer
    return summarizer


def _make_registry(has_summarizer: bool):
    registry = MagicMock()
    if has_summarizer:
        agent = MagicMock()
        agent.model = "claude-haiku-4-5-20251001"
        agent.temperature = 0.2
        agent.system_prompt = "Summarize this conversation concisely."
        registry.get_summarizer.return_value = agent
    else:
        registry.get_summarizer.return_value = None
    return registry


def _make_checkpointer(messages: list | None):
    checkpointer = MagicMock()
    if messages is None:
        checkpointer.aget_tuple = AsyncMock(return_value=None)
    else:
        checkpoint_tuple = MagicMock()
        checkpoint_tuple.checkpoint = {"channel_values": {"messages": messages}, "channel_versions": {}}
        checkpoint_tuple.metadata = {}
        checkpointer.aget_tuple = AsyncMock(return_value=checkpoint_tuple)
        checkpointer.aput = AsyncMock()
    return checkpointer


def _patch_checkpointer(summarizer):
    """Context manager that patches AsyncPostgresSaver to return summarizer._mock_checkpointer."""
    return patch(
        "app.services.summarizer.AsyncPostgresSaver",
        return_value=summarizer._mock_checkpointer,
    )


@pytest.mark.asyncio
async def test_no_op_when_no_summarizer():
    registry = _make_registry(has_summarizer=False)
    checkpointer = _make_checkpointer(None)
    summarizer = _make_summarizer(registry, checkpointer)
    with _patch_checkpointer(summarizer):
        result = await summarizer.maybe_summarize("user1:wp-rocket:standard")
    assert result is False
    checkpointer.aget_tuple.assert_not_called()


@pytest.mark.asyncio
async def test_no_op_when_no_checkpoint():
    registry = _make_registry(has_summarizer=True)
    checkpointer = _make_checkpointer(None)
    summarizer = _make_summarizer(registry, checkpointer)
    with _patch_checkpointer(summarizer):
        result = await summarizer.maybe_summarize("user1:wp-rocket:standard")
    assert result is False


@pytest.mark.asyncio
async def test_no_op_when_below_threshold():
    registry = _make_registry(has_summarizer=True)
    messages = [HumanMessage(content="Hi"), AIMessage(content="Hello")] * 5  # 10 messages
    checkpointer = _make_checkpointer(messages)
    summarizer = _make_summarizer(registry, checkpointer)
    with _patch_checkpointer(summarizer):
        result = await summarizer.maybe_summarize("user1:wp-rocket:standard")
    assert result is False
    checkpointer.aput.assert_not_called()


@pytest.mark.asyncio
async def test_summarizes_when_above_threshold():
    registry = _make_registry(has_summarizer=True)
    # Build a message list above threshold
    messages = [HumanMessage(content=f"msg{i}") for i in range(MESSAGE_THRESHOLD + 5)]
    checkpointer = _make_checkpointer(messages)
    summarizer = _make_summarizer(registry, checkpointer)

    mock_summary = "This is a compact summary of the conversation."

    with _patch_checkpointer(summarizer):
        with patch.object(summarizer, "_generate_summary", new=AsyncMock(return_value=mock_summary)):
            result = await summarizer.maybe_summarize("user1:wp-rocket:standard")

    assert result is True
    checkpointer.aput.assert_called_once()
    # Verify the new checkpoint contains a SystemMessage with the summary
    call_args = checkpointer.aput.call_args
    new_checkpoint = call_args[0][1]
    new_messages = new_checkpoint["channel_values"]["messages"]
    assert isinstance(new_messages[0], SystemMessage)
    assert new_messages[0].content == mock_summary
    # Original tail (last 2) is preserved
    assert len(new_messages) == 3  # 1 SystemMessage + 2 tail


@pytest.mark.asyncio
async def test_returns_false_on_summarization_error():
    registry = _make_registry(has_summarizer=True)
    messages = [HumanMessage(content=f"msg{i}") for i in range(MESSAGE_THRESHOLD + 1)]
    checkpointer = _make_checkpointer(messages)
    summarizer = _make_summarizer(registry, checkpointer)

    with _patch_checkpointer(summarizer):
        with patch.object(summarizer, "_generate_summary", new=AsyncMock(side_effect=Exception("LLM error"))):
            result = await summarizer.maybe_summarize("user1:wp-rocket:standard")

    assert result is False
    checkpointer.aput.assert_not_called()


# ── Configurable threshold (WPIN-8556) ─────────────────────────────────────────


def _make_summarizer_with_threshold(registry, checkpointer, threshold):
    mock_pool = MagicMock()
    summarizer = ConversationSummarizer(registry, "sk-ant-test", mock_pool, message_threshold=threshold)
    summarizer._mock_checkpointer = checkpointer
    return summarizer


@pytest.mark.asyncio
async def test_custom_threshold_triggers_earlier():
    """A small configured threshold makes summarization fire below the module default."""
    registry = _make_registry(has_summarizer=True)
    messages = [HumanMessage(content=f"msg{i}") for i in range(4)]  # 4 > threshold 3
    checkpointer = _make_checkpointer(messages)
    summarizer = _make_summarizer_with_threshold(registry, checkpointer, threshold=3)

    with _patch_checkpointer(summarizer):
        with patch.object(summarizer, "_generate_summary", new=AsyncMock(return_value="summary")):
            result = await summarizer.maybe_summarize("user1:wp-rocket:standard")

    assert result is True
    checkpointer.aput.assert_called_once()


@pytest.mark.asyncio
async def test_custom_threshold_no_op_at_or_below():
    registry = _make_registry(has_summarizer=True)
    messages = [HumanMessage(content=f"msg{i}") for i in range(3)]  # 3 == threshold 3 → no-op
    checkpointer = _make_checkpointer(messages)
    summarizer = _make_summarizer_with_threshold(registry, checkpointer, threshold=3)

    with _patch_checkpointer(summarizer):
        result = await summarizer.maybe_summarize("user1:wp-rocket:standard")

    assert result is False
    checkpointer.aput.assert_not_called()
