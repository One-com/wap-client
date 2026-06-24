"""
Unit tests for observability wiring.

Focus: LangFuse v3+ configures host/keys on the Langfuse() client, not on the
CallbackHandler. Guard against regressing to passing only public_key (which
silently dropped LANGFUSE_BASE_URL).
"""

import sys
import types
from types import SimpleNamespace

import pytest


def _install_fake_langfuse(captured: dict) -> None:
    lf_mod = types.ModuleType("langfuse")

    class FakeLangfuse:
        def __init__(self, **kwargs):
            captured["langfuse_kwargs"] = kwargs

    lf_mod.Langfuse = FakeLangfuse
    lf_mod.get_client = lambda: None

    lc_mod = types.ModuleType("langfuse.langchain")

    class FakeCallbackHandler:
        def __init__(self, *args, **kwargs):
            captured["cb_args"] = args
            captured["cb_kwargs"] = kwargs

    lc_mod.CallbackHandler = FakeCallbackHandler

    sys.modules["langfuse"] = lf_mod
    sys.modules["langfuse.langchain"] = lc_mod


@pytest.fixture
def fake_langfuse(monkeypatch):
    captured: dict = {}
    saved = {k: sys.modules.get(k) for k in ("langfuse", "langfuse.langchain")}
    _install_fake_langfuse(captured)
    yield captured
    for k, v in saved.items():
        if v is None:
            sys.modules.pop(k, None)
        else:
            sys.modules[k] = v


def test_base_url_and_keys_wired_into_client(fake_langfuse):
    from app.lib.observability import create_langfuse_handler

    settings = SimpleNamespace(
        LANGFUSE_PUBLIC_KEY="pk-test",
        LANGFUSE_SECRET_KEY="sk-test",
        LANGFUSE_BASE_URL="https://langfuse-prod.default.k8spod4-cph3.ingress.k8s.g1i.one",
    )
    handler = create_langfuse_handler(settings)

    assert handler is not None
    kwargs = fake_langfuse["langfuse_kwargs"]
    assert kwargs["host"] == settings.LANGFUSE_BASE_URL
    assert kwargs["public_key"] == "pk-test"
    assert kwargs["secret_key"] == "sk-test"
    # CallbackHandler binds to the configured client — no per-handler creds.
    assert fake_langfuse["cb_args"] == ()
    assert fake_langfuse["cb_kwargs"] == {}


def test_disabled_when_keys_missing(fake_langfuse):
    from app.lib.observability import create_langfuse_handler

    settings = SimpleNamespace(
        LANGFUSE_PUBLIC_KEY=None,
        LANGFUSE_SECRET_KEY=None,
        LANGFUSE_BASE_URL="https://langfuse-prod.default.k8spod4-cph3.ingress.k8s.g1i.one",
    )
    assert create_langfuse_handler(settings) is None
    assert "langfuse_kwargs" not in fake_langfuse
