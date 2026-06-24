"""
Unit tests for the SQLAlchemy async engine URL preparation.

Focus: asyncpg does not understand the libpq `?sslmode=` query parameter, so the
URL prep must strip it and translate it into asyncpg's `ssl` connect arg with
semantics matching libpq — `require` encrypts WITHOUT cert verification, only
`verify-*` verifies. config.pg_dsn (psycopg) is left untouched elsewhere.
"""

import ssl

from app.db.database import _prepare_asyncpg_url


def test_scheme_rewritten_to_asyncpg():
    url, connect_args = _prepare_asyncpg_url("postgresql://wap:wap@db.example.com/wap")
    assert url.startswith("postgresql+asyncpg://")
    assert connect_args == {}


def test_postgres_scheme_also_rewritten():
    url, _ = _prepare_asyncpg_url("postgres://wap:wap@db.example.com/wap")
    assert url.startswith("postgresql+asyncpg://")


def test_sslmode_require_encrypts_without_verification():
    # `require` must encrypt but NOT verify the cert (matches libpq), so managed
    # Postgres with a private/self-signed CA connects. asyncpg ssl=True would
    # verify and fail — guard against regressing to that.
    url, connect_args = _prepare_asyncpg_url("postgresql://wap:wap@db.example.com/wap?sslmode=require")
    assert "sslmode" not in url
    ctx = connect_args["ssl"]
    assert isinstance(ctx, ssl.SSLContext)
    assert ctx.check_hostname is False
    assert ctx.verify_mode == ssl.CERT_NONE


def test_verify_full_enables_full_verification():
    url, connect_args = _prepare_asyncpg_url("postgresql+asyncpg://wap:wap@db.example.com/wap?sslmode=verify-full")
    assert "sslmode" not in url
    # verify-full -> asyncpg ssl=True (verifies chain + hostname).
    assert connect_args == {"ssl": True}


def test_verify_ca_verifies_chain_not_hostname():
    url, connect_args = _prepare_asyncpg_url("postgresql://wap:wap@db.example.com/wap?sslmode=verify-ca")
    assert "sslmode" not in url
    ctx = connect_args["ssl"]
    assert isinstance(ctx, ssl.SSLContext)
    assert ctx.check_hostname is False
    assert ctx.verify_mode == ssl.CERT_REQUIRED


def test_sslmode_disable_stripped_without_ssl():
    url, connect_args = _prepare_asyncpg_url("postgresql://wap:wap@db.example.com/wap?sslmode=disable")
    assert "sslmode" not in url
    assert connect_args == {}


def test_no_sslmode_leaves_no_ssl():
    url, connect_args = _prepare_asyncpg_url("postgresql://wap:wap@db.example.com/wap")
    assert "sslmode" not in url
    assert connect_args == {}
