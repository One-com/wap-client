"""
AES-256-GCM encryption helpers.

Wire format (base64-encoded): [IV 12 bytes][authTag 16 bytes][ciphertext N bytes]

This is identical to the Node.js implementation in src/lib/encryption.ts so
credentials written by either backend are cross-readable from the same Postgres row.

Key: base64-encoded 32-byte value from SESSION_ENCRYPTION_KEY env var.
"""

import base64
import os

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms
from cryptography.hazmat.primitives.ciphers.modes import GCM

_IV_LENGTH = 12
_TAG_LENGTH = 16


def encrypt(plaintext: str, key_b64: str) -> str:
    """Encrypt *plaintext* and return a base64-encoded ciphertext blob."""
    key = base64.b64decode(key_b64)
    iv = os.urandom(_IV_LENGTH)
    cipher = Cipher(algorithms.AES(key), GCM(iv))
    enc = cipher.encryptor()
    ciphertext = enc.update(plaintext.encode("utf-8")) + enc.finalize()
    auth_tag = enc.tag  # 16 bytes appended by GCM
    combined = iv + auth_tag + ciphertext
    return base64.b64encode(combined).decode("utf-8")


def decrypt(ciphertext_b64: str, key_b64: str) -> str:
    """Decrypt a base64-encoded ciphertext blob and return the plaintext."""
    key = base64.b64decode(key_b64)
    buf = base64.b64decode(ciphertext_b64)
    iv = buf[:_IV_LENGTH]
    auth_tag = buf[_IV_LENGTH : _IV_LENGTH + _TAG_LENGTH]
    ciphertext = buf[_IV_LENGTH + _TAG_LENGTH :]
    cipher = Cipher(algorithms.AES(key), GCM(iv, auth_tag))
    dec = cipher.decryptor()
    return (dec.update(ciphertext) + dec.finalize()).decode("utf-8")
