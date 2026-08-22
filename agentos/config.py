"""
AgentOS configuration.

Environment-driven settings with safe defaults. All paths are relative to
the AgentOS data directory so the whole system is portable.
"""
import hashlib
import hmac as _hmac
import json
import secrets
from pathlib import Path
from typing import Optional

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Config(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="AGENTOS_", extra="ignore")

    data_dir: str = ""
    port: int = 3000
    host: str = "0.0.0.0"
    public_url: str = ""
    secret: str = ""
    operator_token: str = ""
    anthropic_api_key: Optional[str] = None
    deepseek_api_key: Optional[str] = None
    deepseek_base_url: str = "https://api.deepseek.com"
    local_runner: str = "1"  # set "0" to disable
    push_subject: str = "mailto:operator@agentos.local"

    # Derived — set by model_validator
    db_path: str = ""
    blob_dir: str = ""
    work_dir: str = ""
    vapid_public_key: str = ""
    vapid_private_key: str = ""
    vapid_subject: str = ""

    @model_validator(mode="after")
    def _bootstrap(self) -> "Config":
        if not self.data_dir:
            self.data_dir = str(Path.cwd() / "data")

        data = Path(self.data_dir)
        data.mkdir(parents=True, exist_ok=True)
        (data / "blobs").mkdir(exist_ok=True)
        (data / "work").mkdir(exist_ok=True)

        self.db_path = str(data / "agentos.db")
        self.blob_dir = str(data / "blobs")
        self.work_dir = str(data / "work")

        if not self.secret:
            self.secret = _must_secret(data, "hmac")
        if not self.operator_token:
            self.operator_token = _must_secret(data, "operator-token")
        if not self.public_url:
            self.public_url = f"http://127.0.0.1:{self.port}"

        # VAPID keys for Web Push — generated once, persisted so subscriptions survive restarts.
        vapid_path = data / "vapid.json"
        if vapid_path.exists():
            v = json.loads(vapid_path.read_text())
        else:
            from cryptography.hazmat.primitives.asymmetric import ec
            from cryptography.hazmat.backends import default_backend
            import base64

            key = ec.generate_private_key(ec.SECP256R1(), default_backend())
            pub = key.public_key()
            priv_bytes = key.private_bytes(
                encoding=__import__("cryptography").hazmat.primitives.serialization.Encoding.Raw,
                format=__import__("cryptography").hazmat.primitives.serialization.PrivateFormat.Raw,
                encryption_algorithm=__import__("cryptography").hazmat.primitives.serialization.NoEncryption(),
            )
            pub_bytes = pub.public_bytes(
                encoding=__import__("cryptography").hazmat.primitives.serialization.Encoding.X962,
                format=__import__("cryptography").hazmat.primitives.serialization.PublicFormat.UncompressedPoint,
            )
            v = {
                "subject": self.push_subject,
                "publicKey": base64.urlsafe_b64encode(pub_bytes).rstrip(b"=").decode(),
                "privateKey": base64.urlsafe_b64encode(priv_bytes).rstrip(b"=").decode(),
            }
            vapid_path.write_text(json.dumps(v))
            vapid_path.chmod(0o600)

        self.vapid_public_key = v["publicKey"]
        self.vapid_private_key = v["privateKey"]
        self.vapid_subject = v.get("subject", self.push_subject)
        return self

    @property
    def local_runner_enabled(self) -> bool:
        return self.local_runner != "0"

    @property
    def vapid(self) -> dict:
        return {
            "subject": self.vapid_subject,
            "publicKey": self.vapid_public_key,
            "privateKey": self.vapid_private_key,
        }


def _must_secret(data_dir: Path, name: str, nbytes: int = 36) -> str:
    p = data_dir / f"{name}.key"
    if p.exists():
        return p.read_text().strip()
    val = secrets.token_urlsafe(nbytes)
    p.write_text(val)
    p.chmod(0o600)
    return val


def sha256hex(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def hmac_hex(secret: str, payload: str) -> str:
    return _hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()


def safe_equal(a: str, b: str) -> bool:
    """Constant-time comparison to prevent timing attacks."""
    ha = hashlib.sha256(a.encode()).digest()
    hb = hashlib.sha256(b.encode()).digest()
    return secrets.compare_digest(ha, hb)


_config: Optional[Config] = None


def load_config() -> Config:
    global _config
    if _config is None:
        _config = Config()
    return _config
