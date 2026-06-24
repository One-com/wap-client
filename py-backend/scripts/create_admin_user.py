"""
Create an admin user for the WAP admin GUI.

Usage (interactive):
    python scripts/create_admin_user.py pm@group.one "PM Display Name"

Usage (non-interactive, e.g. CI/Docker):
    ADMIN_EMAIL=pm@group.one ADMIN_PASSWORD=secret ADMIN_DISPLAY_NAME="PM Name" \\
        python scripts/create_admin_user.py
"""
import asyncio
import getpass
import os
import sys
import uuid
from datetime import datetime, timezone

# Allow running from py-backend/ directory
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import select

from app.config import get_settings
from app.db.database import create_engine, create_session_factory
from app.db.models import AdminUser
from app.lib.password import hash_password


async def main() -> None:
    email = (sys.argv[1] if len(sys.argv) >= 2 else os.environ.get("ADMIN_EMAIL", "")).strip().lower()
    if not email:
        print("Usage: python scripts/create_admin_user.py <email> [display_name]")
        print("       Or set ADMIN_EMAIL env var.")
        sys.exit(1)

    display_name = sys.argv[2] if len(sys.argv) >= 3 else os.environ.get("ADMIN_DISPLAY_NAME") or None

    password = os.environ.get("ADMIN_PASSWORD", "")
    if not password:
        password = getpass.getpass(f"Password for {email}: ")
    if len(password) < 8:
        print("Error: password must be at least 8 characters.")
        sys.exit(1)

    settings = get_settings()
    engine = create_engine(settings)
    session_factory = create_session_factory(engine)

    async with session_factory() as db_session:
        async with db_session.begin():
            existing = (await db_session.execute(
                select(AdminUser).where(AdminUser.email == email)
            )).scalar_one_or_none()

            if existing:
                print(f"Admin user '{email}' already exists.")
                await engine.dispose()
                sys.exit(0)

            now = datetime.now(timezone.utc)
            user = AdminUser(
                id=uuid.uuid4(),
                email=email,
                hashed_password=hash_password(password),
                display_name=display_name,
                created_at=now,
                updated_at=now,
            )
            db_session.add(user)

    await engine.dispose()
    print(f"Admin user '{email}' created successfully.")


if __name__ == "__main__":
    asyncio.run(main())
