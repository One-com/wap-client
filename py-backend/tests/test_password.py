"""Unit tests for app/lib/password.py — bcrypt hash/verify utilities."""

from app.lib.password import _DUMMY_HASH, hash_password, verify_password


def test_hash_password_returns_bcrypt_string():
    result = hash_password("mysecret")
    assert result.startswith("$2b$")


def test_hash_password_is_random_each_call():
    h1 = hash_password("mysecret")
    h2 = hash_password("mysecret")
    assert h1 != h2


def test_verify_password_correct():
    hashed = hash_password("correct-password")
    assert verify_password("correct-password", hashed) is True


def test_verify_password_wrong():
    hashed = hash_password("correct-password")
    assert verify_password("wrong-password", hashed) is False


def test_dummy_hash_does_not_verify():
    assert verify_password("anything", _DUMMY_HASH) is False


def test_dummy_hash_is_valid_bcrypt():
    assert _DUMMY_HASH.startswith("$2b$")
