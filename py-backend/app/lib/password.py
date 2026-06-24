"""Password hashing utilities using bcrypt directly."""

import bcrypt

# Used for constant-time comparison when user is not found (prevents timing attacks).
_DUMMY_HASH: str = bcrypt.hashpw(b"dummy-constant-time-placeholder", bcrypt.gensalt()).decode()


def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode(), bcrypt.gensalt()).decode()


def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode(), hashed.encode())
