"""
Unit tests for AES-256-GCM encryption.
"""

import base64 as _b64

import pytest

from app.lib.encryption import decrypt, encrypt

KEY = _b64.b64encode(b"\xaa" * 32).decode()  # valid 32-byte base64 key for tests


def test_encrypt_decrypt_roundtrip():
    plaintext = "my-secret-app-password"
    ciphertext = encrypt(plaintext, KEY)
    assert ciphertext != plaintext
    recovered = decrypt(ciphertext, KEY)
    assert recovered == plaintext


def test_encrypt_is_non_deterministic():
    # Each encryption produces a unique ciphertext (different IV)
    a = encrypt("same", KEY)
    b = encrypt("same", KEY)
    assert a != b


def test_decrypt_wrong_key_raises():
    ciphertext = encrypt("secret", KEY)
    wrong_key = "b" * 64
    with pytest.raises(Exception):
        decrypt(ciphertext, wrong_key)


def test_encrypt_empty_string():
    ct = encrypt("", KEY)
    assert decrypt(ct, KEY) == ""


def test_encrypt_unicode():
    plaintext = "motdepasse_éàü_🔑"
    ct = encrypt(plaintext, KEY)
    assert decrypt(ct, KEY) == plaintext
